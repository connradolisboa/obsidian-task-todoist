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
	getPropNames,
	priorityLabel,
	setTaskStatus,
	setTaskTitle,
	touchModifiedDate,
} from './task-frontmatter';
import { buildTodoistUrl, sanitizeFileName } from './task-note-factory';
import { resolveTemplateVars, ProjectTemplateContext, SectionTemplateContext } from './template-variables';

interface ProjectSectionMaps {
	projectNameById: Map<string, string>;
	sectionNameById: Map<string, string>;
	projectParentIdById?: Map<string, string | null>;
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
	dueDate?: string;
	dueString?: string;
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
	dueDate?: string;
	dueString?: string;
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
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		await this.ensureFolderExists(resolvedFolder);

		const { taskIndex: existingByTodoistId, projectIndex, sectionIndex } = this.buildVaultIndexes();
		const createdOrUpdatedByTodoistId = new Map<string, TFile>();
		const pendingParents: ParentAssignment[] = [];
		const seenProjectIds = new Set<string>();
		const seenSectionIds = new Set<string>();
		// Tracks all known project files (existing + newly created) for link resolution
		const projectFileById = new Map<string, TFile>(projectIndex);

		let created = 0;
		let updated = 0;

		for (const item of items) {
			// Ensure project/section notes before task files
			if (this.settings.createProjectNotes && !seenProjectIds.has(item.project_id)) {
				seenProjectIds.add(item.project_id);
				const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
				const projectFile = await this.ensureProjectNote(item.project_id, projectName, projectIndex);
				if (projectFile) {
					projectFileById.set(item.project_id, projectFile);
				}
			}
			if (this.settings.createSectionNotes && this.settings.useProjectSubfolders && item.section_id && !seenSectionIds.has(item.section_id)) {
				seenSectionIds.add(item.section_id);
				const sectionName = maps.sectionNameById.get(item.section_id) ?? 'Unknown';
				const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
				const projectFile = projectFileById.get(item.project_id) ?? null;
				await this.ensureSectionNote(item.section_id, sectionName, item.project_id, projectName, sectionIndex, projectFile);
			}

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
		await this.applyChildMetadata(combinedIndex, pendingParents);

		if (this.settings.createProjectNotes && maps.projectParentIdById) {
			await this.applyParentProjectLinks(projectFileById, maps.projectParentIdById);
		}

		return { created, updated };
	}

	private async ensureProjectNote(projectId: string, projectName: string, projectIndex: Map<string, TFile>): Promise<TFile | null> {
		// Check by ID vault-wide — finds the note even if it was renamed or moved
		if (projectIndex.has(projectId)) {
			return projectIndex.get(projectId)!;
		}

		const now = new Date();
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);

		let folderPath: string;
		let fileName: string;
		if (this.settings.projectNotesFolderPath?.trim()) {
			folderPath = normalizePath(resolveTemplateVars(this.settings.projectNotesFolderPath));
			fileName = `${sanitizeFileName(projectName) || projectId}.md`;
		} else if (this.settings.useProjectSubfolders) {
			const sanitizedProject = sanitizeFileName(projectName) || projectId;
			folderPath = normalizePath(`${resolvedFolder}/${sanitizedProject}`);
			fileName = `${sanitizedProject}.md`;
		} else {
			return null; // No sensible path without project subfolders
		}

		await this.ensureFolderExists(folderPath);
		const filePath = normalizePath(`${folderPath}/${fileName}`);
		const existingAbstract = this.app.vault.getAbstractFileByPath(filePath);
		if (existingAbstract instanceof TFile) {
			return existingAbstract; // Path-based guard for race conditions
		}
		if (existingAbstract) {
			return null;
		}

