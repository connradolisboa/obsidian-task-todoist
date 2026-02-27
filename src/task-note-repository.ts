import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type { TaskTodoistSettings } from './settings';
import type { TodoistItem, TodoistProject, TodoistSection } from './todoist-client';
import {
	applyStandardTaskFrontmatter,
	formatCreatedDate,
	formatModifiedDate,
	generateUuid,
	getDefaultTaskTag,
	getTaskStatus,
	getTaskTitle,
	getPropNames,
	priorityLabel,
	setTaskStatus,
	setTaskTitle,
	touchModifiedDate,
} from './task-frontmatter';
import {
	buildTodoistUrl,
	buildTodoistProjectUrl,
	buildTodoistSectionUrl,
	sanitizeFileName,
	buildSanitizedProjectFolderName,
	buildSanitizedSectionFolderName,
	buildProjectFolderSegments,
	topologicalSortProjects,
} from './task-note-factory';
import { resolveTemplateVars, ProjectTemplateContext, SectionTemplateContext } from './template-variables';
import { buildRecurrenceString } from './todoist-rrule';

interface ProjectSectionMaps {
	projectNameById: Map<string, string>;
	sectionNameById: Map<string, string>;
	sectionProjectIdById?: Map<string, string>;
	projectParentIdById?: Map<string, string | null>;
	projectColorById?: Map<string, string | null>;
	projectFileById?: Map<string, TFile>;
	sectionFileById?: Map<string, TFile>;
	allProjects?: TodoistProject[];
	allSections?: TodoistSection[];
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

export interface MissingTaskEntry {
	todoistId: string;
	file: TFile;
	isDeletedRemote: boolean;
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

		const { taskIndex: existingByTodoistId, projectIndex, sectionIndex, duplicateTaskIds } = this.buildVaultIndexes();
		this.emitDuplicateIdWarnings(duplicateTaskIds);
		const createdOrUpdatedByTodoistId = new Map<string, TFile>();
		const pendingParents: ParentAssignment[] = [];
		const seenProjectIds = new Set<string>();
		const seenSectionIds = new Set<string>();
		// Tracks all known project files (existing + newly created) for link resolution
		const projectFileById = new Map<string, TFile>(projectIndex);

		let created = 0;
		let updated = 0;

		// Pre-pass: ensure notes for ALL projects and sections (not just those with tasks)
		if (this.settings.createProjectNotes && maps.allProjects) {
			const sortedProjects = topologicalSortProjects(maps.allProjects);
			for (const project of sortedProjects) {
				if (!seenProjectIds.has(project.id)) {
					seenProjectIds.add(project.id);
					const projectFile = await this.ensureProjectNote(
						project.id,
						project.name,
						projectIndex,
						maps.projectNameById,
						maps.projectParentIdById ?? new Map(),
						project.color,
					);
					if (projectFile) {
						projectFileById.set(project.id, projectFile);
					}
				}
			}
		}
		if (this.settings.createSectionNotes && (this.settings.useProjectSubfolders || !!this.settings.sectionNotesFolderPath?.trim()) && maps.allSections) {
			for (const section of maps.allSections) {
				if (!seenSectionIds.has(section.id)) {
					seenSectionIds.add(section.id);
					const projectName = maps.projectNameById.get(section.project_id) ?? 'Unknown';
					const projectFile = projectFileById.get(section.project_id) ?? null;
					await this.ensureSectionNote(
						section.id,
						section.name,
						section.project_id,
						projectName,
						sectionIndex,
						projectFile,
						maps.projectNameById,
						maps.projectParentIdById ?? new Map(),
						maps.sectionProjectIdById ?? new Map(),
						maps.sectionNameById,
					);
				}
			}
		}

		for (const item of items) {
			// Ensure project/section notes for items not covered by the pre-pass
			if (this.settings.createProjectNotes && !seenProjectIds.has(item.project_id)) {
				seenProjectIds.add(item.project_id);
				const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
				const projectFile = await this.ensureProjectNote(
					item.project_id,
					projectName,
					projectIndex,
					maps.projectNameById,
					maps.projectParentIdById ?? new Map(),
					maps.projectColorById?.get(item.project_id) ?? null,
				);
				if (projectFile) {
					projectFileById.set(item.project_id, projectFile);
				}
			}
			if (this.settings.createSectionNotes && (this.settings.useProjectSubfolders || !!this.settings.sectionNotesFolderPath?.trim()) && item.section_id && !seenSectionIds.has(item.section_id)) {
				seenSectionIds.add(item.section_id);
				const sectionName = maps.sectionNameById.get(item.section_id) ?? 'Unknown';
				const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
				const projectFile = projectFileById.get(item.project_id) ?? null;
				await this.ensureSectionNote(
					item.section_id,
					sectionName,
					item.project_id,
					projectName,
					sectionIndex,
					projectFile,
					maps.projectNameById,
					maps.projectParentIdById ?? new Map(),
					maps.sectionProjectIdById ?? new Map(),
					maps.sectionNameById,
				);
			}

			const existingFile = existingByTodoistId.get(item.id);
			const mapsWithFiles: ProjectSectionMaps = { ...maps, projectFileById, sectionFileById: sectionIndex };
			const upsertResult = existingFile
				? await this.updateTaskFile(existingFile, item, mapsWithFiles)
				: await this.createTaskFile(item, mapsWithFiles);

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
			await this.applyParentProjectLinks(projectFileById, maps.projectParentIdById, maps.projectNameById);
		}

		return { created, updated };
	}

