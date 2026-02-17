import { App, TFile, normalizePath } from 'obsidian';
import type { ArchiveMode, TaskTodoistSettings } from './settings';
import type { TodoistItem } from './todoist-client';
import {
	applyStandardTaskFrontmatter,
	formatCreatedDate,
	formatModifiedDate,
	getDefaultTaskTag,
	getTaskStatus,
	getTaskTitle,
	setTaskStatus,
	setTaskTitle,
} from './task-frontmatter';

interface ProjectSectionMaps {
	projectNameById: Map<string, string>;
	sectionNameById: Map<string, string>;
}

interface UpsertResult {
	created: number;
	updated: number;
}

interface SyncTaskResult {
	created: number;
	updated: number;
}

export interface SyncedTaskEntry {
	todoistId: string;
	file: TFile;
}

interface ParentAssignment {
	childTodoistId: string;
	parentTodoistId: string;
}

export interface PendingLocalCreate {
	file: TFile;
	title: string;
	description: string;
	isDone: boolean;
	isRecurring: boolean;
	syncSignature: string;
	projectName?: string;
	sectionName?: string;
	dueRaw?: string;
	projectId?: string;
	sectionId?: string;
	priority?: number;
	labels?: string[];
}

export interface PendingLocalUpdate {
	file: TFile;
	todoistId: string;
	title: string;
	description: string;
	isDone: boolean;
	isRecurring: boolean;
	syncSignature: string;
	projectName?: string;
	sectionName?: string;
	dueRaw: string;
	projectId?: string;
	sectionId?: string;
}

export class TaskNoteRepository {
	private readonly app: App;
	private readonly settings: TaskTodoistSettings;

	constructor(app: App, settings: TaskTodoistSettings) {
		this.app = app;
		this.settings = settings;
	}

	async syncItems(items: TodoistItem[], maps: ProjectSectionMaps): Promise<SyncTaskResult> {
		await this.ensureFolderExists(this.settings.tasksFolderPath);

		const existingByTodoistId = await this.buildTodoistIdIndexInTaskFolder();
		const createdOrUpdatedByTodoistId = new Map<string, TFile>();
		const pendingParents: ParentAssignment[] = [];

		let created = 0;
		let updated = 0;

		for (const item of items) {
			const existingFile = existingByTodoistId.get(item.id);
			const upsertResult = existingFile
				? await this.updateTaskFile(existingFile, item, maps)
				: await this.createTaskFile(item, maps);

			created += upsertResult.created;
			updated += upsertResult.updated;

			const targetFile = existingFile ?? upsertResult.file;
			if (targetFile) {
				createdOrUpdatedByTodoistId.set(item.id, targetFile);
			}

			if (item.parent_id) {
				pendingParents.push({ childTodoistId: item.id, parentTodoistId: item.parent_id });
			}
		}

		const combinedIndex = new Map<string, TFile>(existingByTodoistId);
		for (const [todoistId, file] of createdOrUpdatedByTodoistId) {
			combinedIndex.set(todoistId, file);
		}
		await this.applyParentLinks(combinedIndex, pendingParents);

		return { created, updated };
	}

