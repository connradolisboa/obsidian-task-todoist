import { TaskNoteRepository, type SyncedTaskEntry, type MissingTaskEntry, type ActiveNoteTaskEntry } from './task-note-repository';
import type { TaskTodoistSettings } from './settings';
import { getPropNames } from './task-frontmatter';
import { filterImportableItems } from './import-rules';
import { TodoistClient } from './todoist-client';
import type { TodoistItem, TodoistSyncSnapshot } from './todoist-client';
import type { App } from 'obsidian';
import { syncLinkedChecklistStates } from './linked-checklist-sync';
import { type VaultIndex, buildVaultIndexSnapshot } from './vault-index';

	export interface SyncRunResult {
	ok: boolean;
	message: string;
	shortMessage?: string;
	created?: number;
	updated?: number;
	imported?: number;
	missingHandled?: number;
	pushedUpdates?: number;
	linkedChecklistUpdates?: number;
	syncToken?: string;
	phaseErrors?: string[];
}

export class SyncService {
	private readonly app: App;
	private readonly settings: TaskTodoistSettings;
	private readonly token: string;
	private readonly lastSyncToken: string | null;
	private readonly vaultIndex: VaultIndex | null;

	constructor(app: App, settings: TaskTodoistSettings, token: string, lastSyncToken: string | null = null, vaultIndex: VaultIndex | null = null) {
		this.app = app;
		this.settings = settings;
		this.token = token;
		this.lastSyncToken = lastSyncToken;
		this.vaultIndex = vaultIndex;
	}

