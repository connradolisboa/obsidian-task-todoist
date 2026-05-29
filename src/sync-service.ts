import { TaskNoteRepository, type SyncedTaskEntry, type MissingTaskEntry, type ActiveNoteTaskEntry } from './task-note-repository';
import type { TaskTodoistSettings } from './settings';
import { getPropNames } from './task-frontmatter';
import { filterImportableItems } from './import-rules';
import { TodoistClient, TodoistNotFoundError } from './todoist-client';
import type { TodoistItem, TodoistSyncSnapshot } from './todoist-client';
import type { App, TFile } from 'obsidian';
import { syncLinkedChecklistStates } from './linked-checklist-sync';
import { type VaultIndex, buildVaultIndexSnapshot } from './vault-index';
import { appendEventsToDailyNote, type DailyNoteEvent } from './daily-note-service';
import { generateUuid } from './task-frontmatter';
import { PendingLog } from './pending-log';

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
	/** True only when the snapshot was fully applied to the vault — gates lastSyncToken persistence. */
	tokenSafe?: boolean;
	phaseErrors?: string[];
}

export class SyncService {
	private readonly app: App;
	private readonly settings: TaskTodoistSettings;
	private readonly token: string;
	private readonly lastSyncToken: string | null;
	private readonly vaultIndex: VaultIndex | null;
	private readonly pendingLog: PendingLog;

	constructor(app: App, settings: TaskTodoistSettings, token: string, lastSyncToken: string | null = null, vaultIndex: VaultIndex | null = null, pluginId = 'obsidian-task-todoist') {
		this.app = app;
		this.settings = settings;
		this.token = token;
		this.lastSyncToken = lastSyncToken;
		this.vaultIndex = vaultIndex;
		this.pendingLog = new PendingLog(app, pluginId);
	}

	async runImportSync(): Promise<SyncRunResult> {
		const todoistClient = new TodoistClient(this.token);
		const repository = new TaskNoteRepository(this.app, this.settings, this.vaultIndex ?? undefined);
		const phaseErrors: string[] = [];
		// True only while the snapshot is being fully applied to the vault. Cleared if
		// the import/missing phases error or are skipped, so the sync token is not
		// persisted as if everything were processed (T1.6).
		let snapshotApplyClean = true;

		// T1.7: capture every markdown file's mtime at the very start, before any
		// network round-trips. A long sync can take many seconds; if the user edits a
		// note meanwhile, updateTaskFile() compares against this snapshot and refuses
		// to clobber the fresh edit.
		const fileMtimeAtStart = new Map<string, number>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			fileMtimeAtStart.set(f.path, f.stat.mtime);
		}

		// Phase 1: pre-flight repairs (non-critical — failures don't block sync)
		try {
			await repository.repairMalformedSignatureFrontmatterLines();
			await repository.backfillVaultIds();
		} catch (e) {
			phaseErrors.push(`Pre-flight: ${errorMessage(e)}`);
		}