	async repairMalformedSignatureFrontmatterLines(): Promise<number> {
		let repaired = 0;
		const folderPrefix = `${normalizePath(this.settings.tasksFolderPath)}/`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(this.settings.tasksFolderPath) || file.path.startsWith(folderPrefix))) {
				continue;
			}
			const content = await this.app.vault.cachedRead(file);
			const fixed = repairSignatureFrontmatterInContent(content);
			if (fixed !== content) {
				await this.app.vault.modify(file, fixed);
				repaired += 1;
			}
		}
		return repaired;
	}

	async listSyncedTasks(): Promise<SyncedTaskEntry[]> {
		const index = await this.buildTodoistIdIndexInTaskFolder();
		return Array.from(index.entries()).map(([todoistId, file]) => ({ todoistId, file }));
	}

	async applyMissingRemoteTasks(missingEntries: SyncedTaskEntry[], mode: ArchiveMode): Promise<number> {
		let changed = 0;
		const archivePrefix = `${normalizePath(this.settings.archiveFolderPath)}/`;
		for (const entry of missingEntries) {
			if (mode === 'none') {
				await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
					const data = frontmatter as Record<string, unknown>;
					applyStandardTaskFrontmatter(data, this.settings);
					if (data.todoist_sync_status !== 'missing_remote') {
						data.todoist_sync_status = 'missing_remote';
						data.todoist_last_imported_at = new Date().toISOString();
					}
				});
				changed += 1;
				continue;
			}

			const alreadyArchived = entry.file.path.startsWith(archivePrefix);
			await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
				const data = frontmatter as Record<string, unknown>;
				applyStandardTaskFrontmatter(data, this.settings);
				const targetStatus = mode === 'move-to-archive-folder' ? 'archived_remote' : 'completed_remote';
				setTaskStatus(data, 'done');
				if (data.todoist_sync_status !== targetStatus) {
					data.todoist_sync_status = targetStatus;
				}
				data.todoist_last_imported_at = new Date().toISOString();
			});
			changed += 1;

			if (mode === 'move-to-archive-folder' && !alreadyArchived) {
				await this.ensureFolderExists(this.settings.archiveFolderPath);
				const targetPath = await this.getUniqueFilePathInFolder(
					this.settings.archiveFolderPath,
					entry.file.name,
					entry.file.path,
				);
				if (targetPath !== entry.file.path) {
					await this.app.fileManager.renameFile(entry.file, targetPath);
				}
			}
		}
		return changed;
	}

	async listPendingLocalCreates(): Promise<PendingLocalCreate[]> {
		const pending: PendingLocalCreate[] = [];
		const folderPrefix = `${normalizePath(this.settings.tasksFolderPath)}/`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(this.settings.tasksFolderPath) || file.path.startsWith(folderPrefix))) {
				continue;
			}

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!frontmatter) {
				continue;
			}

			const todoistSync = frontmatter.todoist_sync;
			const todoistId = frontmatter.todoist_id;
			if (!isTruthy(todoistSync) || (typeof todoistId === 'string' && todoistId.trim())) {
				continue;
			}

			const title = getTaskTitle(frontmatter, file.basename).trim();
			if (!title) {
				continue;
			}

			const fullContent = await this.app.vault.cachedRead(file);
			const description = fullContent.replace(/^---[\s\S]*?---\n?/, '').trim();
			const isDone = getTaskStatus(frontmatter) === 'done';
			const isRecurring = frontmatter.todoist_is_recurring === true || frontmatter.todoist_is_recurring === 'true';
			const dueRaw = getDueRawForSync(frontmatter);
			const signature = buildTodoistSyncSignature({
				title,
				description,
				isDone,
				isRecurring,
				projectId: toOptionalString(frontmatter.todoist_project_id),
				sectionId: toOptionalString(frontmatter.todoist_section_id),
				dueRaw,
			});

			pending.push({
				file,
				title,
				description,
				isDone,
				isRecurring,
				syncSignature: signature,
				projectName: toOptionalString(frontmatter.todoist_project_name),
				sectionName: toOptionalString(frontmatter.todoist_section_name),
				dueRaw,
				projectId: toOptionalString(frontmatter.todoist_project_id),
				sectionId: toOptionalString(frontmatter.todoist_section_id),
				priority: toOptionalNumber(frontmatter.todoist_priority),
				labels: toStringArray(frontmatter.todoist_labels),
			});
		}

		return pending;
	}

	async markLocalCreateSynced(file: TFile, todoistId: string, syncSignature: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			data.todoist_id = todoistId;
			data.todoist_sync_status = 'synced';
			data.todoist_last_synced_signature = syncSignature;
			if ('sync_status' in data) {
				delete data.sync_status;
			}
			data.todoist_last_imported_at = new Date().toISOString();
		});
	}

	async listPendingLocalUpdates(): Promise<PendingLocalUpdate[]> {
		const pending: PendingLocalUpdate[] = [];
		const folderPrefix = `${normalizePath(this.settings.tasksFolderPath)}/`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(this.settings.tasksFolderPath) || file.path.startsWith(folderPrefix))) {
				continue;
			}

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!frontmatter) {
				continue;
			}

			const syncStatus =
				typeof frontmatter.todoist_sync_status === 'string'
					? frontmatter.todoist_sync_status
					: (typeof frontmatter.sync_status === 'string' ? frontmatter.sync_status : '');
			if (syncStatus !== 'dirty_local') {
				continue;
			}

			const todoistId = typeof frontmatter.todoist_id === 'string' ? frontmatter.todoist_id.trim() : '';
			if (!todoistId) {
				continue;
			}

			const title = getTaskTitle(frontmatter, file.basename).trim();
			if (!title) {
				continue;
			}

			const isDone = getTaskStatus(frontmatter) === 'done';
			const isRecurring = frontmatter.todoist_is_recurring === true || frontmatter.todoist_is_recurring === 'true';
			const fullContent = await this.app.vault.cachedRead(file);
			const description = fullContent.replace(/^---[\s\S]*?---\n?/, '').trim();
			const dueRaw = getDueRawForSync(frontmatter) ?? '';
			const signature = buildTodoistSyncSignature({
				title,
				description,
				isDone,
				isRecurring,
				projectId: toOptionalString(frontmatter.todoist_project_id),
				sectionId: toOptionalString(frontmatter.todoist_section_id),
				dueRaw,
			});
			const lastSyncedSignature =
				typeof frontmatter.todoist_last_synced_signature === 'string'
					? frontmatter.todoist_last_synced_signature
					: '';
			if (syncStatus === 'dirty_local' && lastSyncedSignature === signature) {
				await this.app.fileManager.processFrontMatter(file, (dirtyFrontmatter) => {
					const data = dirtyFrontmatter as Record<string, unknown>;
					applyStandardTaskFrontmatter(data, this.settings);
					data.todoist_sync_status = 'synced';
					if ('sync_status' in data) {
						delete data.sync_status;
					}
				});
				continue;
			}

			pending.push({
				file,
				todoistId,
				title,
				description,
				isDone,
				isRecurring,
				syncSignature: signature,
				projectName: toOptionalString(frontmatter.todoist_project_name),
				sectionName: toOptionalString(frontmatter.todoist_section_name),
				dueRaw,
				projectId: toOptionalString(frontmatter.todoist_project_id),
				sectionId: toOptionalString(frontmatter.todoist_section_id),
			});
		}

		return pending;
	}

	async markLocalUpdateSynced(file: TFile, syncSignature: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			data.todoist_sync_status = 'synced';
			data.todoist_last_synced_signature = syncSignature;
			if ('sync_status' in data) {
				delete data.sync_status;
			}
			data.todoist_last_imported_at = new Date().toISOString();
		});
	}

	private async createTaskFile(item: TodoistItem, maps: ProjectSectionMaps): Promise<UpsertResult & { file: TFile }> {
		const filePath = await this.getUniqueTaskFilePath(item.content, item.id);
		const markdown = buildNewFileContent(item, maps.projectNameById, maps.sectionNameById, this.settings);
		const file = await this.app.vault.create(filePath, markdown);
		return { created: 1, updated: 0, file };
	}

	private async updateTaskFile(file: TFile, item: TodoistItem, maps: ProjectSectionMaps): Promise<UpsertResult & { file: TFile }> {
		const remoteImportSignature = buildRemoteImportSignature(item, maps);
		const cachedFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const lastImportedSignature =
			typeof cachedFrontmatter?.todoist_last_imported_signature === 'string'
				? cachedFrontmatter.todoist_last_imported_signature
				: '';
		if (lastImportedSignature === remoteImportSignature) {
			const existingContent = await this.app.vault.cachedRead(file);
			const needsDescriptionBackfill = !hasBodyContent(existingContent) && Boolean(item.description?.trim());
			if (!needsDescriptionBackfill) {
				return { created: 0, updated: 0, file };
			}
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			setTaskTitle(data, item.content);
			setTaskStatus(data, item.checked ? 'done' : 'open');
			data.todoist_sync = true;
			data.todoist_id = item.id;
			data.todoist_project_id = item.project_id;
			data.todoist_project_name = maps.projectNameById.get(item.project_id) ?? 'Unknown';
			data.todoist_section_id = item.section_id ?? '';
			data.todoist_section_name = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
			data.todoist_priority = item.priority ?? 1;
			data.todoist_due = item.due?.date ?? '';
			data.todoist_due_string = item.due?.string ?? '';
			data.todoist_is_recurring = Boolean(item.due?.is_recurring);
			data.todoist_last_imported_signature = remoteImportSignature;
			data.todoist_last_synced_signature = buildTodoistSyncSignature({
				title: item.content,
				description: item.description ?? '',
				isDone: Boolean(item.checked),
				isRecurring: Boolean(item.due?.is_recurring),
				projectId: item.project_id,
				sectionId: item.section_id ?? undefined,
				dueRaw: item.due?.is_recurring ? (item.due?.string ?? '') : (item.due?.date ?? ''),
			});
			data.todoist_labels = item.labels ?? [];
			data.todoist_parent_id = item.parent_id ?? '';
			data.todoist_sync_status = 'synced';
			if ('sync_status' in data) {
				delete data.sync_status;
			}
			data.todoist_last_imported_at = new Date().toISOString();
		});

		const fileContent = await this.app.vault.cachedRead(file);
		if (!hasBodyContent(fileContent) && item.description?.trim()) {
			const nextContent = `${fileContent.trimEnd()}\n\n${item.description.trim()}\n`;
			await this.app.vault.modify(file, nextContent);
		}

		return { created: 0, updated: 1, file };
	}

	private async applyParentLinks(todoistIdIndex: Map<string, TFile>, assignments: ParentAssignment[]): Promise<void> {
		for (const assignment of assignments) {
			const childFile = todoistIdIndex.get(assignment.childTodoistId);
			const parentFile = todoistIdIndex.get(assignment.parentTodoistId);
			if (!childFile || !parentFile) {
				continue;
			}

			const parentLink = toWikiLink(parentFile.path);
			const existingFrontmatter = this.app.metadataCache.getFileCache(childFile)?.frontmatter as Record<string, unknown> | undefined;
			const existingParent = typeof existingFrontmatter?.parent_task === 'string' ? existingFrontmatter.parent_task : '';
			if (existingParent === parentLink) {
				continue;
			}

			await this.app.fileManager.processFrontMatter(childFile, (frontmatter) => {
				const data = frontmatter as Record<string, unknown>;
				applyStandardTaskFrontmatter(data, this.settings);
				data.parent_task = parentLink;
			});
		}
	}

	private async buildTodoistIdIndexInTaskFolder(): Promise<Map<string, TFile>> {
		const folderPrefix = `${normalizePath(this.settings.tasksFolderPath)}/`;
		const index = new Map<string, TFile>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(this.settings.tasksFolderPath) || file.path.startsWith(folderPrefix))) {
				continue;
			}

			const todoistId = await this.getTodoistId(file);
			if (todoistId) {
				index.set(todoistId, file);
			}
		}
		return index;
	}

	private async getTodoistId(file: TFile): Promise<string | null> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const fromCache = frontmatter?.todoist_id;
		if (typeof fromCache === 'string' && fromCache.trim()) {
			return fromCache;
		}
		if (typeof fromCache === 'number') {
			return String(fromCache);
		}

		const content = await this.app.vault.cachedRead(file);
		const match = content.match(/^---[\s\S]*?\btodoist_id:\s*["']?([^\n"']+)["']?\s*$/m);
		return match?.[1]?.trim() ?? null;
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		if (!normalized) {
			return;
		}

		const parts = normalized.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private async getUniqueTaskFilePath(taskTitle: string, todoistId: string): Promise<string> {
		const folder = normalizePath(this.settings.tasksFolderPath);
		const base = sanitizeFileName(taskTitle) || `Task-${todoistId}`;
		const basePath = normalizePath(`${folder}/${base}.md`);
		if (!this.app.vault.getAbstractFileByPath(basePath)) {
			return basePath;
		}
		return normalizePath(`${folder}/${base}-${todoistId}.md`);
	}

	private async getUniqueFilePathInFolder(folder: string, preferredFileName: string, currentPath?: string): Promise<string> {
		const normalizedFolder = normalizePath(folder);
		const sanitizedName = sanitizeFileName(preferredFileName.replace(/\.md$/i, '')) || 'Task';
		let candidatePath = normalizePath(`${normalizedFolder}/${sanitizedName}.md`);
		const existing = this.app.vault.getAbstractFileByPath(candidatePath);
		if (!existing) {
			return candidatePath;
		}
		if (existing instanceof TFile && existing.path === currentPath) {
			return candidatePath;
		}

		let suffix = 2;
		while (true) {
			candidatePath = normalizePath(`${normalizedFolder}/${sanitizedName}-${suffix}.md`);
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
				return candidatePath;
			}
			suffix += 1;
		}
	}
}

