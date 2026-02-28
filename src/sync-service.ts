import { TaskNoteRepository, type SyncedTaskEntry, type MissingTaskEntry } from './task-note-repository';
import type { TaskTodoistSettings } from './settings';
import { filterImportableItems } from './import-rules';
import { TodoistClient } from './todoist-client';
import type { TodoistItem } from './todoist-client';
import type { App } from 'obsidian';
import { syncLinkedChecklistStates } from './linked-checklist-sync';

	export interface SyncRunResult {
	ok: boolean;
	message: string;
	created?: number;
	updated?: number;
	imported?: number;
	missingHandled?: number;
	pushedUpdates?: number;
	linkedChecklistUpdates?: number;
	syncToken?: string;
}

export class SyncService {
	private readonly app: App;
	private readonly settings: TaskTodoistSettings;
	private readonly token: string;
	private readonly lastSyncToken: string | null;

	constructor(app: App, settings: TaskTodoistSettings, token: string, lastSyncToken: string | null = null) {
		this.app = app;
		this.settings = settings;
		this.token = token;
		this.lastSyncToken = lastSyncToken;
	}

	async runImportSync(): Promise<SyncRunResult> {
		try {
			const todoistClient = new TodoistClient(this.token);
			const repository = new TaskNoteRepository(this.app, this.settings);
			await repository.repairMalformedSignatureFrontmatterLines();
			await repository.backfillVaultIds();

			// Deletion check via Activities API: fetch the most recently deleted item IDs.
			// Both deleted and completed tasks are absent from the full sync response,
			// so we use the activities log to distinguish true deletions from completions.
			const recentlyDeletedIds = await todoistClient.fetchRecentlyDeletedTaskIds(50);

			let snapshot = await todoistClient.fetchSyncSnapshot();
			const projectIdByName = new Map(snapshot.projects.map((project) => [project.name.toLowerCase(), project.id]));

			const pendingLocalCreates = await repository.listPendingLocalCreates();
			for (const pending of pendingLocalCreates) {
				const resolvedProjectId = resolveProjectId(pending.projectId, pending.projectName, projectIdByName);
				const resolvedSectionId = resolveSectionId(
					pending.sectionId,
					pending.sectionName,
					resolvedProjectId,
					snapshot,
				);
				const dueDate = pending.dueDate?.trim() || undefined;
				const dueString = pending.dueString?.trim() || undefined;
				const createDeadline = pending.deadline?.trim() || undefined;
				const createdTodoistId = await todoistClient.createTask({
					content: pending.title,
					description: pending.description,
					projectId: resolvedProjectId,
					sectionId: resolvedSectionId,
					priority: pending.priority,
					labels: pending.labels,
					dueDate,
					dueString,
					deadline: createDeadline,
					duration: pending.duration,
				});
				// Write the pending ID immediately so a crash before markLocalCreateSynced()
				// does not cause a duplicate task on the next sync run.
				await repository.markCreateDispatched(pending.file, createdTodoistId);
				if (pending.isDone) {
					await todoistClient.updateTask({
						id: createdTodoistId,
						content: pending.title,
						description: pending.description,
						isDone: true,
						projectId: resolvedProjectId,
						sectionId: resolvedSectionId,
						dueDate,
						dueString,
					});
				}
				await repository.markLocalCreateSynced(pending.file, createdTodoistId, pending.syncSignature);
			}

			const pendingLocalUpdates = await repository.listPendingLocalUpdates();
			for (const pending of pendingLocalUpdates) {
				const resolvedProjectId = resolveProjectId(pending.projectId, pending.projectName, projectIdByName);
				const resolvedSectionId = resolveSectionId(
					pending.sectionId,
					pending.sectionName,
					resolvedProjectId,
					snapshot,
				);
				const dueDate = pending.dueDate?.trim() || undefined;
				const dueString = pending.dueString?.trim() || undefined;
				const deadline = pending.deadline?.trim() || undefined;
				await todoistClient.updateTask({
					id: pending.todoistId,
					content: pending.title,
					description: pending.description,
					isDone: pending.isDone,
					isRecurring: pending.isRecurring,
					projectId: resolvedProjectId,
					sectionId: resolvedSectionId,
					priority: pending.priority,
					labels: pending.labels,
					dueDate,
					dueString,
					clearDue: !dueDate && !dueString,
					deadline,
					clearDeadline: !deadline,
					duration: pending.duration,
					clearDuration: pending.duration === undefined || pending.duration === null,
				});
				await repository.markLocalUpdateSynced(pending.file, pending.syncSignature);
				// Record the completed instance date for recurring tasks so TaskNotes
				// can track which occurrences have been checked off.
				if (pending.isDone && pending.isRecurring && pending.dueDate) {
					await repository.recordRecurringCompletion(pending.file, pending.dueDate);
				}
				await repository.renameTaskFileToMatchTitle(pending.file, pending.title);
			}

			snapshot = await todoistClient.fetchSyncSnapshot();
			const activeItemById = new Map<string, TodoistItem>(snapshot.items.map((item) => [item.id, item]));

			const sectionNameById = new Map(snapshot.sections.map((section) => [section.id, section.name]));
			const sectionProjectIdById = new Map(snapshot.sections.map((section) => [section.id, section.project_id]));
			const importableItems = filterImportableItems(
				snapshot.items,
				snapshot.projects,
				this.settings,
				snapshot.userId,
				sectionNameById,
			);
			const importableWithAncestors = includeAncestorTasks(importableItems, snapshot.items);

			const projectNameById = new Map(snapshot.projects.map((project) => [project.id, project.name]));
			const projectParentIdById = new Map(snapshot.projects.map((project) => [project.id, project.parent_id]));
			const projectColorById = new Map(snapshot.projects.map((project) => [project.id, project.color]));

			const existingSyncedTasks = await repository.listSyncedTasks();

			const itemsToUpsertById = new Map(importableWithAncestors.filter((item) => !item.is_deleted).map((item) => [item.id, item]));
			for (const entry of existingSyncedTasks) {
				const remoteItem = activeItemById.get(entry.todoistId);
				if (remoteItem && !remoteItem.is_deleted) {
					itemsToUpsertById.set(remoteItem.id, remoteItem);
				}
			}

			const taskResult = await repository.syncItems(Array.from(itemsToUpsertById.values()), {
				projectNameById,
				sectionNameById,
				sectionProjectIdById,
				projectParentIdById,
				projectColorById,
				allProjects: snapshot.projects.filter((p) => !p.is_archived),
				allSections: snapshot.sections.filter((s) => !s.is_archived),
			});

			const missingEntries = findMissingEntries(existingSyncedTasks, activeItemById, recentlyDeletedIds);
			const missingHandled = await repository.applyMissingRemoteTasks(missingEntries);

			// Create Todoist tasks for project notes that are pending task creation
			let projectTasksCreated = 0;
			if (this.settings.createProjectTasks) {
				const pendingProjectTasks = await repository.listPendingProjectTaskCreates();
				for (const pending of pendingProjectTasks) {
					const dueDate = pending.dueDate?.trim() || undefined;
					const dueString = pending.dueString?.trim() || undefined;
					const deadline = pending.deadline?.trim() || undefined;
					const vaultName = encodeURIComponent(this.app.vault.getName());
					const filePath = encodeURIComponent(pending.file.path);
					const obsidianUri = `obsidian://open?vault=${vaultName}&file=${filePath}`;
					const createdTaskId = await todoistClient.createTask({
						content: `${pending.projectName} [note](${obsidianUri})`,
						description: pending.description || undefined,
						projectId: pending.projectId,
						priority: pending.priority,
						labels: pending.labels,
						dueDate,
						dueString,
						deadline,
						duration: pending.duration,
					});
					await repository.markProjectTaskCreated(pending.file, createdTaskId);
					projectTasksCreated += 1;
				}
			}

			const archivedProjects = snapshot.projects.filter((p) => p.is_archived);
			const archivedSections = snapshot.sections.filter((s) => s.is_archived);
			const unarchivedProjects = snapshot.projects.filter((p) => !p.is_archived);
			const unarchivedSections = snapshot.sections.filter((s) => !s.is_archived);
			await repository.applyArchivedProjectsAndSections(archivedProjects, archivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);
			await repository.applyUnarchivedProjectsAndSections(unarchivedProjects, unarchivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);

			const linkedChecklistUpdates = await syncLinkedChecklistStates(this.app, this.settings);

			const ancestorCount = importableWithAncestors.length - importableItems.length;
			const projectTaskMsg = projectTasksCreated > 0 ? `, ${projectTasksCreated} project task(s) created` : '';
			const message = `Synced ${importableItems.length} importable task(s) (+${ancestorCount} ancestors): ${pendingLocalCreates.length} created remotely, ${pendingLocalUpdates.length} updates pushed, ${taskResult.created} created, ${taskResult.updated} updated, ${missingHandled} missing handled, ${linkedChecklistUpdates} checklist lines refreshed${projectTaskMsg}.`;
			return {
				ok: true,
				message,
				imported: importableWithAncestors.length,
				created: taskResult.created,
				updated: taskResult.updated,
				missingHandled,
				pushedUpdates: pendingLocalUpdates.length,
				linkedChecklistUpdates,
				syncToken: snapshot.syncToken || undefined,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown sync error';
			return {
				ok: false,
				message: `Todoist sync failed: ${message}`,
			};
		}
	}
}

function findMissingEntries(
	existingSyncedTasks: SyncedTaskEntry[],
	activeItemById: Map<string, TodoistItem>,
	recentlyDeletedIds: Set<string>,
): MissingTaskEntry[] {
	const result: MissingTaskEntry[] = [];
	for (const entry of existingSyncedTasks) {
		const remoteItem = activeItemById.get(entry.todoistId);
		if (!remoteItem || remoteItem.is_deleted) {
			// Full sync only returns active items — both completed and deleted tasks are absent.
			// We detect true deletions via an incremental sync (recentlyDeletedIds) run before
			// the full sync; absent items not in that set are treated as completed.
			const isDeletedRemote = Boolean(remoteItem?.is_deleted) || recentlyDeletedIds.has(entry.todoistId);
			result.push({ ...entry, isDeletedRemote });
		}
	}
	return result;
}

function includeAncestorTasks(
	baseItems: TodoistItem[],
	allItems: TodoistItem[],
): TodoistItem[] {
	const allById = new Map(allItems.map((item) => [item.id, item]));
	const selectedById = new Map(baseItems.map((item) => [item.id, item]));

	for (const item of baseItems) {
		let parentId = item.parent_id ?? null;
		const seen = new Set<string>();
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = allById.get(parentId);
			if (!parent) {
				break;
			}
			selectedById.set(parent.id, parent);
			parentId = parent.parent_id ?? null;
		}
	}

	return Array.from(selectedById.values());
}

function resolveProjectId(
	projectId: string | undefined,
	projectName: string | undefined,
	projectIdByName: Map<string, string>,
): string | undefined {
	if (projectId?.trim()) {
		return projectId.trim();
	}
	if (!projectName?.trim()) {
		return undefined;
	}
	return projectIdByName.get(projectName.trim().toLowerCase());
}

function resolveSectionId(
	sectionId: string | undefined,
	sectionName: string | undefined,
	projectId: string | undefined,
	snapshot: { sections: Array<{ id: string; name: string; project_id: string }> },
): string | undefined {
	if (sectionId?.trim()) {
		return sectionId.trim();
	}
	if (!sectionName?.trim() || !projectId) {
		return undefined;
	}
	const section = snapshot.sections.find(
		(item) => item.project_id === projectId && item.name.toLowerCase() === sectionName.trim().toLowerCase(),
	);
	return section?.id;
}