		// Phase 2: fetch recently-deleted IDs. If this lookup fails we cannot reliably
		// tell deleted tasks apart from completed ones, so we flag it and skip the
		// missing-task phase entirely rather than guess (T1.5).
		let recentlyDeletedIds = new Set<string>();
		let deletedIdsReliable = true;
		try {
			const deletedResult = await todoistClient.fetchRecentlyDeletedTaskIds(50);
			if (deletedResult.ok) {
				recentlyDeletedIds = deletedResult.ids;
			} else {
				deletedIdsReliable = false;
				phaseErrors.push(`Deleted-IDs fetch failed (${deletedResult.reason}) — skipping deleted/completed handling this run`);
			}
		} catch (e) {
			deletedIdsReliable = false;
			phaseErrors.push(`Deleted-IDs fetch: ${errorMessage(e)} — skipping deleted/completed handling this run`);
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

		// Phase 3b: recover in-flight creates from a previous crashed run (T1.1/T1.2).
		// Surface any leftover write-ahead entries, then reconcile notes whose
		// todoist_pending_id was written but never confirmed: adopt the matching
		// remote task (no duplicate) or clear the marker so it is re-dispatched.
		try {
			await this.pendingLog.load();
			const leftover = this.pendingLog.list();
			if (leftover.length > 0) {
				const titles = leftover.slice(0, 5).map((e) => `"${e.title}"`).join(', ');
				const extra = leftover.length > 5 ? ` …and ${leftover.length - 5} more` : '';
				phaseErrors.push(`Recovered ${leftover.length} in-flight create(s) from a previous run: ${titles}${extra}`);
			}
			const recon = await repository.reconcilePendingCreates(snapshot.items, fileMtimeAtStart);
			if (recon.adopted > 0 || recon.recreated > 0) {
				console.log(`[TaskTodoist] Reconciled pending creates: ${recon.adopted} adopted, ${recon.recreated} re-dispatched.`);
			}
			// Frontmatter is now the source of truth for recovery — clear the log.
			await this.pendingLog.clearAll();
		} catch (e) {
			phaseErrors.push(`Reconcile pending creates: ${errorMessage(e)}`);
		}

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
				// Write-ahead: persist a locally-generated pending ID to the note AND the
				// write-ahead log BEFORE the network call. If we crash mid-create, the
				// note is skipped by listPendingLocalCreates() and recovered by
				// reconcilePendingCreates() — never duplicated (T1.1/T1.2).
				const pendingUuid = generateUuid();
				await repository.markCreatePending(pending.file, pendingUuid);
				await this.pendingLog.record({
					id: pendingUuid,
					kind: 'task',
					path: pending.file.path,
					title: pending.title,
					dispatchedAt: new Date().toISOString(),
				});
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
				await this.pendingLog.confirm(pendingUuid);
				// This sync just wrote the file — rebase its mtime so Phase 7's mtime
				// guard does not mistake our own write for a concurrent user edit.
				fileMtimeAtStart.set(pending.file.path, pending.file.stat.mtime);
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
				// Rebase mtime (post-rename path) so the Phase 7 guard ignores our own write.
				fileMtimeAtStart.set(pending.file.path, pending.file.stat.mtime);
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

		// Build watched label set for daily note events (empty = feature off)
		const watchedLabelSet: Set<string> = this.settings.dailyNoteEnabled && this.settings.dailyNoteLabels.trim()
			? new Set(this.settings.dailyNoteLabels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean))
			: new Set();
		const dailyNoteEvents: DailyNoteEvent[] = [];