	async runImportSync(): Promise<SyncRunResult> {
		const todoistClient = new TodoistClient(this.token);
		const repository = new TaskNoteRepository(this.app, this.settings, this.vaultIndex ?? undefined);
		const phaseErrors: string[] = [];

		// Phase 1: pre-flight repairs (non-critical — failures don't block sync)
		try {
			await repository.repairMalformedSignatureFrontmatterLines();
			await repository.backfillVaultIds();
		} catch (e) {
			phaseErrors.push(`Pre-flight: ${errorMessage(e)}`);
		}

		// Phase 2: fetch recently-deleted IDs (non-critical — fall back to empty set)
		let recentlyDeletedIds = new Set<string>();
		try {
			recentlyDeletedIds = await todoistClient.fetchRecentlyDeletedTaskIds(50);
		} catch (e) {
			phaseErrors.push(`Deleted-IDs fetch: ${errorMessage(e)}`);
		}

		// Phase 3: first snapshot + project lookup (critical — abort if this fails)
		let snapshot: TodoistSyncSnapshot;
		try {
			snapshot = await todoistClient.fetchSyncSnapshot();
		} catch (e) {
			const message = errorMessage(e);
			return { ok: false, message: `Todoist sync failed: ${message}` };
		}
		const projectIdByName = new Map(snapshot.projects.map((project) => [project.name.toLowerCase(), project.id]));

		// Phase 4: push pending local creates (per-item errors are non-critical)
		let pendingLocalCreates: Awaited<ReturnType<typeof repository.listPendingLocalCreates>> = [];
		try {
			pendingLocalCreates = await repository.listPendingLocalCreates();
		} catch (e) {
			phaseErrors.push(`List pending creates: ${errorMessage(e)}`);
		}
		for (const pending of pendingLocalCreates) {
			try {
				const resolvedProjectId = resolveProjectId(pending.projectId, pending.projectName, projectIdByName);
				if (!resolvedProjectId && pending.projectName?.trim()) {
					phaseErrors.push(`Warning: Create "${pending.title}" — project "${pending.projectName}" not found in Todoist`);
				}
				const sectionWarnings: string[] = [];
				const resolvedSectionId = resolveSectionId(
					pending.sectionId,
					pending.sectionName,
					resolvedProjectId,
					snapshot,
					sectionWarnings,
				);
				phaseErrors.push(...sectionWarnings.map((w) => `Create "${pending.title}": ${w}`));
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
			} catch (e) {
				phaseErrors.push(`Create "${pending.title}": ${errorMessage(e)}`);
			}
		}

		// Phase 5: push pending local updates (per-item errors are non-critical)
		let pendingLocalUpdates: Awaited<ReturnType<typeof repository.listPendingLocalUpdates>> = [];
		try {
			pendingLocalUpdates = await repository.listPendingLocalUpdates();
		} catch (e) {
			phaseErrors.push(`List pending updates: ${errorMessage(e)}`);
		}
		for (const pending of pendingLocalUpdates) {
			try {
				const resolvedProjectId = resolveProjectId(pending.projectId, pending.projectName, projectIdByName);
				if (!resolvedProjectId && pending.projectName?.trim()) {
					phaseErrors.push(`Warning: Update "${pending.title}" — project "${pending.projectName}" not found in Todoist`);
				}
				const sectionWarnings: string[] = [];
				const resolvedSectionId = resolveSectionId(
					pending.sectionId,
					pending.sectionName,
					resolvedProjectId,
					snapshot,
					sectionWarnings,
				);
				phaseErrors.push(...sectionWarnings.map((w) => `Update "${pending.title}": ${w}`));
				const dueDate = pending.dueDate?.trim() || undefined;
				const dueString = pending.dueString?.trim() || undefined;
				const deadline = pending.deadline?.trim() || undefined;
				await todoistClient.updateTask({
					id: pending.todoistId,
					// Project task notes are one-way (Obsidian→Todoist): never push the title.
					...(pending.isProjectTask ? {} : { content: pending.title }),
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
				if (!pending.isProjectTask) {
					await repository.renameTaskFileToMatchTitle(pending.file, pending.title);
				}
			} catch (e) {
				phaseErrors.push(`Update "${pending.title}": ${errorMessage(e)}`);
			}
		}

		// Phase 6: second snapshot post-push (critical — abort if this fails)
		try {
			snapshot = await todoistClient.fetchSyncSnapshot();
		} catch (e) {
			const message = errorMessage(e);
			const errorSuffix = phaseErrors.length > 0 ? ` Prior errors: ${phaseErrors.join('; ')}` : '';
			return { ok: false, message: `Todoist sync failed (post-push snapshot): ${message}.${errorSuffix}` };
		}
		const activeItemById = new Map<string, TodoistItem>(snapshot.items.map((item) => [item.id, item]));
		const sectionNameById = new Map(snapshot.sections.map((section) => [section.id, section.name]));
		const sectionProjectIdById = new Map(snapshot.sections.map((section) => [section.id, section.project_id]));
		// Build NoteTask ID set so they are excluded from normal task import
		const noteTaskIds = new Set<string>(
			(this.vaultIndex ? this.vaultIndex.get() : buildVaultIndexSnapshot(this.app, this.settings)).noteTaskIndex.keys()
		);

		const importableItems = filterImportableItems(
			snapshot.items,
			snapshot.projects,
			this.settings,
			snapshot.userId,
			sectionNameById,
			noteTaskIds,
		);
		const importableWithAncestors = includeAncestorTasks(importableItems, snapshot.items);
		const projectNameById = new Map(snapshot.projects.map((project) => [project.id, project.name]));
		const projectParentIdById = new Map(snapshot.projects.map((project) => [project.id, project.parent_id]));
		const projectColorById = new Map(snapshot.projects.map((project) => [project.id, project.color]));

		// Phase 7: import/upsert task notes (non-critical — degraded sync still useful)
		let taskResult = { created: 0, updated: 0 };
		let existingSyncedTasks: SyncedTaskEntry[] = [];
		try {
			existingSyncedTasks = await repository.listSyncedTasks();
			const itemsToUpsertById = new Map(importableWithAncestors.filter((item) => !item.is_deleted).map((item) => [item.id, item]));
			for (const entry of existingSyncedTasks) {
				const remoteItem = activeItemById.get(entry.todoistId);
				if (remoteItem && !remoteItem.is_deleted) {
					itemsToUpsertById.set(remoteItem.id, remoteItem);
				}
			}
			taskResult = await repository.syncItems(Array.from(itemsToUpsertById.values()), {
				projectNameById,
				sectionNameById,
				sectionProjectIdById,
				projectParentIdById,
				projectColorById,
				allProjects: snapshot.projects.filter((p) => !p.is_archived),
				allSections: snapshot.sections.filter((s) => !s.is_archived),
			});
		} catch (e) {
			phaseErrors.push(`Import: ${errorMessage(e)}`);
		}

		// Phase 8: handle missing/deleted remote tasks (non-critical)
		let missingHandled = 0;
		try {
			const missingEntries = findMissingEntries(existingSyncedTasks, activeItemById, recentlyDeletedIds);
			missingHandled = await repository.applyMissingRemoteTasks(missingEntries);
		} catch (e) {
			phaseErrors.push(`Missing tasks: ${errorMessage(e)}`);
		}

		// Phase 8b: detect task notes whose Todoist project no longer exists (non-critical)
		const activeProjectIds = new Set(snapshot.projects.map((proj) => proj.id));
		const orphanedTaskNames: string[] = [];
		try {
			const p = getPropNames(this.settings);
			for (const entry of existingSyncedTasks) {
				const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as Record<string, unknown> | undefined;
				if (!fm) continue;
				const projId = typeof fm[p.todoistProjectId] === 'string' ? (fm[p.todoistProjectId] as string).trim() : '';
				if (projId && !activeProjectIds.has(projId)) {
					orphanedTaskNames.push(entry.file.basename);
				}
			}
			if (orphanedTaskNames.length > 0) {
				const names = orphanedTaskNames.slice(0, 5).join(', ');
				const extra = orphanedTaskNames.length > 5 ? ` …and ${orphanedTaskNames.length - 5} more` : '';
				phaseErrors.push(`Warning: ${orphanedTaskNames.length} task note(s) reference a Todoist project that no longer exists (${names}${extra})`);
			}
		} catch (e) {
			phaseErrors.push(`Orphan check: ${errorMessage(e)}`);
		}

		// Phase 9: create Todoist tasks for pending project notes (non-critical, per-item)
		let projectTasksCreated = 0;
		if (this.settings.createProjectTasks) {
			try {
				const pendingProjectTasks = await repository.listPendingProjectTaskCreates();
				for (const pending of pendingProjectTasks) {
					try {
						const dueDate = pending.dueDate?.trim() || undefined;
						const dueString = pending.dueString?.trim() || undefined;
						const deadline = pending.deadline?.trim() || undefined;
						const vaultName = encodeURIComponent(this.app.vault.getName());
						const filePath = encodeURIComponent(pending.file.path);
						const obsidianUri = `obsidian://open?vault=${vaultName}&file=${filePath}`;
						const createdTaskId = await todoistClient.createTask({
							content: `* ${pending.projectName} [+](${obsidianUri})`,
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
					} catch (e) {
						phaseErrors.push(`Project task "${pending.projectName}": ${errorMessage(e)}`);
					}
				}
			} catch (e) {
				phaseErrors.push(`List project task creates: ${errorMessage(e)}`);
			}
		}

		// Phase 9b: two-way NoteTask sync (non-critical, per-item)
	// Direction rules:
	//   - Obsidian always wins on conflict (modified > noteTaskSyncedAt → push only)
	//   - If note unchanged since last sync → pull due/priority/deadline/description from Todoist
	//   - Completion and deletion are driven by note status settings
	let noteTasksUpdated = 0;
	let noteTasksPulled = 0;
	const todoStatusSet = new Set(
		(this.settings.noteTaskTodoStatuses ?? 'Open,Active,Ongoing,Backlog,Waiting')
			.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
	);
	const doneStatusSet = new Set(
		(this.settings.noteTaskDoneStatuses ?? '')
			.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
	);
	const stopStatusSet = new Set(
		(this.settings.noteTaskStopStatuses ?? '')
			.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
	);
	try {
		const activeNoteTasks = await repository.listActiveNoteTasks();
		for (const entry of activeNoteTasks) {
			try {
				const remoteItem = activeItemById.get(entry.noteTaskId);
				const noteStatusLower = entry.noteStatus.toLowerCase();
				const isStopStatus = stopStatusSet.has(noteStatusLower);
				const isDoneStatus = doneStatusSet.has(noteStatusLower);
				// Anything not explicitly in done or stop is treated as to-do (preserves backwards compat)
				const isTodoStatus = !isDoneStatus && !isStopStatus;

				// Build the Obsidian URI for the push content
				const vaultName = encodeURIComponent(this.app.vault.getName());
				const filePath = encodeURIComponent(entry.file.path);
				const obsidianUri = `obsidian://open?vault=${vaultName}&file=${filePath}`;

				// Resolve section ID for push based on note status (uses remoteItem.project_id when available).
				// Section lookup is best-effort: if the section doesn't exist in this project, skip silently.
				const noteTaskSectionId = entry.sectionName
					? resolveSectionId(undefined, entry.sectionName, remoteItem?.project_id ?? undefined, snapshot)
					: undefined;

				if (!remoteItem || remoteItem.is_deleted) {
					// Task absent from active items — check if deleted vs completed
					const wasDeleted = recentlyDeletedIds.has(entry.noteTaskId);
					if (wasDeleted) {
						// Actually deleted in Todoist → mark note accordingly
						await repository.markNoteTaskDeleted(entry.file);
					} else if (isStopStatus) {
						// Note says stop and task is already gone — just mark stopped
						await repository.markNoteTaskStopped(entry.file);
					} else if (isTodoStatus) {
						// Task was completed in Todoist but note is still open → uncomplete it
						const currentRemoteTitle = remoteItem?.content ?? '';
						const prefix = currentRemoteTitle.startsWith('* ') ? '* ' : '';
						const newContent = `${prefix}${entry.noteTitle} [+](${obsidianUri})`;
						try {
							await todoistClient.updateTask({
								id: entry.noteTaskId,
								content: newContent,
								description: entry.description,
								isDone: false,
								priority: entry.priority,
								labels: entry.labels,
								dueDate: entry.dueDate?.trim(),
								dueString: entry.dueString?.trim(),
								clearDue: !entry.dueDate && !entry.dueString,
								deadline: entry.deadline?.trim(),
								clearDeadline: !entry.deadline,
								sectionId: noteTaskSectionId,
							});
							await repository.markNoteTaskSyncedAt(entry.file);
							noteTasksUpdated += 1;
						} catch {
							// If uncomplete fails (task may truly be gone), mark deleted
							await repository.markNoteTaskDeleted(entry.file);
						}
					} else {
						// isDone: task completed in Todoist and note also in done/stop — sync is settled
						await repository.markNoteTaskSyncedAt(entry.file);
					}
					continue;
				}

				// Task is active in Todoist
				if (isStopStatus) {
					// Note says stop → delete the Todoist task and stop syncing
					await todoistClient.deleteTask(entry.noteTaskId);
					await repository.markNoteTaskStopped(entry.file);
					continue;
				}

				// Determine push vs pull using the modified timestamp
				const obsidianChanged = !entry.noteTaskSyncedAt || (entry.modified ?? '') > entry.noteTaskSyncedAt;

				if (obsidianChanged) {
					// Obsidian has changes → push all Obsidian values to Todoist
					const currentRemoteTitle = remoteItem.content ?? '';
					const prefix = currentRemoteTitle.startsWith('* ') ? '* ' : '';
					const newContent = `${prefix}${entry.noteTitle} [+](${obsidianUri})`;
					// Only send isDone when the completion state actually changes.
					// Sending item_uncomplete on an already-open task causes Todoist
					// to restore the item to its original section, undoing the item_move.
					const remoteChecked = Boolean(remoteItem.checked);
					const needsStatusChange = isDoneStatus !== remoteChecked;
					await todoistClient.updateTask({
						id: entry.noteTaskId,
						content: newContent,
						description: entry.description,
						isDone: needsStatusChange ? isDoneStatus : undefined,
						priority: entry.priority,
						labels: entry.labels,
						dueDate: entry.dueDate?.trim(),
						dueString: entry.dueString?.trim(),
						clearDue: !entry.dueDate && !entry.dueString,
						deadline: entry.deadline?.trim(),
						clearDeadline: !entry.deadline,
						sectionId: noteTaskSectionId,
					});
					await repository.markNoteTaskSyncedAt(entry.file);
					noteTasksUpdated += 1;
				} else {
					// Note unchanged since last sync → pull Todoist values into the note
					const remoteDue = remoteItem.due?.date ?? null;
					const remoteDueString = remoteItem.due?.string ?? null;
					const remoteDeadline = remoteItem.deadline?.date ?? null;
					const remoteDescription = remoteItem.description;
					const remotePriority = remoteItem.priority;

					// Check if anything actually changed on the remote side
					const remoteChanged =
						(remoteDue ?? '') !== (entry.dueDate ?? '') ||
						(remoteDueString ?? '') !== (entry.dueString ?? '') ||
						(remoteDeadline ?? '') !== (entry.deadline ?? '') ||
						(remoteDescription ?? '') !== (entry.description ?? '') ||
						remotePriority !== entry.priority;

					if (remoteChanged) {
						await repository.applyNoteTaskPull(
							entry.file,
							remoteDue,
							remoteDueString,
							remotePriority,
							remoteDeadline,
							remoteDescription,
						);
						noteTasksPulled += 1;
					}
					// Nothing changed on either side — skip write entirely.
					// Writing the sync timestamp here would update mtime, which on the
					// next sync would equal noteTaskSyncedAt again, creating a
					// perpetual write loop with no functional benefit.
					}
				} catch (e) {
				phaseErrors.push(`NoteTask sync "${entry.noteTitle}": ${errorMessage(e)}`);
			}
		}
	} catch (e) {
		phaseErrors.push(`NoteTask sync: ${errorMessage(e)}`);
	}

	// Phase 9c: auto-create NoteTasks for tag-matched notes (non-critical, per-item)
	let noteTasksAutoCreated = 0;
	try {
		const pendingNoteTaskCreates = await repository.listPendingNoteTaskAutoCreates();
		for (const pending of pendingNoteTaskCreates) {
			try {
				const vaultName = encodeURIComponent(this.app.vault.getName());
				const filePath = encodeURIComponent(pending.file.path);
				const obsidianUri = `obsidian://open?vault=${vaultName}&file=${filePath}`;

				// Resolve project: prefer explicit ID, then fall back to name from tag→project map
				const resolvedNoteTaskProjectId = resolveProjectId(pending.projectId, pending.projectName, projectIdByName);

				// Resolve section from status→section map
				const resolvedNoteTaskSectionId = resolveSectionId(undefined, pending.sectionName, resolvedNoteTaskProjectId, snapshot);

				// Calculate order to place NoteTask at the top of the project
				const projectTasks = snapshot.items.filter((item) => item.project_id === resolvedNoteTaskProjectId && !item.parent_id);
				const minOrder = projectTasks.length > 0
					? Math.min(...projectTasks.map((t) => t.order ?? 0))
					: 0;
				const noteTaskOrder = minOrder > 0 ? minOrder - 1 : minOrder;

				const createdTaskId = await todoistClient.createTask({
					content: `${pending.title} [+](${obsidianUri})`,
					projectId: resolvedNoteTaskProjectId,
					sectionId: resolvedNoteTaskSectionId,
					order: noteTaskOrder,
					labels: pending.labels,
				});
				await repository.markNoteTaskCreated(pending.file, createdTaskId);
				noteTasksAutoCreated += 1;
			} catch (e) {
				phaseErrors.push(`NoteTask auto-create "${pending.title}": ${errorMessage(e)}`);
			}
		}
	} catch (e) {
		phaseErrors.push(`NoteTask auto-create: ${errorMessage(e)}`);
	}

	// Phase 10: archive/unarchive project and section notes (non-critical)
		try {
			const archivedProjects = snapshot.projects.filter((p) => p.is_archived);
			const archivedSections = snapshot.sections.filter((s) => s.is_archived);
			await repository.applyArchivedProjectsAndSections(archivedProjects, archivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);
		} catch (e) {
			phaseErrors.push(`Archive: ${errorMessage(e)}`);
		}
		try {
			const unarchivedProjects = snapshot.projects.filter((p) => !p.is_archived);
			const unarchivedSections = snapshot.sections.filter((s) => !s.is_archived);
			await repository.applyUnarchivedProjectsAndSections(unarchivedProjects, unarchivedSections, projectNameById, projectParentIdById, sectionProjectIdById, sectionNameById);
		} catch (e) {
			phaseErrors.push(`Unarchive: ${errorMessage(e)}`);
		}

		// Phase 11: sync linked checklist states (non-critical)
		let linkedChecklistUpdates = 0;
		try {
			linkedChecklistUpdates = await syncLinkedChecklistStates(this.app, this.settings);
		} catch (e) {
			phaseErrors.push(`Checklist sync: ${errorMessage(e)}`);
		}

		const ancestorCount = importableWithAncestors.length - importableItems.length;
		const projectTaskMsg = projectTasksCreated > 0 ? `, ${projectTasksCreated} project task(s) created` : '';
		const noteTaskMsg = (noteTasksAutoCreated > 0 || noteTasksUpdated > 0 || noteTasksPulled > 0) ? `, ${noteTasksAutoCreated} NoteTask(s) created, ${noteTasksUpdated} pushed, ${noteTasksPulled} pulled` : '';
		const errorSuffix = phaseErrors.length > 0 ? ` [${phaseErrors.length} issue(s): ${phaseErrors.join('; ')}]` : '';
		const message = `Synced ${importableItems.length} importable task(s) (+${ancestorCount} ancestors): ${pendingLocalCreates.length} created remotely, ${pendingLocalUpdates.length} updates pushed, ${taskResult.created} created, ${taskResult.updated} updated, ${missingHandled} missing handled, ${linkedChecklistUpdates} checklist lines refreshed${projectTaskMsg}${noteTaskMsg}.${errorSuffix}`;
		// Build a concise notification message
		const shortParts: string[] = [];
		const fromTodoist = taskResult.created + taskResult.updated;
		if (fromTodoist > 0) shortParts.push(`${fromTodoist} from Todoist`);
		const pushed = pendingLocalCreates.length + pendingLocalUpdates.length;
		if (pushed > 0) shortParts.push(`${pushed} pushed`);
		if (missingHandled > 0) shortParts.push(`${missingHandled} resolved`);
		const noteTaskActivity = noteTasksAutoCreated + noteTasksUpdated + noteTasksPulled;
		if (noteTaskActivity > 0) shortParts.push(`${noteTaskActivity} NoteTasks`);
		if (projectTasksCreated > 0) shortParts.push(`${projectTasksCreated} project tasks`);
		const shortBase = shortParts.length > 0 ? shortParts.join(', ') : 'nothing to do';
		const shortMessage = phaseErrors.length > 0 ? `${shortBase} — ${phaseErrors.length} issue(s)` : shortBase;
		return {
			ok: phaseErrors.length === 0,
			message,
			shortMessage,
			imported: importableWithAncestors.length,
			created: taskResult.created,
			updated: taskResult.updated,
			missingHandled,
			pushedUpdates: pendingLocalUpdates.length,
			linkedChecklistUpdates,
			syncToken: snapshot.syncToken || undefined,
			phaseErrors: phaseErrors.length > 0 ? phaseErrors : undefined,
		};
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
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
	warnings?: string[],
): string | undefined {
	if (sectionId?.trim()) {
		return sectionId.trim();
	}
	if (!sectionName?.trim() || !projectId) {
		return undefined;
	}
	const projectSections = snapshot.sections.filter((item) => item.project_id === projectId);
	const section = projectSections.find(
		(item) => item.name.toLowerCase() === sectionName.trim().toLowerCase(),
	);
	if (!section && warnings) {
		const available = projectSections.map((s) => `"${s.name}"`).join(', ') || '(none)';
		warnings.push(`Section "${sectionName}" not found (available: ${available})`);
	}
	return section?.id;
}
