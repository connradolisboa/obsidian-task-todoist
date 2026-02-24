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
}

export class SyncService {
	private readonly app: App;
	private readonly settings: TaskTodoistSettings;
	private readonly token: string;

	constructor(app: App, settings: TaskTodoistSettings, token: string) {
		this.app = app;
		this.settings = settings;
		this.token = token;
	}

	async runImportSync(): Promise<SyncRunResult> {
		try {
			const todoistClient = new TodoistClient(this.token);
			const repository = new TaskNoteRepository(this.app, this.settings);
			await repository.repairMalformedSignatureFrontmatterLines();
			await repository.backfillVaultIds();
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
				const createdTodoistId = await todoistClient.createTask({
					content: pending.title,
					description: pending.description,
					projectId: resolvedProjectId,
					sectionId: resolvedSectionId,
					priority: pending.priority,
					labels: pending.labels,
					dueDate,
					dueString,
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
				await todoistClient.updateTask({
					id: pending.todoistId,
					content: pending.title,
					description: pending.description,
					isDone: pending.isDone,
					isRecurring: pending.isRecurring,
					projectId: resolvedProjectId,
					sectionId: resolvedSectionId,
					dueDate,
					dueString,
					clearDue: !dueDate && !dueString,
				});
				await repository.markLocalUpdateSynced(pending.file, pending.syncSignature);
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
				allProjects: snapshot.projects.filter((p) => !p.is_archived),
				allSections: snapshot.sections.filter((s) => !s.is_archived),
			});

			const missingEntries = findMissingEntries(existingSyncedTasks, activeItemById);
			const missingHandled = await repository.applyMissingRemoteTasks(missingEntries, this.settings.archiveMode);

			const archivedProjects = snapshot.projects.filter((p) => p.is_archived);
			const archivedSections = snapshot.sections.filter((s) => s.is_archived);
			const unarchivedProjects = snapshot.projects.filter((p) => !p.is_archived);
			const unarchivedSections = snapshot.sections.filter((s) => !s.is_archived);
			await repository.applyArchivedProjectsAndSections(archivedProjects, archivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);
			await repository.applyUnarchivedProjectsAndSections(unarchivedProjects, unarchivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);

			const linkedChecklistUpdates = await syncLinkedChecklistStates(this.app, this.settings);

			const ancestorCount = importableWithAncestors.length - importableItems.length;
			const message = `Synced ${importableItems.length} importable task(s) (+${ancestorCount} ancestors): ${pendingLocalCreates.length} created remotely, ${pendingLocalUpdates.length} updates pushed, ${taskResult.created} created, ${taskResult.updated} updated, ${missingHandled} missing handled, ${linkedChecklistUpdates} checklist lines refreshed.`;
			return {
				ok: true,
				message,
				imported: importableWithAncestors.length,
				created: taskResult.created,
				updated: taskResult.updated,
				missingHandled,
				pushedUpdates: pendingLocalUpdates.length,
				linkedChecklistUpdates,
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
): MissingTaskEntry[] {
	const result: MissingTaskEntry[] = [];
	for (const entry of existingSyncedTasks) {
		const remoteItem = activeItemById.get(entry.todoistId);
		if (!remoteItem || remoteItem.is_deleted) {
			// The sync always uses sync_token='*' (full sync), so deleted tasks are
			// simply absent from the response rather than returned with is_deleted:true.
			// Any task missing from the full snapshot is definitively deleted on Todoist.
			result.push({ ...entry, isDeletedRemote: !remoteItem || Boolean(remoteItem.is_deleted) });
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