		// Phase 7: import/upsert task notes (non-critical — degraded sync still useful)
		let taskResult: { created: number; updated: number; newlyCreatedFiles: Map<string, TFile> } = {
			created: 0, updated: 0, newlyCreatedFiles: new Map(),
		};
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
				fileMtimeAtStart,
			});
		} catch (e) {
			phaseErrors.push(`Import: ${errorMessage(e)}`);
			snapshotApplyClean = false;
		}

		// Get a fresh vault snapshot (Phase 7 invalidated the index) for project note lookups
		// Only paid when the feature is active and there are events to process.
		const dailyNoteVaultSnapshot = watchedLabelSet.size > 0
			? (this.vaultIndex?.get() ?? buildVaultIndexSnapshot(this.app, this.settings))
			: null;

		// Collect daily note "added" events for newly created task notes
		if (dailyNoteVaultSnapshot && taskResult.newlyCreatedFiles.size > 0) {
			const importableById = new Map(importableWithAncestors.map((item) => [item.id, item]));
			for (const [todoistId, file] of taskResult.newlyCreatedFiles) {
				const item = importableById.get(todoistId);
				if (!item) continue;
				const matchingLabel = (item.labels ?? []).find((l) => watchedLabelSet.has(l.toLowerCase()));
				if (matchingLabel) {
					dailyNoteEvents.push({
						action: 'added',
						file,
						title: file.basename,
						matchingLabel,
						project: projectNameById.get(item.project_id) ?? '',
						projectFile: dailyNoteVaultSnapshot.projectIndex.get(item.project_id),
					});
				}
			}
		}

		// Phase 8: handle missing/deleted remote tasks (non-critical).
		// Skipped entirely when the deleted-ID lookup failed (T1.5): without it we
		// cannot tell a deleted task from a completed one, and guessing risks either
		// orphaning deleted tasks or wrongly archiving live ones.
		let missingHandled = 0;
		if (!deletedIdsReliable) {
			snapshotApplyClean = false;
		} else {
		try {
			const missingEntries = findMissingEntries(existingSyncedTasks, activeItemById, recentlyDeletedIds);

			// Collect daily note "completed" events before the task notes are marked done.
			// Skip entries already marked archived_remote — they were logged on a previous sync.
			if (dailyNoteVaultSnapshot) {
				const p = getPropNames(this.settings);
				for (const entry of missingEntries) {
					if (entry.isDeletedRemote) continue;
					const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as Record<string, unknown> | undefined;
					if (!fm) continue;
					// Dedup: only emit the first time this task is being marked archived
					const syncStatus = typeof fm[p.todoistSyncStatus] === 'string' ? (fm[p.todoistSyncStatus] as string) : '';
					if (syncStatus === 'archived_remote' || syncStatus === 'deleted_remote' || syncStatus === 'stopped') continue;
					const rawLabels = fm[p.todoistLabels];
					const labels: string[] = Array.isArray(rawLabels) ? rawLabels.map(String) : [];
					const matchingLabel = labels.find((l) => watchedLabelSet.has(l.toLowerCase()));
					if (!matchingLabel) continue;
					const title = typeof fm[p.taskTitle] === 'string' ? (fm[p.taskTitle] as string) : entry.file.basename;
					const project = typeof fm[p.todoistProjectName] === 'string' ? (fm[p.todoistProjectName] as string) : '';
					const projectId = typeof fm[p.todoistProjectId] === 'string' ? (fm[p.todoistProjectId] as string).trim() : '';
					dailyNoteEvents.push({
						action: 'completed',
						file: entry.file,
						title,
						matchingLabel,
						project,
						projectFile: projectId ? dailyNoteVaultSnapshot.projectIndex.get(projectId) : undefined,
					});
				}
			}

			missingHandled = await repository.applyMissingRemoteTasks(missingEntries, phaseErrors);
		} catch (e) {
			phaseErrors.push(`Missing tasks: ${errorMessage(e)}`);
			snapshotApplyClean = false;
		}
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
						const projectLogId = generateUuid();
						await this.pendingLog.record({
							id: projectLogId,
							kind: 'project',
							path: pending.file.path,
							title: pending.projectName,
							dispatchedAt: new Date().toISOString(),
						});
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
						await this.pendingLog.confirm(projectLogId);
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
					// Note says stop → delete the Todoist task and stop syncing.
					// A 404 means it is already gone — the desired end state — so still stop.
					try {
						await todoistClient.deleteTask(entry.noteTaskId);
					} catch (delErr) {
						if (!(delErr instanceof TodoistNotFoundError)) throw delErr;
					}
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
					try {
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
					} catch (pushErr) {
						if (pushErr instanceof TodoistNotFoundError) {
							// The linked Todoist task vanished. Clear the dead link so the
							// note stops no-op'ing every sync; it will be re-created if it
							// still matches auto-create rules, else left for review.
							await repository.clearNoteTaskLink(entry.file);
							phaseErrors.push(`NoteTask "${entry.noteTitle}": linked Todoist task no longer exists — cleared the link`);
							continue;
						}
						throw pushErr;
					}
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

				const noteTaskLogId = generateUuid();
				await this.pendingLog.record({
					id: noteTaskLogId,
					kind: 'noteTask',
					path: pending.file.path,
					title: pending.title,
					dispatchedAt: new Date().toISOString(),
				});
				const createdTaskId = await todoistClient.createTask({
					content: `${pending.title} [+](${obsidianUri})`,
					projectId: resolvedNoteTaskProjectId,
					sectionId: resolvedNoteTaskSectionId,
					order: noteTaskOrder,
					labels: pending.labels,
				});
				await repository.markNoteTaskCreated(pending.file, createdTaskId);
				await this.pendingLog.confirm(noteTaskLogId);
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

		// Phase 12: append daily note events (non-critical)
		if (dailyNoteEvents.length > 0) {
			try {
				await appendEventsToDailyNote(this.app, this.settings, dailyNoteEvents);
			} catch (e) {
				phaseErrors.push(`Daily note: ${errorMessage(e)}`);
			}
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
			// Persist the token only when the snapshot was fully applied — otherwise the
			// next sync would assume it already processed changes it actually skipped (T1.6).
			tokenSafe: snapshotApplyClean,
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
