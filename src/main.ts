import { Editor, MarkdownView, Notice, Plugin, TAbstractFile, TFile, normalizePath } from 'obsidian';
import {
	DEFAULT_TODOIST_TOKEN_SECRET_NAME,
	DEFAULT_SETTINGS,
	DEFAULT_PROP_NAMES,
	type TaskTodoistSettings,
} from './settings';
import { TaskTodoistSettingTab } from './settings-tab';
import { TodoistClient, type TodoistProjectSectionLookup } from './todoist-client';
import { SyncService } from './sync-service';
import { CreateTaskModal } from './create-task-modal';
import { createLocalTaskNote, type LocalTaskNoteInput } from './task-note-factory';
import { registerInlineTaskConverter } from './inline-task-converter';
import { createTaskConvertOverlayExtension } from './editor-task-convert-overlay';
import { formatDueForDisplay, parseInlineTaskDirectives } from './task-directives';
import { applyStandardTaskFrontmatter, getPropNames, setTaskStatus, touchModifiedDate } from './task-frontmatter';
import { resolveTemplateVars } from './template-variables';

export default class TaskTodoistPlugin extends Plugin {
	settings: TaskTodoistSettings;
	private todoistApiToken: string | null = null;
	private lastConnectionCheckMessage = 'No check run yet.';
	private lastSyncMessage = 'No sync run yet.';
	private readonly recentTaskMetaByLink = new Map<string, {
		projectName?: string;
		sectionName?: string;
		dueDate?: string;
		dueString?: string;
		isRecurring?: boolean;
	}>();
	private scheduledSyncIntervalId: number | null = null;
	private syncInProgress = false;
	private syncQueued = false;
	private lookupCache: { expiresAt: number; value: TodoistProjectSectionLookup } | null = null;
	private static readonly UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadTodoistApiToken();
		this.addSettingTab(new TaskTodoistSettingTab(this.app, this));
		this.registerCommands();
		this.registerVaultTaskDirtyTracking();
		registerInlineTaskConverter(this);
		this.registerEditorExtension(createTaskConvertOverlayExtension(this));
		this.configureScheduledSync();
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Partial<TaskTodoistSettings> | null;
		const raw = loaded ?? {};
		this.settings = {
			...DEFAULT_SETTINGS,
			...raw,
			// Deep merge propNames so partial saved configs inherit defaults for new keys
			propNames: { ...DEFAULT_PROP_NAMES, ...(raw.propNames ?? {}) },
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isSecretStorageAvailable(): boolean {
		return Boolean(this.app.secretStorage);
	}

	getTodoistApiToken(): string | null {
		return this.todoistApiToken;
	}

	getLastConnectionCheckMessage(): string {
		return this.lastConnectionCheckMessage;
	}

	getLastSyncMessage(): string {
		return this.lastSyncMessage;
	}

	async getTodoistProjectSectionLookup(forceRefresh = false): Promise<TodoistProjectSectionLookup> {
		const now = Date.now();
		if (!forceRefresh && this.lookupCache && this.lookupCache.expiresAt > now) {
			return this.lookupCache.value;
		}

		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			return { projects: [], sections: [] };
		}

		const client = new TodoistClient(token);
		const value = await client.fetchProjectSectionLookup();
		this.lookupCache = {
			expiresAt: now + (5 * 60 * 1000),
			value,
		};
		return value;
	}

	async testTodoistConnection(): Promise<{ ok: boolean; message: string }> {
		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;

		if (!token) {
			const result = {
				ok: false,
				message: 'No todoist API token is configured.',
			};
			this.setLastConnectionCheck(result.message);
			return result;
		}

		try {
			const client = new TodoistClient(token);
			const result = await client.testConnection();
			this.setLastConnectionCheck(result.message);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const result = {
				ok: false,
				message: `Todoist connection check failed: ${message}`,
			};
			this.setLastConnectionCheck(result.message);
			return result;
		}
	}