		const context: ProjectTemplateContext = { project_name: projectName, project_id: projectId };
		const areaNames = parseCommaSeparatedNameSet(this.settings.areaProjectNames);
		const isArea = areaNames.size > 0 && areaNames.has(projectName.toLowerCase());
		let content: string;
		if (isArea && this.settings.areaProjectNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.areaProjectNoteTemplate, now, context);
		} else if (this.settings.projectNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.projectNoteTemplate, now, context);
		} else {
			content = `---\nproject_name: "${projectName}"\nproject_id: "${projectId}"\ncreated: "${formatCreatedDate(now)}"\n---\n`;
		}
		const file = await this.app.vault.create(filePath, content);
		projectIndex.set(projectId, file);
		return file;
	}

	private async ensureSectionNote(sectionId: string, sectionName: string, projectId: string, projectName: string, sectionIndex: Map<string, TFile>, projectFile: TFile | null): Promise<void> {
		// Check by ID vault-wide — finds the note even if it was renamed or moved
		if (sectionIndex.has(sectionId)) {
			return;
		}

		const now = new Date();
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);

		let folderPath: string;
		let fileName: string;
		if (this.settings.sectionNotesFolderPath?.trim()) {
			folderPath = normalizePath(resolveTemplateVars(this.settings.sectionNotesFolderPath));
			fileName = `${sanitizeFileName(sectionName) || sectionId}.md`;
		} else {
			const sanitizedProject = sanitizeFileName(projectName) || projectId;
			const sanitizedSection = sanitizeFileName(sectionName) || sectionId;
			folderPath = normalizePath(`${resolvedFolder}/${sanitizedProject}/${sanitizedSection}`);
			fileName = `${sanitizedSection}.md`;
		}

		await this.ensureFolderExists(folderPath);
		const filePath = normalizePath(`${folderPath}/${fileName}`);
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			return; // Path-based guard for race conditions
		}

		const projectLink = projectFile ? toWikiLink(projectFile.path) : '';
		const context: SectionTemplateContext = {
			section_name: sectionName,
			section_id: sectionId,
			project_name: projectName,
			project_id: projectId,
			project_link: projectLink,
		};
		let content: string;
		if (this.settings.sectionNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.sectionNoteTemplate, now, context);
		} else {
			const projectLinkLine = projectLink ? `project_link: "${projectLink}"\n` : '';
			content = `---\nsection_name: "${sectionName}"\nsection_id: "${sectionId}"\nproject_name: "${projectName}"\nproject_id: "${projectId}"\n${projectLinkLine}created: "${formatCreatedDate(now)}"\n---\n`;
		}
		await this.app.vault.create(filePath, content);
	}

	async repairMalformedSignatureFrontmatterLines(): Promise<number> {
		let repaired = 0;
		const p = getPropNames(this.settings);
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		const folderPrefix = `${normalizePath(resolvedFolder)}/`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(resolvedFolder) || file.path.startsWith(folderPrefix))) {
				continue;
			}
			const content = await this.app.vault.cachedRead(file);
			const fixed = repairSignatureFrontmatterInContent(
				content,
				p.todoistLastImportedSignature,
				p.todoistLastSyncedSignature,
			);
			if (fixed !== content) {
				await this.app.vault.modify(file, fixed);
				repaired += 1;
			}
		}
		return repaired;
	}

	async listSyncedTasks(): Promise<SyncedTaskEntry[]> {
		const { taskIndex } = this.buildVaultIndexes();
		return Array.from(taskIndex.entries()).map(([todoistId, file]) => ({ todoistId, file }));
	}

	async applyMissingRemoteTasks(missingEntries: SyncedTaskEntry[], mode: ArchiveMode): Promise<number> {
		let changed = 0;
		const resolvedArchive = resolveTemplateVars(this.settings.archiveFolderPath);
		const archivePrefix = `${normalizePath(resolvedArchive)}/`;
		const p = getPropNames(this.settings);

		for (const entry of missingEntries) {
			const cachedFrontmatter = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as Record<string, unknown> | undefined;
			const currentSyncStatus =
				typeof cachedFrontmatter?.[p.todoistSyncStatus] === 'string'
					? cachedFrontmatter[p.todoistSyncStatus] as string
					: (typeof cachedFrontmatter?.sync_status === 'string' ? cachedFrontmatter.sync_status : '');
			const currentTaskStatus = cachedFrontmatter ? getTaskStatus(cachedFrontmatter, this.settings) : 'open';

			if (mode === 'delete-file') {
			await this.app.vault.trash(entry.file, false);
			changed += 1;
			continue;
		}

		if (mode === 'none') {
				if (currentSyncStatus === 'missing_remote') {
					continue;
				}
				await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
					const data = frontmatter as Record<string, unknown>;
					applyStandardTaskFrontmatter(data, this.settings);
					data[p.todoistSyncStatus] = 'missing_remote';
					data[p.todoistLastImportedAt] = new Date().toISOString();
				});
				changed += 1;
				continue;
			}

			const alreadyArchived = entry.file.path.startsWith(archivePrefix);
			const targetStatus = mode === 'move-to-archive-folder' ? 'archived_remote' : 'completed_remote';
			const needsFrontmatterUpdate = currentTaskStatus !== 'done' || currentSyncStatus !== targetStatus;
			const needsArchiveMove = mode === 'move-to-archive-folder' && !alreadyArchived;

			if (!needsFrontmatterUpdate && !needsArchiveMove) {
				continue;
			}

			if (needsFrontmatterUpdate) {
				await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
					const data = frontmatter as Record<string, unknown>;
					applyStandardTaskFrontmatter(data, this.settings);
					setTaskStatus(data, 'done', this.settings);
					data[p.todoistSyncStatus] = targetStatus;
					data[p.todoistLastImportedAt] = new Date().toISOString();
				});
			}

			if (needsArchiveMove) {
				await this.ensureFolderExists(resolvedArchive);
				const targetPath = await this.getUniqueFilePathInFolder(
					resolvedArchive,
					entry.file.name,
					entry.file.path,
				);
				if (targetPath !== entry.file.path) {
					await this.app.fileManager.renameFile(entry.file, targetPath);
				}
			}

			changed += 1;
		}
		return changed;
	}

	async applyArchivedProjectsAndSections(
		archivedProjectIds: Set<string>,
		archivedSectionIds: Set<string>,
	): Promise<number> {
		if (archivedProjectIds.size === 0 && archivedSectionIds.size === 0) {
			return 0;
		}
		let moved = 0;
		const { projectIndex, sectionIndex } = this.buildVaultIndexes();
		const resolvedProjectArchive = normalizePath(resolveTemplateVars(
			this.settings.projectArchiveFolderPath || 'Projects/_archive',
		));
		const resolvedSectionArchive = normalizePath(resolveTemplateVars(
			this.settings.sectionArchiveFolderPath || this.settings.projectArchiveFolderPath || 'Projects/_archive',
		));

		for (const projectId of archivedProjectIds) {
			const file = projectIndex.get(projectId);
			if (!file) {
				continue;
			}
			const archivePrefix = `${resolvedProjectArchive}/`;
			if (file.path === resolvedProjectArchive || file.path.startsWith(archivePrefix)) {
				continue;
			}
			await this.ensureFolderExists(resolvedProjectArchive);
			const targetPath = await this.getUniqueFilePathInFolder(resolvedProjectArchive, file.name, file.path);
			if (targetPath !== file.path) {
				await this.app.fileManager.renameFile(file, targetPath);
				moved += 1;
			}
		}

		for (const sectionId of archivedSectionIds) {
			const file = sectionIndex.get(sectionId);
			if (!file) {
				continue;
			}
			const archivePrefix = `${resolvedSectionArchive}/`;
			if (file.path === resolvedSectionArchive || file.path.startsWith(archivePrefix)) {
				continue;
			}
			await this.ensureFolderExists(resolvedSectionArchive);
			const targetPath = await this.getUniqueFilePathInFolder(resolvedSectionArchive, file.name, file.path);
			if (targetPath !== file.path) {
				await this.app.fileManager.renameFile(file, targetPath);
				moved += 1;
			}
		}

		return moved;
	}

	async listPendingLocalCreates(): Promise<PendingLocalCreate[]> {
		const pending: PendingLocalCreate[] = [];
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		const folderPrefix = `${normalizePath(resolvedFolder)}/`;
		const p = getPropNames(this.settings);

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(resolvedFolder) || file.path.startsWith(folderPrefix))) {
				continue;
			}

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!frontmatter) {
				continue;
			}

			const todoistSync = frontmatter[p.todoistSync];
			const todoistId = frontmatter[p.todoistId];
			if (!isTruthy(todoistSync) || (typeof todoistId === 'string' && todoistId.trim())) {
				continue;
			}

			const title = getTaskTitle(frontmatter, this.settings, file.basename).trim();
			if (!title) {
				continue;
			}

			// Description comes from the frontmatter property (body is no longer synced)
			const description = typeof frontmatter[p.todoistDescription] === 'string'
				? (frontmatter[p.todoistDescription] as string).trim()
				: '';
			const isDone = getTaskStatus(frontmatter, this.settings) === 'done';
			const isRecurring = frontmatter[p.todoistIsRecurring] === true || frontmatter[p.todoistIsRecurring] === 'true';
			const dueDate = toOptionalString(frontmatter[p.todoistDue]);
			const dueString = toOptionalString(frontmatter[p.todoistDueString]);
			const signature = buildTodoistSyncSignature({
				title,
				description,
				isDone,
				isRecurring,
				projectId: toOptionalString(frontmatter[p.todoistProjectId]),
				sectionId: toOptionalString(frontmatter[p.todoistSectionId]),
				dueDate,
				dueString,
			});

			pending.push({
				file,
				title,
				description,
				isDone,
				isRecurring,
				syncSignature: signature,
				projectName: toOptionalString(frontmatter[p.todoistProjectName]),
				sectionName: toOptionalString(frontmatter[p.todoistSectionName]),
				dueDate,
				dueString,
				projectId: toOptionalString(frontmatter[p.todoistProjectId]),
				sectionId: toOptionalString(frontmatter[p.todoistSectionId]),
				priority: toOptionalNumber(frontmatter[p.todoistPriority]),
				labels: toStringArray(frontmatter[p.todoistLabels]),
			});
		}

		return pending;
	}

	async markLocalCreateSynced(file: TFile, todoistId: string, syncSignature: string): Promise<void> {
		const p = getPropNames(this.settings);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			data[p.todoistId] = todoistId;
			data[p.todoistSyncStatus] = 'synced';
			data[p.todoistLastSyncedSignature] = syncSignature;
			// Write URL now that we have the Todoist ID
			data[p.todoistUrl] = buildTodoistUrl(todoistId, this.settings);
			if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
				delete data.sync_status;
			}
			data[p.todoistLastImportedAt] = new Date().toISOString();
		});
	}

	async listPendingLocalUpdates(): Promise<PendingLocalUpdate[]> {
		const pending: PendingLocalUpdate[] = [];
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		const folderPrefix = `${normalizePath(resolvedFolder)}/`;
		const p = getPropNames(this.settings);

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!(file.path === normalizePath(resolvedFolder) || file.path.startsWith(folderPrefix))) {
				continue;
			}

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!frontmatter) {
				continue;
			}

			const syncStatus =
				typeof frontmatter[p.todoistSyncStatus] === 'string'
					? frontmatter[p.todoistSyncStatus] as string
					: (typeof frontmatter.sync_status === 'string' ? frontmatter.sync_status : '');
			if (syncStatus !== 'dirty_local') {
				continue;
			}

			const todoistId = typeof frontmatter[p.todoistId] === 'string' ? (frontmatter[p.todoistId] as string).trim() : '';
			if (!todoistId) {
				continue;
			}

			const title = getTaskTitle(frontmatter, this.settings, file.basename).trim();
			if (!title) {
				continue;
			}

			const isDone = getTaskStatus(frontmatter, this.settings) === 'done';
			const isRecurring = frontmatter[p.todoistIsRecurring] === true || frontmatter[p.todoistIsRecurring] === 'true';

			// Description comes from the frontmatter property (body is no longer synced)
			const description = typeof frontmatter[p.todoistDescription] === 'string'
				? (frontmatter[p.todoistDescription] as string).trim()
				: '';
			const dueDate = toOptionalString(frontmatter[p.todoistDue]);
			const dueString = toOptionalString(frontmatter[p.todoistDueString]);
			const signature = buildTodoistSyncSignature({
				title,
				description,
				isDone,
				isRecurring,
				projectId: toOptionalString(frontmatter[p.todoistProjectId]),
				sectionId: toOptionalString(frontmatter[p.todoistSectionId]),
				dueDate,
				dueString,
			});
			const lastSyncedSignature =
				typeof frontmatter[p.todoistLastSyncedSignature] === 'string'
					? frontmatter[p.todoistLastSyncedSignature] as string
					: '';
			if (syncStatus === 'dirty_local' && lastSyncedSignature === signature) {
				await this.app.fileManager.processFrontMatter(file, (dirtyFrontmatter) => {
					const data = dirtyFrontmatter as Record<string, unknown>;
					applyStandardTaskFrontmatter(data, this.settings);
					data[p.todoistSyncStatus] = 'synced';
					if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
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
				projectName: toOptionalString(frontmatter[p.todoistProjectName]),
				sectionName: toOptionalString(frontmatter[p.todoistSectionName]),
				dueDate,
				dueString,
				projectId: toOptionalString(frontmatter[p.todoistProjectId]),
				sectionId: toOptionalString(frontmatter[p.todoistSectionId]),
			});
		}

		return pending;
	}

	async markLocalUpdateSynced(file: TFile, syncSignature: string): Promise<void> {
		const p = getPropNames(this.settings);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			data[p.todoistSyncStatus] = 'synced';
			data[p.todoistLastSyncedSignature] = syncSignature;
			if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
				delete data.sync_status;
			}
			data[p.todoistLastImportedAt] = new Date().toISOString();
		});
	}

	async renameTaskFileToMatchTitle(file: TFile, title: string): Promise<TFile> {
		if (!this.settings.autoRenameTaskFiles) {
			return file;
		}
		const desiredBaseName = sanitizeFileName(title.trim());
		if (!desiredBaseName || file.basename === desiredBaseName) {
			return file;
		}
		const folderPath = getFolderPath(file.path);
		const desiredPath = await this.getUniqueFilePathInFolder(folderPath, `${desiredBaseName}.md`, file.path);
		if (desiredPath === file.path) {
			return file;
		}
		await this.app.fileManager.renameFile(file, desiredPath);
		return file;
	}

	private async createTaskFile(item: TodoistItem, maps: ProjectSectionMaps): Promise<UpsertResult & { file: TFile }> {
		const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
		const sectionName = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
		const filePath = await this.getUniqueTaskFilePath(item.content, item.id, projectName, sectionName);
		const markdown = buildNewFileContent(item, maps.projectNameById, maps.sectionNameById, this.settings);
		const file = await this.app.vault.create(filePath, markdown);
		return { created: 1, updated: 0, file };
	}

	private async updateTaskFile(file: TFile, item: TodoistItem, maps: ProjectSectionMaps): Promise<UpsertResult & { file: TFile }> {
		const remoteImportSignature = buildRemoteImportSignature(item, maps);
		const cachedFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const p = getPropNames(this.settings);
		const lastImportedSignature =
			typeof cachedFrontmatter?.[p.todoistLastImportedSignature] === 'string'
				? cachedFrontmatter[p.todoistLastImportedSignature] as string
				: '';
		if (lastImportedSignature === remoteImportSignature) {
			return { created: 0, updated: 0, file };
		}

		// Conflict resolution: if the file has local unsent changes and local-wins is set, skip remote update.
		const syncStatus = typeof cachedFrontmatter?.[p.todoistSyncStatus] === 'string'
			? cachedFrontmatter[p.todoistSyncStatus] as string
			: '';
		if (syncStatus === 'dirty_local' && this.settings.conflictResolution === 'local-wins') {
			return { created: 0, updated: 0, file };
		}

		const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
		const sectionName = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
		const dueDate = item.due?.date ?? '';
		const deadlineDate = item.deadline?.date ?? '';
		const priority = item.priority ?? 1;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);
			touchModifiedDate(data, this.settings);
			setTaskTitle(data, item.content, this.settings);
			setTaskStatus(data, item.checked ? 'done' : 'open', this.settings);
			data[p.todoistSync] = true;
			data[p.todoistId] = item.id;
			data[p.todoistProjectId] = item.project_id;
			data[p.todoistProjectName] = projectName;
			data[p.todoistSectionId] = item.section_id ?? '';
			data[p.todoistSectionName] = sectionName;
			data[p.todoistPriority] = priority;
			data[p.todoistPriorityLabel] = priorityLabel(priority);
			data[p.todoistDue] = dueDate;
			data[p.todoistDueDateTyped] = dueDate || null;
			data[p.todoistDueString] = item.due?.string ?? '';
			data[p.todoistIsRecurring] = Boolean(item.due?.is_recurring);
			data[p.todoistDeadline] = deadlineDate || null;
			data[p.todoistDeadlineDateTyped] = deadlineDate || null;
			data[p.todoistDescription] = item.description?.trim() ?? '';
			data[p.todoistUrl] = buildTodoistUrl(item.id, this.settings);
			data[p.todoistLastImportedSignature] = remoteImportSignature;
			data[p.todoistLastSyncedSignature] = buildTodoistSyncSignature({
				title: item.content,
				description: item.description?.trim() ?? '',
				isDone: Boolean(item.checked),
				isRecurring: Boolean(item.due?.is_recurring),
				projectId: item.project_id,
				sectionId: item.section_id ?? undefined,
				dueDate,
				dueString: item.due?.string ?? '',
			});
			data[p.todoistLabels] = item.labels ?? [];
			data[p.todoistParentId] = item.parent_id ?? '';
			data[p.todoistSyncStatus] = 'synced';
			if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
				delete data.sync_status;
			}
			data[p.todoistLastImportedAt] = new Date().toISOString();
		});

		// Note: body content is intentionally NOT updated from Todoist description.
		// The description is stored in the todoist_description frontmatter property instead.
		// The note body is the user's personal notes area.

		const renamedFile = await this.relocateTaskFileIfNeeded(file, item.content, projectName, sectionName);

		return { created: 0, updated: 1, file: renamedFile };
	}

	private async applyParentLinks(todoistIdIndex: Map<string, TFile>, assignments: ParentAssignment[]): Promise<void> {
		const p = getPropNames(this.settings);
		for (const assignment of assignments) {
			const childFile = todoistIdIndex.get(assignment.childTodoistId);
			const parentFile = todoistIdIndex.get(assignment.parentTodoistId);
			if (!childFile || !parentFile) {
				continue;
			}

			const parentLink = toWikiLink(parentFile.path);
			const existingFrontmatter = this.app.metadataCache.getFileCache(childFile)?.frontmatter as Record<string, unknown> | undefined;
			const existingParent = typeof existingFrontmatter?.[p.parentTask] === 'string'
				? existingFrontmatter[p.parentTask] as string
				: '';
			if (existingParent === parentLink) {
				continue;
			}

			await this.app.fileManager.processFrontMatter(childFile, (frontmatter) => {
				const data = frontmatter as Record<string, unknown>;
				applyStandardTaskFrontmatter(data, this.settings);
				touchModifiedDate(data, this.settings);
				data[p.parentTask] = parentLink;
			});
		}
	}

	private async applyChildMetadata(todoistIdIndex: Map<string, TFile>, assignments: ParentAssignment[]): Promise<void> {
		const p = getPropNames(this.settings);
		const childLinksByParentTodoistId = new Map<string, string[]>();
		for (const assignment of assignments) {
			const parentFile = todoistIdIndex.get(assignment.parentTodoistId);
			const childFile = todoistIdIndex.get(assignment.childTodoistId);
			if (!parentFile || !childFile) {
				continue;
			}
			const next = childLinksByParentTodoistId.get(assignment.parentTodoistId) ?? [];
			next.push(toWikiLink(childFile.path));
			childLinksByParentTodoistId.set(assignment.parentTodoistId, next);
		}

		for (const [todoistId, file] of todoistIdIndex) {
			const desiredChildLinks = (childLinksByParentTodoistId.get(todoistId) ?? []).slice().sort((a, b) => a.localeCompare(b));
			const desiredHasChildren = desiredChildLinks.length > 0;
			const desiredChildCount = desiredChildLinks.length;

			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const currentHasChildren = toOptionalBoolean(frontmatter?.[p.todoistHasChildren]) ?? false;
			const currentChildCount = toOptionalNumber(frontmatter?.[p.todoistChildTaskCount]) ?? 0;
			const currentChildLinks = toStringArray(frontmatter?.[p.todoistChildTasks]).slice().sort((a, b) => a.localeCompare(b));

			if (
				currentHasChildren === desiredHasChildren
				&& currentChildCount === desiredChildCount
				&& stringArraysEqual(currentChildLinks, desiredChildLinks)
			) {
				continue;
			}

			await this.app.fileManager.processFrontMatter(file, (rawFrontmatter) => {
				const data = rawFrontmatter as Record<string, unknown>;
				applyStandardTaskFrontmatter(data, this.settings);
				touchModifiedDate(data, this.settings);
				data[p.todoistHasChildren] = desiredHasChildren;
				data[p.todoistChildTaskCount] = desiredChildCount;
				data[p.todoistChildTasks] = desiredChildLinks;
			});
		}
	}

	private async applyParentProjectLinks(projectFileById: Map<string, TFile>, projectParentIdById: Map<string, string | null>): Promise<void> {
		for (const [projectId, projectFile] of projectFileById) {
			const parentId = projectParentIdById.get(projectId) ?? null;
			if (!parentId) {
				continue;
			}
			const parentFile = projectFileById.get(parentId);
			if (!parentFile) {
				continue;
			}
			const parentLink = toWikiLink(parentFile.path);
			const frontmatter = this.app.metadataCache.getFileCache(projectFile)?.frontmatter as Record<string, unknown> | undefined;
			const existing = typeof frontmatter?.['parent_project_link'] === 'string' ? frontmatter['parent_project_link'] : '';
			if (existing === parentLink) {
				continue;
			}
			await this.app.fileManager.processFrontMatter(projectFile, (fm) => {
				(fm as Record<string, unknown>)['parent_project_link'] = parentLink;
			});
		}
	}

	private buildVaultIndexes(): {
		taskIndex: Map<string, TFile>;
		projectIndex: Map<string, TFile>;
		sectionIndex: Map<string, TFile>;
	} {
		const taskIndex = new Map<string, TFile>();
		const projectIndex = new Map<string, TFile>();
		const sectionIndex = new Map<string, TFile>();
		const p = getPropNames(this.settings);

		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				continue;
			}

			// Task index: by todoist_id (vault-wide, not restricted to tasksFolderPath)
			const rawId = fm[p.todoistId];
			if (typeof rawId === 'string' && rawId.trim()) {
				taskIndex.set(rawId.trim(), file);
			} else if (typeof rawId === 'number') {
				taskIndex.set(String(rawId), file);
			}

			// Project index: by project_id frontmatter
			const rawProjectId = fm['project_id'];
			if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
				projectIndex.set(rawProjectId.trim(), file);
			}

			// Section index: by section_id frontmatter
			const rawSectionId = fm['section_id'];
			if (typeof rawSectionId === 'string' && rawSectionId.trim()) {
				sectionIndex.set(rawSectionId.trim(), file);
			}
		}

		return { taskIndex, projectIndex, sectionIndex };
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

	private async relocateTaskFileIfNeeded(
		file: TFile,
		title: string,
		projectName?: string,
		sectionName?: string,
	): Promise<TFile> {
		const desiredFolder = await this.getDesiredFolderPath(projectName, sectionName);
		const currentFolder = getFolderPath(file.path);

		if (normalizePath(currentFolder) !== normalizePath(desiredFolder)) {
			const targetPath = await this.getUniqueFilePathInFolder(
				desiredFolder,
				`${file.basename}.md`,
				file.path,
			);
			await this.app.fileManager.renameFile(file, targetPath);
		}

		return this.renameTaskFileToMatchTitle(file, title);
	}

	private async getDesiredFolderPath(projectName?: string, sectionName?: string): Promise<string> {
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		let folder = normalizePath(resolvedFolder);

		if (this.settings.useProjectSubfolders && projectName?.trim()) {
			const sanitizedProject = sanitizeFileName(projectName.trim());
			if (sanitizedProject) {
				folder = normalizePath(`${folder}/${sanitizedProject}`);
				await this.ensureFolderExists(folder);

				if (this.settings.useSectionSubfolders && sectionName?.trim()) {
					const sanitizedSection = sanitizeFileName(sectionName.trim());
					if (sanitizedSection) {
						folder = normalizePath(`${folder}/${sanitizedSection}`);
						await this.ensureFolderExists(folder);
					}
				}
			}
		}

		return folder;
	}

	private async getUniqueTaskFilePath(taskTitle: string, todoistId: string, projectName?: string, sectionName?: string): Promise<string> {
		const folder = await this.getDesiredFolderPath(projectName, sectionName);
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
	const p = getPropNames(settings);
	const projectName = projectNameById.get(item.project_id) ?? 'Unknown';
	const sectionName = item.section_id ? (sectionNameById.get(item.section_id) ?? '') : '';
	const description = item.description?.trim() ?? '';
	const todoistUrl = buildTodoistUrl(item.id, settings);
	const dueDate = item.due?.date ?? '';
	const deadlineDate = item.deadline?.date ?? '';
	const priority = item.priority ?? 1;
	const createdDateStr = formatCreatedDate(now);

	if (settings.noteTemplate?.trim()) {
		const context = {
			title: item.content,
			description,
			due_date: dueDate,
			due_string: item.due?.string ?? '',
			deadline_date: deadlineDate,
			priority,
			priority_label: priorityLabel(priority),
			project: projectName,
			project_id: item.project_id,
			section: sectionName,
			section_id: item.section_id ?? '',
			todoist_id: item.id,
			url: todoistUrl,
			tags: defaultTag,
			created: createdDateStr,
		};
		return resolveTemplateVars(settings.noteTemplate, now, context);
	}

	const yaml = [
		'---',
		`${p.taskStatus}: ${item.checked ? 'done' : 'open'}`,
		`${p.taskDone}: ${item.checked ? 'true' : 'false'}`,
		`${p.created}: "${createdDateStr}"`,
		`${p.todoistCreatedDate}: "${createdDateStr}"`,
		`${p.modified}: "${formatModifiedDate(now)}"`,
		`${p.tags}:`,
		`  - ${defaultTag}`,
		`${p.links}: []`,
		`${p.taskTitle}: ${toQuotedYaml(item.content)}`,
		`${p.todoistSync}: true`,
		`${p.todoistSyncStatus}: "synced"`,
		`${p.todoistId}: "${escapeDoubleQuotes(item.id)}"`,
		`${p.todoistProjectId}: "${escapeDoubleQuotes(item.project_id)}"`,
		`${p.todoistProjectName}: ${toQuotedYaml(projectName)}`,
		`${p.todoistSectionId}: "${escapeDoubleQuotes(item.section_id ?? '')}"`,
		`${p.todoistSectionName}: ${toQuotedYaml(sectionName)}`,
		`${p.todoistPriority}: ${priority}`,
		`${p.todoistPriorityLabel}: "${priorityLabel(priority)}"`,
		`${p.todoistDue}: "${escapeDoubleQuotes(dueDate)}"`,
		`${p.todoistDueDateTyped}: ${dueDate ? toQuotedYaml(dueDate) : 'null'}`,
		`${p.todoistDueString}: "${escapeDoubleQuotes(item.due?.string ?? '')}"`,
		`${p.todoistIsRecurring}: ${item.due?.is_recurring ? 'true' : 'false'}`,
		`${p.todoistDeadline}: ${deadlineDate ? toQuotedYaml(deadlineDate) : 'null'}`,
		`${p.todoistDeadlineDateTyped}: ${deadlineDate ? toQuotedYaml(deadlineDate) : 'null'}`,
		`${p.todoistDescription}: ${toQuotedYaml(description)}`,
		`${p.todoistUrl}: "${escapeDoubleQuotes(todoistUrl)}"`,
		`${p.todoistLastImportedSignature}: "${escapeDoubleQuotes(buildRemoteImportSignature(item, {
			projectNameById,
			sectionNameById,
		}))}"`,
		`${p.todoistLastSyncedSignature}: "${escapeDoubleQuotes(buildTodoistSyncSignature({
			title: item.content,
			description,
			isDone: Boolean(item.checked),
			isRecurring: Boolean(item.due?.is_recurring),
			projectId: item.project_id,
			sectionId: item.section_id ?? undefined,
			dueDate,
			dueString: item.due?.string ?? '',
		}))}"`,
		`${p.todoistLabels}: [${(item.labels ?? []).map((label) => toQuotedYamlInline(label)).join(', ')}]`,
		`${p.todoistParentId}: "${escapeDoubleQuotes(item.parent_id ?? '')}"`,
		`${p.todoistHasChildren}: false`,
		`${p.todoistChildTaskCount}: 0`,
		`${p.todoistChildTasks}: []`,
		`${p.todoistLastImportedAt}: "${new Date().toISOString()}"`,
		'---',
		'',
	];
	return yaml.join('\n');
}