	/**
	 * If the cached project_name on an existing project note differs from the current Todoist name,
	 * updates the frontmatter and renames the file/folder to match.
	 */
	private async updateProjectNoteIfRenamed(
		file: TFile,
		projectId: string,
		projectName: string,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		projectColor?: string | null,
	): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) return;

		const p = getPropNames(this.settings);
		// Read with backward-compat: old notes used hardcoded 'project_name' key
		const cachedName =
			typeof fm[p.todoistProjectName] === 'string' ? (fm[p.todoistProjectName] as string) :
			(typeof fm['project_name'] === 'string' ? (fm['project_name'] as string) : null);
		const cachedColor = fm[p.todoistProjectColor] ?? undefined;
		const colorChanged = projectColor !== undefined && cachedColor !== projectColor;
		const nameChanged = cachedName !== null && cachedName !== projectName;
		if (!nameChanged && !colorChanged) return;

		// Update using configurable property names
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (nameChanged) frontmatter[p.todoistProjectName] = projectName;
			if (colorChanged) frontmatter[p.todoistProjectColor] = projectColor ?? null;
		});

		if (!nameChanged) return;

		// Build old sanitized name using the cached name (without disambiguation, as it was created)
		const oldSanitized = sanitizeFileName(cachedName) || projectId;
		// Build new name using the disambiguation helper with updated projectNameById
		const newSanitized = buildSanitizedProjectFolderName(projectId, projectName, projectNameById);
		if (oldSanitized === newSanitized) return;

		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);

		if (this.settings.projectNotesFolderPath?.trim()) {
			// Rename the project note file within the dedicated folder
			const folderPath = normalizePath(resolveTemplateVars(this.settings.projectNotesFolderPath));
			const newFilePath = normalizePath(`${folderPath}/${newSanitized}.md`);
			if (!this.app.vault.getAbstractFileByPath(newFilePath)) {
				await this.app.fileManager.renameFile(file, newFilePath);
			}
		} else if (this.settings.useProjectSubfolders) {
			// Rename the leaf project subfolder (nested path: parent segments + old leaf)
			const parentSegments = buildProjectFolderSegments(projectId, projectNameById, projectParentIdById).slice(0, -1);
			const basePath = parentSegments.length > 0
				? normalizePath([resolvedFolder, ...parentSegments].join('/'))
				: normalizePath(resolvedFolder);
			const oldFolderPath = normalizePath(`${basePath}/${oldSanitized}`);
			const newFolderPath = normalizePath(`${basePath}/${newSanitized}`);
			const oldFolder = this.app.vault.getAbstractFileByPath(oldFolderPath);
			if (oldFolder instanceof TFolder && !this.app.vault.getAbstractFileByPath(newFolderPath)) {
				await this.app.fileManager.renameFile(oldFolder, newFolderPath);
				// Obsidian updates file.path in-place after folder rename
				if (file.name !== `${newSanitized}.md`) {
					const newFilePath = normalizePath(`${newFolderPath}/${newSanitized}.md`);
					if (!this.app.vault.getAbstractFileByPath(newFilePath)) {
						await this.app.fileManager.renameFile(file, newFilePath);
					}
				}
			}
		}
	}

	private async ensureProjectNote(
		projectId: string,
		projectName: string,
		projectIndex: Map<string, TFile>,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		projectColor?: string | null,
	): Promise<TFile | null> {
		// Check by ID vault-wide — finds the note even if it was renamed or moved
		if (projectIndex.has(projectId)) {
			const file = projectIndex.get(projectId)!;
			await this.updateProjectNoteIfRenamed(file, projectId, projectName, projectNameById, projectParentIdById, projectColor);
			return file;
		}

		const now = new Date();
		const p = getPropNames(this.settings);
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);

		let folderPath: string;
		let fileName: string;
		if (this.settings.projectNotesFolderPath?.trim()) {
			folderPath = normalizePath(resolveTemplateVars(this.settings.projectNotesFolderPath));
			fileName = `${buildSanitizedProjectFolderName(projectId, projectName, projectNameById)}.md`;
		} else if (this.settings.useProjectSubfolders) {
			const segments = buildProjectFolderSegments(projectId, projectNameById, projectParentIdById);
			folderPath = normalizePath([resolvedFolder, ...segments].join('/'));
			const leafSegment = segments[segments.length - 1] ?? (sanitizeFileName(projectName) || projectId);
			fileName = `${leafSegment}.md`;
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

		const todoistUrl = buildTodoistProjectUrl(projectId, this.settings);
		const context: ProjectTemplateContext = { project_name: projectName, project_id: projectId, url: todoistUrl };
		const areaNames = parseCommaSeparatedNameSet(this.settings.areaProjectNames);
		const isArea = areaNames.size > 0 && areaNames.has(projectName.toLowerCase());
		let content: string;
		if (isArea && this.settings.areaProjectNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.areaProjectNoteTemplate, now, context);
		} else if (this.settings.projectNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.projectNoteTemplate, now, context);
		} else {
			content = [
				'---',
				`${p.vaultId}: "${generateUuid()}"`,
				`${p.todoistProjectName}: "${escapeDoubleQuotes(projectName)}"`,
				`${p.todoistProjectId}: "${escapeDoubleQuotes(projectId)}"`,
				projectColor ? `${p.todoistProjectColor}: "${escapeDoubleQuotes(projectColor)}"` : `${p.todoistProjectColor}: null`,
				`${p.todoistUrl}: "${escapeDoubleQuotes(todoistUrl)}"`,
				`${p.created}: "${formatCreatedDate(now)}"`,
				`${p.modified}: "${formatModifiedDate(now)}"`,
				`${p.tags}: []`,
				'---',
				'',
			].join('\n');
		}
		const file = await this.app.vault.create(filePath, content);
		// Always hydrate required frontmatter after creation. When a template is used, the
		// template may omit IDs or use different property names — hydration guarantees the
		// vault index can always find this note and rename detection works correctly.
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			if (!data[p.vaultId]) data[p.vaultId] = generateUuid();
			// Always set IDs — these are critical for vault indexing
			data[p.todoistProjectId] = projectId;
			data[p.todoistProjectName] = projectName;
			data[p.todoistProjectColor] = projectColor ?? null;
			data[p.todoistUrl] = todoistUrl;
			if (!data[p.created]) data[p.created] = formatCreatedDate(now);
			if (!data[p.modified]) data[p.modified] = formatModifiedDate(now);
			if (!data[p.tags] || (Array.isArray(data[p.tags]) && (data[p.tags] as unknown[]).length === 0)) {
				data[p.tags] = [];
			}
		});
		projectIndex.set(projectId, file);
		return file;
	}

	/**
	 * If the cached section_name or todoist_project_link on an existing section note is stale,
	 * updates the frontmatter and renames the file/subfolder to match.
	 */
	private async updateSectionNoteIfStale(file: TFile, sectionId: string, sectionName: string, projectFile: TFile | null): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) return;

		const p = getPropNames(this.settings);
		// Read with backward-compat: old notes used hardcoded 'section_name' key
		const cachedSectionName =
			typeof fm[p.todoistSectionName] === 'string' ? (fm[p.todoistSectionName] as string) :
			(typeof fm['section_name'] === 'string' ? (fm['section_name'] as string) : null);
		const cachedProjectLink = typeof fm[p.todoistProjectLink] === 'string' ? (fm[p.todoistProjectLink] as string) : null;

		const currentProjectLink = projectFile ? toWikiLink(projectFile.path) : '';
		const sectionNameStale = cachedSectionName !== null && cachedSectionName !== sectionName;
		const projectLinkStale = cachedProjectLink !== null && cachedProjectLink !== currentProjectLink;

		if (!sectionNameStale && !projectLinkStale) return;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (sectionNameStale) frontmatter[p.todoistSectionName] = sectionName;
			if (projectLinkStale) frontmatter[p.todoistProjectLink] = currentProjectLink;
		});

		if (!sectionNameStale) return;

		const oldSanitized = sanitizeFileName(cachedSectionName!) || sectionId;
		const newSanitized = sanitizeFileName(sectionName) || sectionId;
		if (oldSanitized === newSanitized) return;

		if (this.settings.sectionNotesFolderPath?.trim()) {
			// Dedicated folder — rename the file
			const folderPath = normalizePath(resolveTemplateVars(this.settings.sectionNotesFolderPath));
			const newFilePath = normalizePath(`${folderPath}/${newSanitized}.md`);
			if (!this.app.vault.getAbstractFileByPath(newFilePath)) {
				await this.app.fileManager.renameFile(file, newFilePath);
			}
		} else {
			// Default: section note lives inside a subfolder named after the section
			const sectionFolder = file.parent;
			if (sectionFolder instanceof TFolder) {
				const parentPath = sectionFolder.parent?.path ?? '';
				const newFolderPath = normalizePath(`${parentPath}/${newSanitized}`);
				if (!this.app.vault.getAbstractFileByPath(newFolderPath)) {
					await this.app.fileManager.renameFile(sectionFolder, newFolderPath);
					// Obsidian updates file.path in-place after folder rename
					if (file.name !== `${newSanitized}.md`) {
						const newFilePath = normalizePath(`${newFolderPath}/${newSanitized}.md`);
						if (!this.app.vault.getAbstractFileByPath(newFilePath)) {
							await this.app.fileManager.renameFile(file, newFilePath);
						}
					}
				}
			}
		}
	}

	private async ensureSectionNote(
		sectionId: string,
		sectionName: string,
		projectId: string,
		projectName: string,
		sectionIndex: Map<string, TFile>,
		projectFile: TFile | null,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<void> {
		// Check by ID vault-wide — finds the note even if it was renamed or moved
		if (sectionIndex.has(sectionId)) {
			const file = sectionIndex.get(sectionId)!;
			await this.updateSectionNoteIfStale(file, sectionId, sectionName, projectFile);
			return;
		}

		const now = new Date();
		const p = getPropNames(this.settings);
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);

		let folderPath: string;
		let fileName: string;
		if (this.settings.sectionNotesFolderPath?.trim()) {
			folderPath = normalizePath(resolveTemplateVars(this.settings.sectionNotesFolderPath));
			fileName = `${buildSanitizedSectionFolderName(sectionId, sectionName, projectId, sectionNameById, sectionProjectIdById)}.md`;
		} else {
			const projectSegments = buildProjectFolderSegments(projectId, projectNameById, projectParentIdById);
			const sanitizedSection = buildSanitizedSectionFolderName(sectionId, sectionName, projectId, sectionNameById, sectionProjectIdById);
			folderPath = normalizePath([resolvedFolder, ...projectSegments, sanitizedSection].join('/'));
			fileName = `${sanitizedSection}.md`;
		}

		await this.ensureFolderExists(folderPath);
		const filePath = normalizePath(`${folderPath}/${fileName}`);
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			return; // Path-based guard for race conditions
		}

		const projectLink = projectFile ? toWikiLink(projectFile.path) : '';
		const todoistUrl = buildTodoistSectionUrl(projectId, this.settings);
		const context: SectionTemplateContext = {
			section_name: sectionName,
			section_id: sectionId,
			project_name: projectName,
			project_id: projectId,
			url: todoistUrl,
			project_link: projectLink,
		};
		let content: string;
		if (this.settings.sectionNoteTemplate?.trim()) {
			content = resolveTemplateVars(this.settings.sectionNoteTemplate, now, context);
		} else {
			content = [
				'---',
				`${p.vaultId}: "${generateUuid()}"`,
				`${p.todoistSectionName}: "${escapeDoubleQuotes(sectionName)}"`,
				`${p.todoistSectionId}: "${escapeDoubleQuotes(sectionId)}"`,
				`${p.todoistProjectName}: "${escapeDoubleQuotes(projectName)}"`,
				`${p.todoistProjectId}: "${escapeDoubleQuotes(projectId)}"`,
				`${p.todoistUrl}: "${escapeDoubleQuotes(todoistUrl)}"`,
				`${p.todoistProjectLink}: "${escapeDoubleQuotes(projectLink)}"`,
				`${p.created}: "${formatCreatedDate(now)}"`,
				`${p.modified}: "${formatModifiedDate(now)}"`,
				`${p.tags}: []`,
				'---',
				'',
			].join('\n');
		}
		const file = await this.app.vault.create(filePath, content);
		// Always hydrate required frontmatter after creation. When a template is used, the
		// template may omit IDs or use different property names — hydration guarantees the
		// vault index can always find this note and links are set correctly.
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			if (!data[p.vaultId]) data[p.vaultId] = generateUuid();
			// Always set IDs and link — critical for vault indexing and task→section linking
			data[p.todoistSectionId] = sectionId;
			data[p.todoistSectionName] = sectionName;
			data[p.todoistProjectId] = projectId;
			data[p.todoistProjectName] = projectName;
			data[p.todoistUrl] = todoistUrl;
			data[p.todoistProjectLink] = projectLink;
			if (!data[p.created]) data[p.created] = formatCreatedDate(now);
			if (!data[p.modified]) data[p.modified] = formatModifiedDate(now);
			if (!data[p.tags] || (Array.isArray(data[p.tags]) && (data[p.tags] as unknown[]).length === 0)) {
				data[p.tags] = [];
			}
		});
		sectionIndex.set(sectionId, file);
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
		const { taskIndex, duplicateTaskIds } = this.buildVaultIndexes();
		this.emitDuplicateIdWarnings(duplicateTaskIds);
		return Array.from(taskIndex.entries()).map(([todoistId, file]) => ({ todoistId, file }));
	}

	async applyMissingRemoteTasks(missingEntries: MissingTaskEntry[]): Promise<number> {
		let changed = 0;
		const p = getPropNames(this.settings);
		const { completedTaskMode, deletedTaskMode } = this.settings;
		const resolvedCompletedFolder = resolveTemplateVars(this.settings.completedFolderPath);
		const completedFolderPrefix = `${normalizePath(resolvedCompletedFolder)}/`;
		const resolvedDeletedFolder = resolveTemplateVars(this.settings.deletedFolderPath);
		const deletedFolderPrefix = `${normalizePath(resolvedDeletedFolder)}/`;

		for (const entry of missingEntries) {
			const cachedFrontmatter = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as Record<string, unknown> | undefined;
			const currentSyncStatus =
				typeof cachedFrontmatter?.[p.todoistSyncStatus] === 'string'
					? cachedFrontmatter[p.todoistSyncStatus] as string
					: (typeof cachedFrontmatter?.sync_status === 'string' ? cachedFrontmatter.sync_status : '');
			const currentTaskStatus = cachedFrontmatter ? getTaskStatus(cachedFrontmatter, this.settings) : 'open';

			if (entry.isDeletedRemote) {
				// --- Deleted task ---
				const targetStatus = 'deleted_remote';

				if (deletedTaskMode === 'stop-syncing') {
					// Mark deleted_remote, set is_deleted flag, and remove todoist_id so it's no longer tracked
					if (currentSyncStatus === targetStatus && !cachedFrontmatter?.[p.todoistId]) {
						continue;
					}
					await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
						const data = frontmatter as Record<string, unknown>;
						applyStandardTaskFrontmatter(data, this.settings);
						data[p.todoistSyncStatus] = targetStatus;
						data[p.todoistIsDeleted] = true;
						data[p.todoistLastImportedAt] = new Date().toISOString();
						delete data[p.todoistId];
					});
					changed += 1;
					continue;
				}

				const alreadyMoved = entry.file.path.startsWith(deletedFolderPrefix);
				const needsFrontmatterUpdate = currentSyncStatus !== targetStatus;
				const needsMove = deletedTaskMode === 'move-to-folder' && !alreadyMoved;

				if (!needsFrontmatterUpdate && !needsMove) {
					continue;
				}

				if (needsFrontmatterUpdate) {
					await this.app.fileManager.processFrontMatter(entry.file, (frontmatter) => {
						const data = frontmatter as Record<string, unknown>;
						applyStandardTaskFrontmatter(data, this.settings);
						data[p.todoistSyncStatus] = targetStatus;
						data[p.todoistIsDeleted] = true;
						data[p.todoistLastImportedAt] = new Date().toISOString();
					});
				}

				if (needsMove) {
					await this.ensureFolderExists(resolvedDeletedFolder);
					const targetPath = await this.getUniqueFilePathInFolder(
						resolvedDeletedFolder,
						entry.file.name,
						entry.file.path,
					);
					if (targetPath !== entry.file.path) {
						await this.app.fileManager.renameFile(entry.file, targetPath);
					}
				}

				changed += 1;
			} else {
				// --- Completed task: always mark as done + archived_remote ---
				const targetStatus = 'archived_remote';
				const alreadyMoved = entry.file.path.startsWith(completedFolderPrefix);
				const needsFrontmatterUpdate = currentTaskStatus !== 'done' || currentSyncStatus !== targetStatus;
				const needsMove = completedTaskMode === 'move-to-folder' && !alreadyMoved;

				if (!needsFrontmatterUpdate && !needsMove) {
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

				if (needsMove) {
					await this.ensureFolderExists(resolvedCompletedFolder);
					const targetPath = await this.getUniqueFilePathInFolder(
						resolvedCompletedFolder,
						entry.file.name,
						entry.file.path,
					);
					if (targetPath !== entry.file.path) {
						await this.app.fileManager.renameFile(entry.file, targetPath);
					}
				}

				changed += 1;
			}
		}
		return changed;
	}

	async applyArchivedProjectsAndSections(
		archivedProjects: { id: string; name: string }[],
		archivedSections: { id: string; name: string; project_id: string }[],
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<number> {
		if (archivedProjects.length === 0 && archivedSections.length === 0) {
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
		const resolvedTasksFolder = normalizePath(resolveTemplateVars(this.settings.tasksFolderPath));
		const resolvedTaskArchive = normalizePath(resolveTemplateVars(
			this.settings.completedFolderPath || 'Tasks/_archive',
		));

		for (const project of archivedProjects) {
			const file = projectIndex.get(project.id);
			if (file) {
				const archivePrefix = `${resolvedProjectArchive}/`;
				if (file.path !== resolvedProjectArchive && !file.path.startsWith(archivePrefix)) {
					await this.ensureFolderExists(resolvedProjectArchive);
					const targetPath = await this.getUniqueFilePathInFolder(resolvedProjectArchive, file.name, file.path);
					if (targetPath !== file.path) {
						await this.app.fileManager.renameFile(file, targetPath);
						moved += 1;
					}
				}
			}

			if (this.settings.useProjectSubfolders) {
				const segments = buildProjectFolderSegments(project.id, projectNameById, projectParentIdById);
				const folderPath = normalizePath([resolvedTasksFolder, ...segments].join('/'));
				const taskArchivePrefix = `${resolvedTaskArchive}/`;
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (folder instanceof TFolder && folderPath !== resolvedTaskArchive && !folderPath.startsWith(taskArchivePrefix)) {
					await this.ensureFolderExists(resolvedTaskArchive);
					const leafSegment = segments[segments.length - 1] ?? (sanitizeFileName(project.name) || project.id);
					const targetFolder = normalizePath(`${resolvedTaskArchive}/${leafSegment}`);
					await this.app.fileManager.renameFile(folder, targetFolder);
					moved += 1;
				}
			}
		}

		for (const section of archivedSections) {
			const file = sectionIndex.get(section.id);
			if (file) {
				const archivePrefix = `${resolvedSectionArchive}/`;
				if (file.path !== resolvedSectionArchive && !file.path.startsWith(archivePrefix)) {
					await this.ensureFolderExists(resolvedSectionArchive);
					const targetPath = await this.getUniqueFilePathInFolder(resolvedSectionArchive, file.name, file.path);
					if (targetPath !== file.path) {
						await this.app.fileManager.renameFile(file, targetPath);
						moved += 1;
					}
				}
			}

			if (this.settings.useProjectSubfolders) {
				const projectSegments = buildProjectFolderSegments(section.project_id, projectNameById, projectParentIdById);
				const sanitizedSection = buildSanitizedSectionFolderName(section.id, section.name, section.project_id, sectionNameById, sectionProjectIdById);
				const folderPath = normalizePath([resolvedTasksFolder, ...projectSegments, sanitizedSection].join('/'));
				const sectionArchivePrefix = `${resolvedSectionArchive}/`;
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (folder instanceof TFolder && folderPath !== resolvedSectionArchive && !folderPath.startsWith(sectionArchivePrefix)) {
					await this.ensureFolderExists(resolvedSectionArchive);
					const targetFolder = normalizePath(`${resolvedSectionArchive}/${sanitizedSection}`);
					await this.app.fileManager.renameFile(folder, targetFolder);
					moved += 1;
				}
			}
		}

		return moved;
	}

	async applyUnarchivedProjectsAndSections(
		unarchivedProjects: { id: string; name: string }[],
		unarchivedSections: { id: string; name: string; project_id: string }[],
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<number> {
		let moved = 0;
		const { projectIndex, sectionIndex } = this.buildVaultIndexes();
		const resolvedProjectArchive = normalizePath(resolveTemplateVars(
			this.settings.projectArchiveFolderPath || 'Projects/_archive',
		));
		const resolvedSectionArchive = normalizePath(resolveTemplateVars(
			this.settings.sectionArchiveFolderPath || this.settings.projectArchiveFolderPath || 'Projects/_archive',
		));
		const resolvedTasksFolder = normalizePath(resolveTemplateVars(this.settings.tasksFolderPath));
		const resolvedTaskArchive = normalizePath(resolveTemplateVars(
			this.settings.completedFolderPath || 'Tasks/_archive',
		));

		// Process project unarchiving first so project folders exist when restoring sections
		for (const project of unarchivedProjects) {
			const file = projectIndex.get(project.id);
			if (!file) {
				continue;
			}
			const archivePrefix = `${resolvedProjectArchive}/`;
			if (file.path !== resolvedProjectArchive && !file.path.startsWith(archivePrefix)) {
				// Note is not in archive — nothing to restore
				continue;
			}

			// Determine target note path (mirrors ensureProjectNote logic)
			const segments = buildProjectFolderSegments(project.id, projectNameById, projectParentIdById);
			const leafSegment = segments[segments.length - 1] ?? (sanitizeFileName(project.name) || project.id);
			let targetNotePath: string;
			if (this.settings.projectNotesFolderPath?.trim()) {
				const sanitizedName = buildSanitizedProjectFolderName(project.id, project.name, projectNameById);
				const folder = normalizePath(resolveTemplateVars(this.settings.projectNotesFolderPath));
				await this.ensureFolderExists(folder);
				targetNotePath = await this.getUniqueFilePathInFolder(folder, `${sanitizedName}.md`, file.path);
			} else if (this.settings.useProjectSubfolders) {
				const folder = normalizePath([resolvedTasksFolder, ...segments].join('/'));
				await this.ensureFolderExists(folder);
				targetNotePath = await this.getUniqueFilePathInFolder(folder, `${leafSegment}.md`, file.path);
			} else {
				continue; // No sensible restore path
			}

			if (targetNotePath !== file.path) {
				await this.app.fileManager.renameFile(file, targetNotePath);
				moved += 1;
			}

			// Restore task subfolder using archived note's stem (the old sanitized name)
			if (this.settings.useProjectSubfolders) {
				const oldStem = file.basename; // filename without extension, as it was archived
				const archivedFolderPath = normalizePath(`${resolvedTaskArchive}/${oldStem}`);
				const archivedFolder = this.app.vault.getAbstractFileByPath(archivedFolderPath);
				if (archivedFolder instanceof TFolder) {
					const targetFolder = normalizePath([resolvedTasksFolder, ...segments].join('/'));
					if (archivedFolderPath !== targetFolder) {
						await this.app.fileManager.renameFile(archivedFolder, targetFolder);
						moved += 1;
					}
				}
			}
		}

		for (const section of unarchivedSections) {
			const file = sectionIndex.get(section.id);
			if (!file) {
				continue;
			}
			const archivePrefix = `${resolvedSectionArchive}/`;
			if (file.path !== resolvedSectionArchive && !file.path.startsWith(archivePrefix)) {
				continue;
			}

			const projectSegments = buildProjectFolderSegments(section.project_id, projectNameById, projectParentIdById);
			const sanitizedSection = buildSanitizedSectionFolderName(section.id, section.name, section.project_id, sectionNameById, sectionProjectIdById);

			// Determine target section note path (mirrors ensureSectionNote logic)
			let targetNotePath: string;
			if (this.settings.sectionNotesFolderPath?.trim()) {
				const folder = normalizePath(resolveTemplateVars(this.settings.sectionNotesFolderPath));
				await this.ensureFolderExists(folder);
				targetNotePath = await this.getUniqueFilePathInFolder(folder, `${sanitizedSection}.md`, file.path);
			} else if (this.settings.useProjectSubfolders) {
				const folder = normalizePath([resolvedTasksFolder, ...projectSegments, sanitizedSection].join('/'));
				await this.ensureFolderExists(folder);
				targetNotePath = await this.getUniqueFilePathInFolder(folder, `${sanitizedSection}.md`, file.path);
			} else {
				continue;
			}

			if (targetNotePath !== file.path) {
				await this.app.fileManager.renameFile(file, targetNotePath);
				moved += 1;
			}

			// Restore section subfolder
			if (this.settings.useProjectSubfolders) {
				const oldStem = file.basename;
				const archivedFolderPath = normalizePath(`${resolvedSectionArchive}/${oldStem}`);
				const archivedFolder = this.app.vault.getAbstractFileByPath(archivedFolderPath);
				if (archivedFolder instanceof TFolder) {
					const targetFolder = normalizePath([resolvedTasksFolder, ...projectSegments, sanitizedSection].join('/'));
					if (archivedFolderPath !== targetFolder) {
						await this.app.fileManager.renameFile(archivedFolder, targetFolder);
						moved += 1;
					}
				}
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
			const rawTodoistId = frontmatter[p.todoistId];
			const todoistId =
				typeof rawTodoistId === 'string' ? rawTodoistId.trim() :
				typeof rawTodoistId === 'number' ? String(rawTodoistId) :
				'';
			if (!isTruthy(todoistSync) || todoistId) {
				continue;
			}

			// Skip notes that already have a pending Todoist ID — a previous create was dispatched
			// but the sync crashed before markLocalCreateSynced() ran. Exclude them from another
			// create attempt; they will be recovered when the full import syncs them back.
			const pendingId = frontmatter[p.todoistPendingId];
			if (typeof pendingId === 'string' && pendingId.trim()) {
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
			// Clear the pending ID guard now that the create is confirmed
			delete data[p.todoistPendingId];
			data[p.todoistLastImportedAt] = new Date().toISOString();
		});
	}

	async markCreateDispatched(file: TFile, pendingTodoistId: string): Promise<void> {
		const p = getPropNames(this.settings);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			(frontmatter as Record<string, unknown>)[p.todoistPendingId] = pendingTodoistId;
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

	async recordRecurringCompletion(file: TFile, completedDate: string): Promise<void> {
		const p = getPropNames(this.settings);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			const existing = Array.isArray(data[p.completeInstances])
				? (data[p.completeInstances] as unknown[]).filter((x): x is string => typeof x === 'string')
				: [];
			if (!existing.includes(completedDate)) {
				data[p.completeInstances] = [...existing, completedDate];
			}
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
		const filePath = await this.getUniqueTaskFilePath(
			item.content,
			item.id,
			projectName,
			sectionName,
			item.project_id,
			item.section_id ?? undefined,
			maps.projectNameById,
			maps.projectParentIdById ?? new Map(),
			maps.sectionProjectIdById ?? new Map(),
			maps.sectionNameById,
		);
		const markdown = buildNewFileContent(item, maps, this.settings);
		const file = await this.app.vault.create(filePath, markdown);
		// When a template is used, hydrate all required frontmatter properties.
		// The template provides layout/body structure; hydration ensures all sync-critical
		// properties are correctly set (including wikilinks and signatures not available as tokens).
		if (this.settings.noteTemplate?.trim()) {
			await this.hydrateTaskNoteFrontmatter(file, item, maps);
		}
		return { created: 1, updated: 0, file };
	}

	private async hydrateTaskNoteFrontmatter(file: TFile, item: TodoistItem, maps: ProjectSectionMaps): Promise<void> {
		const now = new Date();
		const p = getPropNames(this.settings);
		const defaultTag = getDefaultTaskTag(this.settings) ?? 'tasks';
		const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
		const sectionName = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
		const projectLink = maps.projectFileById?.get(item.project_id)
			? toWikiLink(maps.projectFileById.get(item.project_id)!.path)
			: '';
		const sectionLink = item.section_id && maps.sectionFileById?.get(item.section_id)
			? toWikiLink(maps.sectionFileById.get(item.section_id)!.path)
			: '';
		const description = item.description?.trim() ?? '';
		const todoistUrl = buildTodoistUrl(item.id, this.settings);
		const dueDate = item.due?.date ?? '';
		const deadlineDate = item.deadline?.date ?? '';
		const priority = item.priority ?? 1;
		const createdDateStr = formatCreatedDate(now);
		const recurrenceStr = item.due?.is_recurring && dueDate && item.due.string
			? buildRecurrenceString(item.due.string, dueDate)
			: null;
		const remoteImportSig = buildRemoteImportSignature(item, maps);
		const syncedSig = buildTodoistSyncSignature({
			title: item.content,
			description,
			isDone: Boolean(item.checked),
			isRecurring: Boolean(item.due?.is_recurring),
			projectId: item.project_id,
			sectionId: item.section_id ?? undefined,
			dueDate,
			dueString: item.due?.string ?? '',
		});

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;

			// vault_id: always generate fresh UUID for each new note
			data[p.vaultId] = generateUuid();

			// Fill in if missing or empty — template may have used tokens like {{created}}
			if (!data[p.created]) data[p.created] = createdDateStr;
			if (!data[p.modified]) data[p.modified] = formatModifiedDate(now);
			const existingTags = data[p.tags];
			if (!existingTags || (Array.isArray(existingTags) && (existingTags as unknown[]).length === 0)) {
				data[p.tags] = [defaultTag];
			}

			// Task fields: always set to reflect Todoist truth
			setTaskTitle(data, item.content, this.settings);
			setTaskStatus(data, item.checked ? 'done' : 'open', this.settings);

			// All Todoist sync properties: always overwrite
			data[p.todoistSync] = true;
			data[p.todoistSyncStatus] = 'synced';
			data[p.todoistId] = item.id;
			data[p.todoistProjectId] = item.project_id;
			data[p.todoistProjectName] = projectName;
			data[p.todoistSectionId] = item.section_id ?? '';
			data[p.todoistSectionName] = sectionName;
			data[p.todoistProjectLink] = projectLink;
			data[p.todoistSectionLink] = sectionLink;
			data[p.todoistPriority] = priority;
			data[p.todoistPriorityLabel] = priorityLabel(priority);
			data[p.todoistDue] = dueDate;
			data[p.todoistDueString] = item.due?.string ?? '';
			data[p.todoistIsRecurring] = Boolean(item.due?.is_recurring);
			if (recurrenceStr) {
				data[p.recurrence] = recurrenceStr;
			} else {
				data[p.recurrence] = null;
			}
			data[p.todoistDeadline] = deadlineDate || null;
			data[p.todoistDescription] = description;
			data[p.todoistUrl] = todoistUrl;
			data[p.todoistLabels] = item.labels ?? [];
			data[p.todoistParentId] = item.parent_id ?? '';
			data[p.todoistHasChildren] = false;
			data[p.todoistChildTaskCount] = 0;
			data[p.todoistChildTasks] = [];
			data[p.todoistLastImportedSignature] = remoteImportSig;
			data[p.todoistLastSyncedSignature] = syncedSig;
			data[p.todoistLastImportedAt] = new Date().toISOString();
		});
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
			// Even when the import signature matches, project/section wikilinks may be stale
			// if project/section notes were created after the task was first synced.
			const projectLink = maps.projectFileById?.get(item.project_id)
				? toWikiLink(maps.projectFileById.get(item.project_id)!.path)
				: '';
			const sectionLink = item.section_id && maps.sectionFileById?.get(item.section_id)
				? toWikiLink(maps.sectionFileById.get(item.section_id)!.path)
				: '';
			const cachedProjectLink = typeof cachedFrontmatter?.[p.todoistProjectLink] === 'string'
				? cachedFrontmatter[p.todoistProjectLink] as string
				: '';
			const cachedSectionLink = typeof cachedFrontmatter?.[p.todoistSectionLink] === 'string'
				? cachedFrontmatter[p.todoistSectionLink] as string
				: '';
			if (projectLink !== cachedProjectLink || sectionLink !== cachedSectionLink) {
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					const data = frontmatter as Record<string, unknown>;
					data[p.todoistProjectLink] = projectLink;
					data[p.todoistSectionLink] = sectionLink;
				});
			}
			return { created: 0, updated: 0, file };
		}

		// Conflict resolution: if the file has local unsent changes and local-wins is set,
		// skip user-editable fields but still write project/section metadata from Todoist.
		const syncStatus = typeof cachedFrontmatter?.[p.todoistSyncStatus] === 'string'
			? cachedFrontmatter[p.todoistSyncStatus] as string
			: '';
		const localWins = syncStatus === 'dirty_local' && this.settings.conflictResolution === 'local-wins';

		const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
		const sectionName = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
		const projectLink = maps.projectFileById?.get(item.project_id)
			? toWikiLink(maps.projectFileById.get(item.project_id)!.path)
			: '';
		const sectionLink = item.section_id && maps.sectionFileById?.get(item.section_id)
			? toWikiLink(maps.sectionFileById.get(item.section_id)!.path)
			: '';
		const dueDate = item.due?.date ?? '';
		const deadlineDate = item.deadline?.date ?? '';
		const priority = item.priority ?? 1;
		const recurrenceStr = item.due?.is_recurring && dueDate && item.due.string
			? buildRecurrenceString(item.due.string, dueDate)
			: null;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			applyStandardTaskFrontmatter(data, this.settings);

			// Always write project/section metadata — these come from Todoist, not local edits.
			data[p.todoistSync] = true;
			data[p.todoistId] = item.id;
			data[p.todoistProjectId] = item.project_id;
			data[p.todoistProjectName] = projectName;
			data[p.todoistSectionId] = item.section_id ?? '';
			data[p.todoistSectionName] = sectionName;
			data[p.todoistProjectLink] = projectLink;
			data[p.todoistSectionLink] = sectionLink;
			data[p.todoistLabels] = item.labels ?? [];
			data[p.todoistParentId] = item.parent_id ?? '';
			// Clear the parent wiki-link when the task no longer has a parent;
			// applyParentLinks will re-set it for tasks that still have one.
			if (!item.parent_id) {
				data[p.parentTask] = '';
			}
			data[p.todoistUrl] = buildTodoistUrl(item.id, this.settings);
			// Clear any pending ID guard — recovery path when import catches the task
			// before markLocalCreateSynced() ran after a crashed sync.
			if (p.todoistPendingId in data) {
				delete data[p.todoistPendingId];
			}
			data[p.todoistLastImportedAt] = new Date().toISOString();

			if (localWins) {
				// Local wins: preserve user-editable fields (title, status, description, priority, due).
				// Update the import signature so this partial metadata write is not re-applied every sync.
				data[p.todoistLastImportedSignature] = remoteImportSignature;
				return;
			}

			// Remote wins (or no local changes): apply all remote fields.
			touchModifiedDate(data, this.settings);
			setTaskTitle(data, item.content, this.settings);
			setTaskStatus(data, item.checked ? 'done' : 'open', this.settings);
			data[p.todoistPriority] = priority;
			data[p.todoistPriorityLabel] = priorityLabel(priority);

				// Detect Todoist-side recurring completion: the due date has advanced
			// while the task is still recurring, meaning an instance was completed
			// in Todoist. Record the old due date in complete_instances before
			// overwriting it with the new occurrence date.
			if (item.due?.is_recurring && dueDate) {
				const rawOldDue = data[p.todoistDue];
				const oldDue = typeof rawOldDue === 'string'
					? rawOldDue.trim()
					: rawOldDue instanceof Date
						? rawOldDue.toISOString().split('T')[0]
						: '';
				if (oldDue && oldDue !== dueDate && oldDue < dueDate) {
					const existing = Array.isArray(data[p.completeInstances])
						? (data[p.completeInstances] as unknown[]).filter((x): x is string => typeof x === 'string')
						: [];
					if (!existing.includes(oldDue)) {
						data[p.completeInstances] = [...existing, oldDue];
					}
				}
			}

			data[p.todoistDue] = dueDate;
			data[p.todoistDueString] = item.due?.string ?? '';
			data[p.todoistIsRecurring] = Boolean(item.due?.is_recurring);

			// DTSTART is written once on first creation and never changed —
			// TaskNotes uses it to know when the recurrence originated.
			// Only clear it when the task stops being recurring.
			if (!item.due?.is_recurring) {
				data[p.recurrence] = null;
			} else if (!data[p.recurrence]) {
				data[p.recurrence] = recurrenceStr ?? null;
			}
			data[p.todoistDeadline] = deadlineDate || null;
			data[p.todoistDescription] = item.description?.trim() ?? '';
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
			data[p.todoistSyncStatus] = 'synced';
			if (p.todoistSyncStatus !== 'sync_status' && 'sync_status' in data) {
				delete data.sync_status;
			}
		});

		// Note: body content is intentionally NOT updated from Todoist description.
		// The description is stored in the todoist_description frontmatter property instead.
		// The note body is the user's personal notes area.

		const renamedFile = await this.relocateTaskFileIfNeeded(
			file,
			item.content,
			projectName,
			sectionName,
			item.project_id,
			item.section_id ?? undefined,
			maps.projectNameById,
			maps.projectParentIdById ?? new Map(),
			maps.sectionProjectIdById ?? new Map(),
			maps.sectionNameById,
		);

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

			// Skip files in terminal sync states — they're no longer actively synced and
			// modifying them on every sync run can trigger Obsidian rendering errors.
			const fileSyncStatus = typeof frontmatter?.[p.todoistSyncStatus] === 'string'
				? frontmatter[p.todoistSyncStatus] as string
				: '';
			if (fileSyncStatus === 'archived_remote' || fileSyncStatus === 'deleted_remote') {
				continue;
			}

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

	private async applyParentProjectLinks(
		projectFileById: Map<string, TFile>,
		projectParentIdById: Map<string, string | null>,
		projectNameById: Map<string, string>,
	): Promise<void> {
		const p = getPropNames(this.settings);
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
			const parentName = projectNameById.get(parentId) ?? '';
			const frontmatter = this.app.metadataCache.getFileCache(projectFile)?.frontmatter as Record<string, unknown> | undefined;
			const existingLink = typeof frontmatter?.[p.todoistParentProjectLink] === 'string' ? frontmatter[p.todoistParentProjectLink] : '';
			const existingName = typeof frontmatter?.[p.todoistParentProjectName] === 'string' ? frontmatter[p.todoistParentProjectName] : '';
			if (existingLink === parentLink && existingName === parentName) {
				continue;
			}
			await this.app.fileManager.processFrontMatter(projectFile, (fm) => {
				(fm as Record<string, unknown>)[p.todoistParentProjectLink] = parentLink;
				(fm as Record<string, unknown>)[p.todoistParentProjectName] = parentName;
			});
		}
	}

	private buildVaultIndexes(): {
		taskIndex: Map<string, TFile>;
		projectIndex: Map<string, TFile>;
		sectionIndex: Map<string, TFile>;
		vaultIdIndex: Map<string, TFile>;
		duplicateTaskIds: Set<string>;
	} {
		const taskIndex = new Map<string, TFile>();
		const projectIndex = new Map<string, TFile>();
		const sectionIndex = new Map<string, TFile>();
		const vaultIdIndex = new Map<string, TFile>();
		const duplicateTaskIds = new Set<string>();
		const p = getPropNames(this.settings);

		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				continue;
			}

			// Task index: by todoist_id (vault-wide, not restricted to tasksFolderPath)
			const rawId = fm[p.todoistId];
			let taskId: string | null = null;
			if (typeof rawId === 'string' && rawId.trim()) {
				taskId = rawId.trim();
			} else if (typeof rawId === 'number') {
				taskId = String(rawId);
			}
			if (taskId) {
				if (taskIndex.has(taskId)) {
					duplicateTaskIds.add(taskId);
				} else {
					taskIndex.set(taskId, file);
				}
			}

			// Project/section indexes: only index project/section notes (not task notes).
			// Task notes have todoist_id set; project and section notes never do.
			// Backward-compat dual-read: old notes use 'project_id'/'section_id' keys.
			//
			// IMPORTANT: A note with a section ID is a section note — index it ONLY in
			// sectionIndex, even if it also has a project ID. Without this guard, section
			// notes (which store todoist_project_id for the parent project link) would also
			// appear in projectIndex, causing tasks to link to section notes instead of
			// their parent project notes ("sections linked in place of projects").
			if (!taskId) {
				const rawSectionId =
					fm[p.todoistSectionId] ??
					(p.todoistSectionId !== 'section_id' ? fm['section_id'] : undefined);
				if (typeof rawSectionId === 'string' && rawSectionId.trim()) {
					// Section note — only add to section index
					sectionIndex.set(rawSectionId.trim(), file);
				} else {
					// No section ID — may be a project note
					const rawProjectId =
						fm[p.todoistProjectId] ??
						(p.todoistProjectId !== 'project_id' ? fm['project_id'] : undefined);
					if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
						projectIndex.set(rawProjectId.trim(), file);
					}
				}
			}

			// Vault ID index: by vault_id frontmatter
			const rawVaultId = fm[p.vaultId];
			if (typeof rawVaultId === 'string' && rawVaultId.trim()) {
				vaultIdIndex.set(rawVaultId.trim(), file);
			}
		}

		return { taskIndex, projectIndex, sectionIndex, vaultIdIndex, duplicateTaskIds };
	}

	async backfillVaultIds(): Promise<number> {
		const p = getPropNames(this.settings);
		let backfilled = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				continue;
			}

			// Skip notes with no plugin ID — not managed by this plugin
			const hasTodoistId = (typeof fm[p.todoistId] === 'string' && (fm[p.todoistId] as string).trim())
				|| typeof fm[p.todoistId] === 'number';
			const rawProjectId =
				fm[p.todoistProjectId] ??
				(p.todoistProjectId !== 'project_id' ? fm['project_id'] : undefined);
			const hasProjectId = typeof rawProjectId === 'string' && rawProjectId.trim();
			const rawSectionId =
				fm[p.todoistSectionId] ??
				(p.todoistSectionId !== 'section_id' ? fm['section_id'] : undefined);
			const hasSectionId = typeof rawSectionId === 'string' && rawSectionId.trim();
			if (!hasTodoistId && !hasProjectId && !hasSectionId) {
				continue;
			}

			// Skip notes that already have vault_id
			const existingVaultId = fm[p.vaultId];
			if (typeof existingVaultId === 'string' && existingVaultId.trim()) {
				continue;
			}

			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				(frontmatter as Record<string, unknown>)[p.vaultId] = generateUuid();
			});
			backfilled += 1;
		}
		return backfilled;
	}

	private emitDuplicateIdWarnings(dupes: Set<string>): void {
		if (dupes.size === 0) {
			return;
		}
		const ids = Array.from(dupes).join(', ');
		console.warn(`[obsidian-task-todoist] Duplicate todoist_id values detected in vault: ${ids}`);
		new Notice(
			`Task Todoist: ${dupes.size} duplicate todoist_id(s) found in vault. Check console for details.`,
			8000,
		);
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
		projectName: string | undefined,
		sectionName: string | undefined,
		projectId: string | undefined,
		sectionId: string | undefined,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<TFile> {
		const desiredFolder = await this.getDesiredFolderPath(
			projectName,
			sectionName,
			projectId,
			sectionId,
			projectNameById,
			projectParentIdById,
			sectionProjectIdById,
			sectionNameById,
		);
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

	private async getDesiredFolderPath(
		projectName: string | undefined,
		sectionName: string | undefined,
		projectId: string | undefined,
		sectionId: string | undefined,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<string> {
		const resolvedFolder = resolveTemplateVars(this.settings.tasksFolderPath);
		let folder = normalizePath(resolvedFolder);

		if (this.settings.useProjectSubfolders && projectId && projectNameById.size > 0) {
			const segments = buildProjectFolderSegments(projectId, projectNameById, projectParentIdById);
			if (segments.length > 0) {
				folder = normalizePath([resolvedFolder, ...segments].join('/'));
				await this.ensureFolderExists(folder);

				if (this.settings.useSectionSubfolders && sectionId && sectionNameById.size > 0) {
					const sName = sectionNameById.get(sectionId) ?? sectionName ?? '';
					const sanitizedSection = buildSanitizedSectionFolderName(sectionId, sName, projectId, sectionNameById, sectionProjectIdById);
					if (sanitizedSection) {
						folder = normalizePath(`${folder}/${sanitizedSection}`);
						await this.ensureFolderExists(folder);
					}
				}
			}
		} else if (this.settings.useProjectSubfolders && projectName?.trim()) {
			// Fallback when no ID maps available (e.g. manual create path)
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

	private async getUniqueTaskFilePath(
		taskTitle: string,
		todoistId: string,
		projectName: string | undefined,
		sectionName: string | undefined,
		projectId: string | undefined,
		sectionId: string | undefined,
		projectNameById: Map<string, string>,
		projectParentIdById: Map<string, string | null>,
		sectionProjectIdById: Map<string, string>,
		sectionNameById: Map<string, string>,
	): Promise<string> {
		const folder = await this.getDesiredFolderPath(
			projectName,
			sectionName,
			projectId,
			sectionId,
			projectNameById,
			projectParentIdById,
			sectionProjectIdById,
			sectionNameById,
		);
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
	maps: ProjectSectionMaps,
	settings: TaskTodoistSettings,
): string {
	const now = new Date();
	const defaultTag = getDefaultTaskTag(settings) ?? 'tasks';
	const p = getPropNames(settings);
	const projectName = maps.projectNameById.get(item.project_id) ?? 'Unknown';
	const sectionName = item.section_id ? (maps.sectionNameById.get(item.section_id) ?? '') : '';
	const projectLink = maps.projectFileById?.get(item.project_id)
		? toWikiLink(maps.projectFileById.get(item.project_id)!.path)
		: '';
	const sectionLink = item.section_id && maps.sectionFileById?.get(item.section_id)
		? toWikiLink(maps.sectionFileById.get(item.section_id)!.path)
		: '';
	const description = item.description?.trim() ?? '';
	const todoistUrl = buildTodoistUrl(item.id, settings);
	const dueDate = item.due?.date ?? '';
	const deadlineDate = item.deadline?.date ?? '';
	const priority = item.priority ?? 1;
	const createdDateStr = formatCreatedDate(now);
	const recurrenceStr = item.due?.is_recurring && dueDate && item.due.string
		? buildRecurrenceString(item.due.string, dueDate)
		: null;

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
			project_link: projectLink,
			section_link: sectionLink,
		};
		return resolveTemplateVars(settings.noteTemplate, now, context);
	}

	const yaml = [
		'---',
		`${p.vaultId}: "${generateUuid()}"`,
		`${p.taskStatus}: ${item.checked ? 'Done' : 'Open'}`,
		`${p.taskDone}: ${item.checked ? 'true' : 'false'}`,
		`${p.created}: "${createdDateStr}"`,
		`${p.modified}: "${formatModifiedDate(now)}"`,
		`${p.tags}:`,
		`  - ${defaultTag}`,
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
		`${p.todoistDueString}: "${escapeDoubleQuotes(item.due?.string ?? '')}"`,
		`${p.todoistIsRecurring}: ${item.due?.is_recurring ? 'true' : 'false'}`,
		...(recurrenceStr ? [`${p.recurrence}: ${toQuotedYaml(recurrenceStr)}`] : []),
		`${p.todoistDeadline}: ${deadlineDate ? toQuotedYaml(deadlineDate) : 'null'}`,
		`${p.todoistDescription}: ${toQuotedYaml(description)}`,
		`${p.todoistUrl}: "${escapeDoubleQuotes(todoistUrl)}"`,
		`${p.todoistProjectLink}: ${toQuotedYaml(projectLink)}`,
		`${p.todoistSectionLink}: ${toQuotedYaml(sectionLink)}`,
		`${p.todoistLastImportedSignature}: "${escapeDoubleQuotes(buildRemoteImportSignature(item, maps))}"`,
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
	const pathWithoutExt = filePath.replace(/\.md$/i, '');
	const displayText = pathWithoutExt.split('/').pop() || pathWithoutExt;
	return `[[${pathWithoutExt}|${displayText}]]`;
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