function buildNewFileContent(
	item: TodoistItem,
	projectNameById: Map<string, string>,
	sectionNameById: Map<string, string>,
	settings: TaskTodoistSettings,
): string {
	const now = new Date();
	const defaultTag = getDefaultTaskTag(settings) ?? 'tasks';
	const yaml = [
		'---',
		`task_status: ${item.checked ? 'done' : 'open'}`,
		`task_done: ${item.checked ? 'true' : 'false'}`,
		`created: "${formatCreatedDate(now)}"`,
		`modified: "${formatModifiedDate(now)}"`,
		'tags:',
		`  - ${defaultTag}`,
		'links: []',
		`task_title: ${toQuotedYaml(item.content)}`,
		'todoist_sync: true',
		'todoist_sync_status: "synced"',
		`todoist_id: "${escapeDoubleQuotes(item.id)}"`,
		`todoist_project_id: "${escapeDoubleQuotes(item.project_id)}"`,
		`todoist_project_name: ${toQuotedYaml(projectNameById.get(item.project_id) ?? 'Unknown')}`,
		`todoist_section_id: "${escapeDoubleQuotes(item.section_id ?? '')}"`,
		`todoist_section_name: ${toQuotedYaml(item.section_id ? (sectionNameById.get(item.section_id) ?? '') : '')}`,
		`todoist_priority: ${item.priority ?? 1}`,
		`todoist_due: "${escapeDoubleQuotes(item.due?.date ?? '')}"`,
		`todoist_due_string: "${escapeDoubleQuotes(item.due?.string ?? '')}"`,
		`todoist_is_recurring: ${item.due?.is_recurring ? 'true' : 'false'}`,
		`todoist_last_imported_signature: "${escapeDoubleQuotes(buildRemoteImportSignature(item, {
			projectNameById,
			sectionNameById,
		}))}"`,
		`todoist_last_synced_signature: "${escapeDoubleQuotes(buildTodoistSyncSignature({
			title: item.content,
			description: item.description ?? '',
			isDone: Boolean(item.checked),
			isRecurring: Boolean(item.due?.is_recurring),
			projectId: item.project_id,
			sectionId: item.section_id ?? undefined,
			dueRaw: item.due?.is_recurring ? (item.due?.string ?? '') : (item.due?.date ?? ''),
		}))}"`,
		`todoist_labels: [${(item.labels ?? []).map((label) => toQuotedYamlInline(label)).join(', ')}]`,
		`todoist_parent_id: "${escapeDoubleQuotes(item.parent_id ?? '')}"`,
		`todoist_last_imported_at: "${new Date().toISOString()}"`,
		'---',
		'',
		item.description?.trim() ?? '',
		'',
	];
	return yaml.join('\n');
}