function toWikiLink(filePath: string): string {
	return `[[${filePath.replace(/\.md$/i, '')}]]`;
}

function getFolderPath(path: string): string {
	const slashIndex = path.lastIndexOf('/');
	if (slashIndex <= 0) {
		return '';
	}
	return path.slice(0, slashIndex);
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

function toOptionalBoolean(value: unknown): boolean | undefined {
	if (value === true || value === 'true') {
		return true;
	}
	if (value === false || value === 'false') {
		return false;
	}
	return undefined;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringArraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
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
		item.deadline?.date ?? '',
	]));
}

function buildTodoistSyncSignature(input: {
	title: string;
	description: string;
	isDone: boolean;
	isRecurring: boolean;
	projectId?: string;
	sectionId?: string;
	dueDate?: string;
	dueString?: string;
}): string {
	return simpleStableHash(JSON.stringify([
		input.title.trim(),
		input.description.trim(),
		input.isDone ? 1 : 0,
		input.isRecurring ? 1 : 0,
		input.projectId?.trim() ?? '',
		input.sectionId?.trim() ?? '',
		input.dueDate?.trim() ?? '',
		input.dueString?.trim() ?? '',
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

function repairSignatureFrontmatterInContent(
	content: string,
	importedSigKey: string,
	syncedSigKey: string,
): string {
	const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---/);
	if (!frontmatterMatch) {
		return content;
	}
	const originalFrontmatter = frontmatterMatch[0];
	let changed = false;
	const lines = originalFrontmatter.split('\n');
	const escapedImported = importedSigKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const escapedSynced = syncedSigKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const importedRe = new RegExp(`^\\s*${escapedImported}:`);
	const syncedRe = new RegExp(`^\\s*${escapedSynced}:`);
	const fixedLines = lines.map((line) => {
		if (importedRe.test(line)) {
			if (!isValidSignatureFrontmatterLine(line, importedSigKey)) {
				changed = true;
				return `${importedSigKey}: ""`;
			}
			return line;
		}
		if (syncedRe.test(line)) {
			if (!isValidSignatureFrontmatterLine(line, syncedSigKey)) {
				changed = true;
				return `${syncedSigKey}: ""`;
			}
			return line;
		}
		return line;
	});
	if (!changed) {
		return content;
	}
	const fixedFrontmatter = fixedLines.join('\n');
	if (fixedFrontmatter === originalFrontmatter) {
		return content;
	}
	return content.replace(originalFrontmatter, fixedFrontmatter);
}

function parseCommaSeparatedNameSet(rawValue: string): Set<string> {
	return new Set(
		(rawValue ?? '')
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
}

function isValidSignatureFrontmatterLine(line: string, key: string): boolean {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const signaturePattern = new RegExp(
		`^\\s*${escapedKey}:\\s*(?:"[0-9a-f]{8}"|'[0-9a-f]{8}'|[0-9a-f]{8}|""|'')?\\s*$`,
		'i',
	);
	return signaturePattern.test(line);
}