	async runImportSync(): Promise<{ ok: boolean; message: string }> {
		if (this.syncInProgress) {
			this.syncQueued = true;
			return { ok: false, message: 'Sync already running. Queued another run.' };
		}

		this.syncInProgress = true;
		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			const result = { ok: false, message: 'No todoist API token is configured.' };
			this.setLastSync(result.message);
			this.finishSyncRun();
			return result;
		}

		try {
			const service = new SyncService(this.app, this.settings, token);
			const result = await service.runImportSync();
			this.setLastSync(result.message);
			return result;
		} finally {
			this.finishSyncRun();
		}
	}

	async createTaskNote(input: LocalTaskNoteInput) {
		const created = await createLocalTaskNote(this.app, this.settings, input);
		const linkTarget = created.path.replace(/\.md$/i, '');
		this.recentTaskMetaByLink.set(linkTarget, {
			projectName: input.todoistProjectName?.trim() || undefined,
			sectionName: input.todoistSectionName?.trim() || undefined,
			dueDate: input.todoistDueDate?.trim() || undefined,
			dueString: input.todoistDueString?.trim() || undefined,
			isRecurring: Boolean(input.todoistDueString?.trim()),
		});
		if (this.settings.autoOpenNewNote) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(created);
		}
		return created;
	}

	openCreateTaskModal(initialTitle = ''): void {
		new CreateTaskModal(this.app, this, initialTitle).open();
	}

	async convertEditorChecklistLineToTaskNote(editor: Editor): Promise<{ ok: boolean; message: string }> {
		const lineNumber = editor.getCursor().line;
		return this.convertChecklistLineByEditorLine(editor, lineNumber);
	}

	async convertChecklistLineInActiveEditor(lineNumberOneBased: number, expectedTitle?: string): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) {
			new Notice('No active Markdown editor found.', 5000);
			return;
		}

		const zeroBasedLine = Math.max(0, lineNumberOneBased - 1);
		const line = editor.getLine(zeroBasedLine);
		const match = line.match(TaskTodoistPlugin.UNCHECKED_TASK_LINE_REGEX);
		if (!match) {
			return;
		}

		const title = normalizeTaskText(match[2] ?? '');
		if (!title || (expectedTitle && normalizeTaskText(expectedTitle) !== title)) {
			return;
		}

		const result = await this.convertChecklistLineByEditorLine(editor, zeroBasedLine);
		const prefix = result.ok ? 'Success:' : 'Failed:';
		new Notice(`${prefix} ${result.message}`, 5000);
	}


	private async convertChecklistLineByEditorLine(editor: Editor, lineNumber: number): Promise<{ ok: boolean; message: string }> {
		const line = editor.getLine(lineNumber);
		const match = line.match(TaskTodoistPlugin.UNCHECKED_TASK_LINE_REGEX);
		if (!match) {
			return {
				ok: false,
				message: 'Current line is not an unchecked checklist task.',
			};
		}

		const parsed = parseInlineTaskDirectives(normalizeTaskText(match[2] ?? ''));
		if (!parsed.title) {
			return {
				ok: false,
				message: 'Task title is empty.',
			};
		}

		const created = await this.createTaskNote({
			title: parsed.title,
			description: '',
			todoistSync: true,
			todoistProjectName: parsed.projectName,
			todoistSectionName: parsed.sectionName,
			todoistDueDate: parsed.dueRaw,
			todoistDueString: parsed.recurrenceRaw,
		});
		const linkTarget = created.path.replace(/\.md$/i, '');
		editor.setLine(lineNumber, `${match[1]}[[${linkTarget}|${parsed.title}]]`);
		return {
			ok: true,
			message: `Converted task to note: ${created.basename}`,
		};
	}

	async updateLinkedTaskNoteStatusByLink(linkTarget: string, isDone: boolean): Promise<void> {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (!taskFile) {
			return;
		}

		const p = getPropNames(this.settings);
		await this.app.fileManager.processFrontMatter(taskFile, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data, this.settings);
			setTaskStatus(data, isDone ? 'done' : 'open', this.settings);
			data[p.localUpdatedAt] = new Date().toISOString();
			const todoistId = typeof data[p.todoistId] === 'string' ? (data[p.todoistId] as string) : '';
			if (todoistId.trim()) {
				data[p.todoistSyncStatus] = 'dirty_local';
				// Clean up legacy key if present
				if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
					delete data.sync_status;
				}
			}
		});
	}

	getLinkedTaskMetaSummary(linkTarget: string): string {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';
		const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
		if (taskFile) {
			const frontmatter = this.app.metadataCache.getFileCache(taskFile)?.frontmatter as Record<string, unknown> | undefined;
			if (frontmatter) {
				const p = getPropNames(this.settings);
				const projectName = typeof frontmatter[p.todoistProjectName] === 'string' ? (frontmatter[p.todoistProjectName] as string).trim() : '';
				const sectionName = typeof frontmatter[p.todoistSectionName] === 'string' ? (frontmatter[p.todoistSectionName] as string).trim() : '';
				const dueString = typeof frontmatter[p.todoistDueString] === 'string' ? (frontmatter[p.todoistDueString] as string).trim() : '';
				const dueDate = typeof frontmatter[p.todoistDue] === 'string' ? (frontmatter[p.todoistDue] as string).trim() : '';
				const isRecurring = frontmatter[p.todoistIsRecurring] === true || frontmatter[p.todoistIsRecurring] === 'true';
				const summary = buildMetaSummary(projectName, sectionName, dueDate, dueString, isRecurring);
				if (summary) {
					this.recentTaskMetaByLink.delete(linkTarget);
					return summary;
				}
			}
		}

		const recent = this.recentTaskMetaByLink.get(linkTarget);
		if (recent) {
			return buildMetaSummary(
				recent.projectName,
				recent.sectionName,
				recent.dueDate,
				recent.dueString,
				recent.isRecurring,
			);
		}

		return '';
	}

	async updateTodoistTokenSecretName(secretName: string): Promise<void> {
		const normalizedName = secretName.trim() || DEFAULT_TODOIST_TOKEN_SECRET_NAME;
		this.settings.todoistTokenSecretName = normalizedName;
		await this.saveSettings();
		await this.loadTodoistApiToken();
	}

	async updateAutoSyncEnabled(enabled: boolean): Promise<void> {
		this.settings.autoSyncEnabled = enabled;
		await this.saveSettings();
		this.configureScheduledSync();
	}

	async updateAutoSyncIntervalMinutes(minutes: number): Promise<void> {
		const normalized = normalizeSyncInterval(minutes);
		this.settings.autoSyncIntervalMinutes = normalized;
		await this.saveSettings();
		this.configureScheduledSync();
	}

	private async loadTodoistApiToken(): Promise<void> {
		const secretName = this.settings.todoistTokenSecretName.trim();
		if (!secretName) {
			this.todoistApiToken = null;
			return;
		}

		const token = this.app.secretStorage.getSecret(secretName);
		this.todoistApiToken = token?.trim() || null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'test-todoist-connection',
			name: 'Test todoist connection',
			callback: async () => {
				const result = await this.testTodoistConnection();
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 6000);
			},
		});
		this.addCommand({
			id: 'sync-todoist-now',
			name: 'Sync todoist now',
			callback: async () => {
				const result = await this.runImportSync();
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 8000);
			},
		});
		this.addCommand({
			id: 'create-task-note',
			name: 'Create task note',
			callback: () => {
				this.openCreateTaskModal();
			},
		});
		this.addCommand({
			id: 'convert-checklist-item-to-task-note',
			name: 'Convert checklist item to task note',
			editorCallback: async (editor) => {
				const result = await this.convertEditorChecklistLineToTaskNote(editor);
				const prefix = result.ok ? 'Success:' : 'Failed:';
				new Notice(`${prefix} ${result.message}`, 6000);
			},
		});
	}

	private setLastConnectionCheck(message: string): void {
		const checkedAt = new Date().toLocaleString();
		this.lastConnectionCheckMessage = `${message} (${checkedAt})`;
	}

	private setLastSync(message: string): void {
		const syncedAt = new Date().toLocaleString();
		this.lastSyncMessage = `${message} (${syncedAt})`;
	}

	private configureScheduledSync(): void {
		if (this.scheduledSyncIntervalId !== null) {
			window.clearInterval(this.scheduledSyncIntervalId);
			this.scheduledSyncIntervalId = null;
		}

		if (!this.settings.autoSyncEnabled) {
			return;
		}

		const intervalMs = normalizeSyncInterval(this.settings.autoSyncIntervalMinutes) * 60 * 1000;
		this.scheduledSyncIntervalId = window.setInterval(() => {
			void this.runScheduledSync();
		}, intervalMs);
		this.registerInterval(this.scheduledSyncIntervalId);
	}

	private async runScheduledSync(): Promise<void> {
		const result = await this.runImportSync();
		if (result.message.startsWith('Sync already running')) {
			return;
		}

		if (this.settings.showScheduledSyncNotices) {
			const prefix = result.ok ? 'Scheduled sync:' : 'Scheduled sync failed:';
			new Notice(`${prefix} ${result.message}`, result.ok ? 3500 : 5000);
			return;
		}

		if (!result.ok) {
			new Notice(`Scheduled sync failed: ${result.message}`, 5000);
		}
	}

	private finishSyncRun(): void {
		this.syncInProgress = false;
		if (this.syncQueued) {
			this.syncQueued = false;
			void this.runImportSync();
		}
	}

	private registerVaultTaskDirtyTracking(): void {
		this.registerEvent(this.app.vault.on('modify', (file) => {
			void this.onVaultFileModified(file);
		}));
	}

	private async onVaultFileModified(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return;
		}
		if (this.syncInProgress) {
			return;
		}
		if (!this.isTaskFilePath(file.path)) {
			return;
		}

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) {
			return;
		}

		const p = getPropNames(this.settings);
		const todoistSync = frontmatter[p.todoistSync];
		const todoistId = typeof frontmatter[p.todoistId] === 'string' ? (frontmatter[p.todoistId] as string).trim() : '';
		if (!(todoistSync === true || todoistSync === 'true') || !todoistId) {
			return;
		}

		const currentStatus =
			typeof frontmatter[p.todoistSyncStatus] === 'string'
				? frontmatter[p.todoistSyncStatus] as string
				: (typeof frontmatter.sync_status === 'string' ? frontmatter.sync_status : '');
		if (currentStatus === 'dirty_local' || currentStatus === 'queued_local_create') {
			return;
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatterToMutate) => {
			const data = frontmatterToMutate as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data, this.settings);
			data[p.todoistSyncStatus] = 'dirty_local';
			data[p.localUpdatedAt] = new Date().toISOString();
			if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
				delete data.sync_status;
			}
		});
	}

	private isTaskFilePath(path: string): boolean {
		const taskFolder = normalizePath(resolveTemplateVars(this.settings.tasksFolderPath));
		const taskPrefix = `${taskFolder}/`;
		return path === taskFolder || path.startsWith(taskPrefix);
	}
}

function normalizeTaskText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function normalizeSyncInterval(value: number): number {
	if (!Number.isFinite(value)) {
		return 5;
	}
	return Math.min(120, Math.max(1, Math.round(value)));
}

function buildMetaSummary(
	projectName?: string,
	sectionName?: string,
	dueDate?: string,
	dueString?: string,
	isRecurring = false,
): string {
	const parts: string[] = [];
	if (projectName) {
		parts.push(`📁 ${projectName}`);
	}
	if (sectionName) {
		parts.push(`🧭 ${sectionName}`);
	}
	if (isRecurring) {
		parts.push(`🔁 ${dueString || 'recurring'}`);
		if (dueDate) {
			parts.push(`📅 ${formatDueForDisplay(dueDate)}`);
		}
	} else {
		const dueRaw = dueString || dueDate;
		if (dueRaw) {
			parts.push(`📅 ${formatDueForDisplay(dueRaw)}`);
		}
	}
	return parts.join(' • ');
}