function toWikiLink(filePath: string): string {
	return `[[${filePath.replace(/\.md$/i, '')}]]`;
}

function hasBodyContent(markdown: string): boolean {
	const contentWithoutFrontmatter = markdown.replace(/^---[\s\S]*?---\n?/, '').trim();
	return contentWithoutFrontmatter.length > 0;
}

function sanitizeFileName(value: string): string {
	return value
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function toQuotedYaml(value: string): string {
	return `"${escapeDoubleQuotes(value)}"`;
}

function toQuotedYamlInline(value: string): string {
	return `"${escapeDoubleQuotes(value)}"`;
}

function escapeDoubleQuotes(value: string): string {
	return value.replace(/"/g, '\\"');
}

function isTruthy(value: unknown): boolean {
	return value === true || value === 'true';
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function getDueRawForSync(frontmatter: Record<string, unknown>): string | undefined {
	const isRecurring = frontmatter.todoist_is_recurring === true || frontmatter.todoist_is_recurring === 'true';
	if (!isRecurring) {
		return toOptionalString(frontmatter.todoist_due);
	}
	const dueString = toOptionalString(frontmatter.todoist_due_string);
	if (dueString) {
		return dueString;
	}
	return toOptionalString(frontmatter.todoist_due);
}

function buildRemoteImportSignature(item: TodoistItem, maps: ProjectSectionMaps): string {
	return simpleStableHash(JSON.stringify([
		item.content,
		item.description ?? '',
		item.checked ? 1 : 0,
		item.project_id,
		maps.projectNameById.get(item.project_id) ?? 'Unknown',
		item.section_id ?? '',
		item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '',
		item.priority ?? 1,
		item.due?.date ?? '',
		item.due?.string ?? '',
		item.due?.is_recurring ? 1 : 0,
		item.parent_id ?? '',
		(item.labels ?? []).join('|'),
	]));
}

function buildTodoistSyncSignature(input: {
	title: string;
	description: string;
	isDone: boolean;
	isRecurring: boolean;
	projectId?: string;
	sectionId?: string;
	dueRaw?: string;
}): string {
	return simpleStableHash(JSON.stringify([
		input.title.trim(),
		input.description.trim(),
		input.isDone ? 1 : 0,
		input.isRecurring ? 1 : 0,
		input.projectId?.trim() ?? '',
		input.sectionId?.trim() ?? '',
		input.dueRaw?.trim() ?? '',
	]));
}

function simpleStableHash(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function repairSignatureFrontmatterInContent(content: string): string {
	const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---/);
	if (!frontmatterMatch) {
		return content;
	}
	const originalFrontmatter = frontmatterMatch[0];
	let fixedFrontmatter = originalFrontmatter;
	fixedFrontmatter = fixedFrontmatter.replace(
		/^todoist_last_imported_signature:.*$/gm,
		'todoist_last_imported_signature: ""',
	);
	fixedFrontmatter = fixedFrontmatter.replace(
		/^todoist_last_synced_signature:.*$/gm,
		'todoist_last_synced_signature: ""',
	);
	if (fixedFrontmatter === originalFrontmatter) {
		return content;
	}
	return content.replace(originalFrontmatter, fixedFrontmatter);
}
