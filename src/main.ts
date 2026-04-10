import { Editor, MarkdownView, Plugin, TAbstractFile, TFile, normalizePath } from 'obsidian';
import { notify } from './notify';
import {
	DEFAULT_TODOIST_TOKEN_SECRET_NAME,
	DEFAULT_SETTINGS,
	DEFAULT_PROP_NAMES,
	type TaskTodoistSettings,
} from './settings';
import { TaskTodoistSettingTab } from './settings-tab';
import { TodoistClient, type TodoistCreateProjectInput, type TodoistProjectSectionLookup } from './todoist-client';
import { SyncService, type SyncRunResult } from './sync-service';
import { CreateTaskModal } from './create-task-modal';
import { createLocalTaskNote, type LocalTaskNoteInput } from './task-note-factory';
import { registerInlineTaskConverter } from './inline-task-converter';
import { createTaskConvertOverlayExtension } from './editor-task-convert-overlay';
import { formatDueForDisplay, parseInlineTaskDirectives } from './task-directives';
import { applyStandardTaskFrontmatter, getPropNames, setTaskStatus, touchModifiedDate } from './task-frontmatter';
import { resolveTemplateVars } from './template-variables';
import { VaultIndex } from './vault-index';

export default class TaskTodoistPlugin extends Plugin {
	settings: TaskTodoistSettings;
	private todoistApiToken: string | null = null;
	private lastConnectionCheckMessage = 'No check run yet.';
	private lastSyncMessage = 'No sync run yet.';
	private lastSyncResult: SyncRunResult | null = null;
	private readonly recentTaskMetaByLink = new Map<string, {
		projectName?: string;
		sectionName?: string;
		dueDate?: string;
		dueString?: string;
		isRecurring?: boolean;
	}>();
	private scheduledSyncIntervalId: number | null = null;
	private syncLock: Promise<{ ok: boolean; message: string }> | null = null;
	private vaultIndex: VaultIndex | null = null;
	private syncQueued = false;
	private lastSyncToken: string | null = null;
	private readonly statusSyncBusy = new Set<string>();
	private readonly lastKnownTaskStatus = new Map<string, { taskDone: boolean | null; taskStatus: string | null }>();
	private lookupCache: { expiresAt: number; value: TodoistProjectSectionLookup } | null = null;
	private static readonly UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;


	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadTodoistApiToken();
		this.vaultIndex = new VaultIndex(this.app, this.settings);
		this.vaultIndex.register(this.registerEvent.bind(this));
		this.addSettingTab(new TaskTodoistSettingTab(this.app, this));
		this.registerCommands();
		this.registerRibbonCommands();
		this.registerVaultTaskDirtyTracking();
		this.registerStatusBidiSync();
		registerInlineTaskConverter(this);
		this.registerEditorExtension(createTaskConvertOverlayExtension(this));
		this.configureScheduledSync();
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Partial<TaskTodoistSettings & { lastSyncToken: string | null }> | null;
		const raw = loaded ?? {};
		this.settings = {
			...DEFAULT_SETTINGS,
			...raw,
			// Deep merge propNames so partial saved configs inherit defaults for new keys
			propNames: { ...DEFAULT_PROP_NAMES, ...(raw.propNames ?? {}) },
		};
		this.lastSyncToken = raw.lastSyncToken ?? null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...this.settings, lastSyncToken: this.lastSyncToken });
		this.vaultIndex?.updateSettings(this.settings);
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

	logDiagnostics(): void {
		const { todoistApiToken: _token, ...safeSettings } = this.settings as typeof this.settings & { todoistApiToken?: unknown };
		console.group('[obsidian-task-todoist] Diagnostics');
		console.log('Last sync result:', this.lastSyncResult ?? '(no sync run yet)');
		if (this.lastSyncResult?.phaseErrors?.length) {
			console.warn('Phase errors:', this.lastSyncResult.phaseErrors);
		}
		console.log('Settings:', safeSettings);
		console.log('Vault index snapshot:', this.vaultIndex?.get());
		console.groupEnd();
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

	async runImportSync(): Promise<{ ok: boolean; message: string; shortMessage?: string }> {
		if (this.syncLock !== null) {
			this.syncQueued = true;
			return { ok: false, message: 'Sync already running. Queued another run.' };
		}

		const doSync = async (): Promise<{ ok: boolean; message: string }> => {
			await this.loadTodoistApiToken();
			const token = this.todoistApiToken;
			if (!token) {
				const result = { ok: false, message: 'No todoist API token is configured.' };
				this.setLastSync(result.message);
				return result;
			}

			try {
				const service = new SyncService(this.app, this.settings, token, this.lastSyncToken, this.vaultIndex);
				const result = await service.runImportSync();
				if (result.syncToken) {
					this.lastSyncToken = result.syncToken;
					try {
						await this.saveSettings();
					} catch (saveErr) {
						console.error('[TaskTodoist] Failed to persist sync token:', saveErr);
					}
				}
				this.setLastSync(result.message, result);
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const result = { ok: false, message: `Sync failed unexpectedly: ${message}` };
				this.setLastSync(result.message);
				return result;
			}
		};

		this.syncLock = doSync();
		try {
			return await this.syncLock;
		} finally {
			this.syncLock = null;
			if (this.syncQueued) {
				this.syncQueued = false;
				void this.runImportSync().catch((err) => {
					console.error('[TaskTodoist] Queued sync failed:', err);
				});
			}
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

	async createNoteTaskForCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			notify(this.settings, 'No active note.', 4000);
			return;
		}

		const p = getPropNames(this.settings);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const rawNoteTaskId = fm ? fm[p.todoistNoteTaskId] : undefined;

		if (typeof rawNoteTaskId === 'string' && rawNoteTaskId.trim()) {
			notify(this.settings, 'This note already has a NoteTask linked.', 4000);
			return;
		}

		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			notify(this.settings, 'No Todoist API token configured.', 4000);
			return;
		}

		try {
			// Resolve project: check todoist_project_id directly first (project notes),
			// then fall back to resolving todoist_project_link wikilink (task notes).
			let projectId: string | undefined;
			if (fm) {
				const rawDirect = fm[p.todoistProjectId];
				if (typeof rawDirect === 'string' && rawDirect.trim()) {
					projectId = rawDirect.trim();
				} else {
					const rawLink = fm[p.todoistProjectLink];
					if (typeof rawLink === 'string' && rawLink.trim()) {
						const match = rawLink.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
						if (match) {
							const linkedFile = this.app.metadataCache.getFirstLinkpathDest(match[1]?.trim() ?? '', file.path);
							if (linkedFile) {
								const linkedFm = this.app.metadataCache.getFileCache(linkedFile)?.frontmatter as Record<string, unknown> | undefined;
								const pid = linkedFm?.[p.todoistProjectId];
								if (typeof pid === 'string' && pid.trim()) projectId = pid.trim();
							}
						}
					}
				}
			}

			const vaultName = encodeURIComponent(this.app.vault.getName());
			const filePath = encodeURIComponent(file.path);
			const obsidianUri = `obsidian://open?vault=${vaultName}&file=${filePath}`;

			const client = new TodoistClient(token);

			// Fetch snapshot to calculate order for positioning at top
			const snapshot = await client.fetchSyncSnapshot();
			let noteTaskOrder: number | undefined;
			if (projectId) {
				const projectTasks = snapshot.items.filter((item) => item.project_id === projectId && !item.parent_id);
				if (projectTasks.length > 0) {
					const minOrder = Math.min(...projectTasks.map((t) => t.order ?? 0));
					noteTaskOrder = minOrder > 0 ? minOrder - 1 : minOrder;
				}
			}

			const taskId = await client.createTask({
				content: `${file.basename} [note](${obsidianUri})`,
				projectId,
				order: noteTaskOrder,
			});

			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				(frontmatter as Record<string, unknown>)[p.todoistNoteTaskId] = taskId;
			});

			notify(this.settings, `NoteTask created for "${file.basename}".`, 4000);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			notify(this.settings, `Failed to create NoteTask: ${message}`, 6000);
		}
	}

	async createProjectForCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			notify(this.settings, 'No active note.', 4000);
			return;
		}

		const p = getPropNames(this.settings);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;

		const existingProjectId = fm ? fm[p.todoistProjectId] : undefined;
		if (typeof existingProjectId === 'string' && existingProjectId.trim()) {
			notify(this.settings, 'This note is already a Todoist project.', 4000);
			return;
		}

		await this.loadTodoistApiToken();
		const token = this.todoistApiToken;
		if (!token) {
			notify(this.settings, 'No Todoist API token configured.', 4000);
			return;
		}

		try {
			const projectName = file.basename;

			// Resolve parent project from parent_project_link wikilink
			let parentProjectId: string | undefined;
			if (fm) {
				const rawParentLink = fm[p.todoistParentProjectLink];
				if (typeof rawParentLink === 'string' && rawParentLink.trim()) {
					const match = rawParentLink.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
					if (match) {
						const linkedFile = this.app.metadataCache.getFirstLinkpathDest(match[1]?.trim() ?? '', file.path);
						if (linkedFile) {
							const linkedFm = this.app.metadataCache.getFileCache(linkedFile)?.frontmatter as Record<string, unknown> | undefined;
							const pid = linkedFm?.[p.todoistProjectId];
							if (typeof pid === 'string' && pid.trim()) {
								parentProjectId = pid.trim();
							} else {
								console.warn('[obsidian-task-todoist] parent_project_link target has no todoist_project_id — skipping parent.');
							}
						}
					}
				}
			}

			const client = new TodoistClient(token);

			const input: TodoistCreateProjectInput = { name: projectName };
			if (parentProjectId) input.parent_id = parentProjectId;
			const projectId = await client.createProject(input);

			const projectUrl = `todoist://project?id=${projectId}`;

			// NoteTask handling: if there's an existing NoteTask, move it into the new project
			const rawNoteTaskId = fm ? fm[p.todoistNoteTaskId] : undefined;
			const noteTaskId = typeof rawNoteTaskId === 'string' && rawNoteTaskId.trim() ? rawNoteTaskId.trim() : undefined;
			let noteTaskMoveFailed = false;
			if (noteTaskId) {
				try {
					await client.updateTask({ id: noteTaskId, projectId });
				} catch (moveErr) {
					noteTaskMoveFailed = true;
					console.error('[obsidian-task-todoist] Failed to move NoteTask into new project:', moveErr);
				}
			}

			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				const f = frontmatter as Record<string, unknown>;
				f[p.todoistProjectId] = projectId;
				f[p.todoistProjectName] = projectName;
				f[p.todoistProjectColor] = null;
				f[p.todoistUrl] = projectUrl;
				if (noteTaskId) {
					// Unify: mark the NoteTask as the project task too
					f[p.todoistProjectTaskId] = noteTaskId;
				} else if (this.settings.createProjectTasks) {
					// No NoteTask — set empty string sentinel so next sync creates a project task
					f[p.todoistProjectTaskId] = '';
				}
				if (!f[p.vaultId]) {
					f[p.vaultId] = crypto.randomUUID();
				}
				touchModifiedDate(f, this.settings);
			});

			this.vaultIndex?.invalidate();

			if (noteTaskMoveFailed) {
				notify(this.settings, `Project "${projectName}" created, but failed to move NoteTask — move it manually in Todoist.`, 8000);
			} else {
				notify(this.settings, `Project "${projectName}" created in Todoist.`, 4000);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			notify(this.settings, `Failed to create project: ${message}`, 6000);
		}
	}

	async convertEditorChecklistLineToTaskNote(editor: Editor): Promise<{ ok: boolean; message: string }> {
		const lineNumber = editor.getCursor().line;
		return this.convertChecklistLineByEditorLine(editor, lineNumber);
	}

	async convertChecklistLineInActiveEditor(lineNumberOneBased: number, expectedTitle?: string): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) {
			notify(this.settings, 'No active Markdown editor found.', 5000);
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
		notify(this.settings, `${prefix} ${result.message}`, 5000);
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

		try {
			const token = this.app.secretStorage.getSecret(secretName);
			this.todoistApiToken = token?.trim() || null;
		} catch (err) {
			console.error('[TaskTodoist] Failed to read API token from secret storage:', err);
			this.todoistApiToken = null;
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'test-todoist-connection',
			name: 'Test todoist connection',
			callback: async () => {
				const result = await this.testTodoistConnection();
				const prefix = result.ok ? 'Success:' : 'Failed:';
				notify(this.settings, `${prefix} ${result.message}`, 6000);
			},
		});
		this.addCommand({
			id: 'sync-todoist-now',
			name: 'Sync todoist now',
			callback: async () => {
				const result = await this.runImportSync();
				const prefix = result.ok ? 'Sync:' : 'Sync failed:';
				notify(this.settings, `${prefix} ${result.shortMessage ?? result.message}`, 8000);
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
				notify(this.settings, `${prefix} ${result.message}`, 6000);
			},
		});
		this.addCommand({
			id: 'create-note-task',
			name: 'Create NoteTask for current note',
			callback: async () => {
				await this.createNoteTaskForCurrentNote();
			},
		});
		this.addCommand({
			id: 'create-project-from-note',
			name: 'Create Todoist project from current note',
			callback: async () => {
				await this.createProjectForCurrentNote();
			},
		});
	}

	private registerRibbonCommands(): void {
		this.addRibbonIcon('sync', 'Sync Todoist now', async () => {
			const result = await this.runImportSync();
			const prefix = result.ok ? 'Sync:' : 'Sync failed:';
			notify(this.settings, `${prefix} ${result.shortMessage ?? result.message}`, 8000);
		});
	}

	private setLastConnectionCheck(message: string): void {
		const checkedAt = new Date().toLocaleString();
		this.lastConnectionCheckMessage = `${message} (${checkedAt})`;
	}

	private setLastSync(message: string, result?: SyncRunResult): void {
		const syncedAt = new Date().toLocaleString();
		this.lastSyncMessage = `${message} (${syncedAt})`;
		if (result) this.lastSyncResult = result;
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
		try {
			const result = await this.runImportSync();
			if (result.message.startsWith('Sync already running')) {
				return;
			}

			if (this.settings.showScheduledSyncNotices) {
				const prefix = result.ok ? 'Scheduled sync:' : 'Scheduled sync failed:';
				const displayMsg = result.shortMessage ?? result.message;
				notify(this.settings, `${prefix} ${displayMsg}`, result.ok ? 3500 : 5000);
				return;
			}

			if (!result.ok) {
				notify(this.settings, `Scheduled sync failed: ${result.shortMessage ?? result.message}`, 5000);
			}
		} catch (err) {
			console.error('[TaskTodoist] Scheduled sync threw unexpectedly:', err);
			notify(this.settings, 'Scheduled sync failed with an unexpected error. Check the developer console.', 5000);
		}
	}

	private registerStatusBidiSync(): void {
		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			void this.onMetadataCacheChanged(file);
		}));
	}

	private async onMetadataCacheChanged(file: TFile): Promise<void> {
		if (!this.isTaskFilePath(file.path) && !this.isDualPurposeNote(file)) return;
		if (this.statusSyncBusy.has(file.path)) return;

		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) return;

		const p = getPropNames(this.settings);
		const rawStatus = typeof frontmatter[p.taskStatus] === 'string'
			? (frontmatter[p.taskStatus] as string).trim()
			: null;
		const statusLower = rawStatus?.toLowerCase() ?? null;
		const rawDone = frontmatter[p.taskDone];
		const normDone: boolean | null = rawDone === true || rawDone === 'true' ? true
			: rawDone === false || rawDone === 'false' ? false
			: null;
		const isDone = normDone === true;
		const isNotDone = normDone === false;

		// During sync, just update the tracking map so we have a correct baseline
		// for the next user-initiated change — then exit without writing.
		if (this.syncLock !== null) {
			this.lastKnownTaskStatus.set(file.path, { taskDone: normDone, taskStatus: rawStatus });
			return;
		}

		const prev = this.lastKnownTaskStatus.get(file.path);
		let newDone: boolean | null = null;
		let newStatus: string | null = null;

		if (prev !== undefined) {
			const taskDoneChanged = normDone !== prev.taskDone;
			const taskStatusChanged = rawStatus !== prev.taskStatus;

			if (taskDoneChanged && !taskStatusChanged) {
				// User explicitly changed task_done → update task_status to match
				if (isDone && statusLower !== 'done') newStatus = 'Done';
				else if (isNotDone && statusLower !== 'open') newStatus = 'Open';
			} else if (!taskDoneChanged && taskStatusChanged) {
				// User changed task_status → update task_done (only for standard values)
				if (statusLower === 'done' && !isDone) newDone = true;
				else if (statusLower === 'open' && !isNotDone) newDone = false;
				// Custom status: leave task_done alone
			}
			// Both changed (e.g. sync wrote both) or neither changed → do nothing
		} else {
			// No previous state recorded yet — use field-priority fallback
			if (statusLower === 'done') {
				if (!isDone) newDone = true;
			} else if (statusLower === 'open') {
				if (!isNotDone) newDone = false;
			} else if (!statusLower) {
				if (isDone) newStatus = 'Done';
				else if (isNotDone) newStatus = 'Open';
			}
			// Custom status with no prior state: leave task_done alone
		}

		// Always update tracking with the current observed state
		this.lastKnownTaskStatus.set(file.path, { taskDone: normDone, taskStatus: rawStatus });

		if (newDone === null && newStatus === null) return;

		this.statusSyncBusy.add(file.path);
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const data = fm as Record<string, unknown>;
				if (newDone !== null) data[p.taskDone] = newDone;
				if (newStatus !== null) data[p.taskStatus] = newStatus;
			});
			// Update tracking to the final written state so subsequent events see it as baseline
			this.lastKnownTaskStatus.set(file.path, {
				taskDone: newDone !== null ? newDone : normDone,
				taskStatus: newStatus !== null ? newStatus : rawStatus,
			});
		} finally {
			setTimeout(() => this.statusSyncBusy.delete(file.path), 500);
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
		if (this.syncLock !== null) {
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
		if (
			currentStatus === 'dirty_local' ||
			currentStatus === 'queued_local_create' ||
			currentStatus === 'deleted_remote' ||
			currentStatus === 'archived_remote' ||
			currentStatus === 'missing_remote'
		) {
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

	/** Returns true for project notes that also represent a Todoist task (dual-purpose notes). */
	private isDualPurposeNote(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) return false;
		const p = getPropNames(this.settings);
		const rawPtId = fm[p.todoistProjectTaskId];
		const rawTId = fm[p.todoistId];
		const ptId = typeof rawPtId === 'string' ? rawPtId.trim() : '';
		const tId = typeof rawTId === 'string' ? rawTId.trim() : '';
		return ptId !== '' && ptId === tId;
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
