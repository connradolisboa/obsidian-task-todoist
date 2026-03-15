import type { App, TFile } from 'obsidian';
import type { TaskTodoistSettings } from './settings';
import { getPropNames } from './task-frontmatter';

export interface VaultIndexSnapshot {
	taskIndex: Map<string, TFile>;
	projectIndex: Map<string, TFile>;
	sectionIndex: Map<string, TFile>;
	vaultIdIndex: Map<string, TFile>;
	duplicateTaskFiles: Map<string, TFile[]>;
	/** NoteTask index: maps todoist_note_task_id → TFile (vault-wide) */
	noteTaskIndex: Map<string, TFile>;
}

/**
 * Builds a fresh vault index by scanning all markdown files. This is the shared
 * implementation used by both VaultIndex (cached) and TaskNoteRepository (uncached fallback).
 */
export function buildVaultIndexSnapshot(app: App, settings: TaskTodoistSettings): VaultIndexSnapshot {
	const taskIndex = new Map<string, TFile>();
	const projectIndex = new Map<string, TFile>();
	const sectionIndex = new Map<string, TFile>();
	const vaultIdIndex = new Map<string, TFile>();
	const noteTaskIndex = new Map<string, TFile>();
	const allFilesById = new Map<string, TFile[]>();
	const p = getPropNames(settings);

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
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
			const existing = allFilesById.get(taskId);
			if (existing) {
				existing.push(file);
			} else {
				allFilesById.set(taskId, [file]);
				taskIndex.set(taskId, file);
			}
		}

		// Dual-purpose note: a project note that also represents a Todoist task.
		// When todoist_project_task_id matches todoist_id (both non-empty), the note
		// must appear in BOTH taskIndex (already added above) AND projectIndex so that
		// project operations (rename, archive, parent links) continue to work.
		const rawProjectTaskId = fm[p.todoistProjectTaskId];
		const isDualPurposeNote =
			taskId !== null &&
			typeof rawProjectTaskId === 'string' &&
			rawProjectTaskId.trim() !== '' &&
			rawProjectTaskId.trim() === taskId;

		if (isDualPurposeNote) {
			// Also index in projectIndex by todoist_project_id
			const rawProjectId =
				fm[p.todoistProjectId] ??
				(p.todoistProjectId !== 'project_id' ? fm['project_id'] : undefined);
			if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
				projectIndex.set(rawProjectId.trim(), file);
			}
		} else if (!taskId) {
			// Project/section indexes: only index project/section notes (not task notes).
			// Task notes have todoist_id set; project and section notes never do.
			// Backward-compat dual-read: old notes use 'project_id'/'section_id' keys.
			//
			// IMPORTANT: A note with a section ID is a section note — index it ONLY in
			// sectionIndex, even if it also has a project ID. Without this guard, section
			// notes (which store todoist_project_id for the parent project link) would also
			// appear in projectIndex, causing tasks to link to section notes instead of
			// their parent project notes ("sections linked in place of projects").
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

		// NoteTask index: by todoist_note_task_id frontmatter
		const rawNoteTaskId = fm[p.todoistNoteTaskId];
		if (typeof rawNoteTaskId === 'string' && rawNoteTaskId.trim()) {
			noteTaskIndex.set(rawNoteTaskId.trim(), file);
		}
	}

	const duplicateTaskFiles = new Map<string, TFile[]>();
	for (const [id, files] of allFilesById) {
		if (files.length > 1) {
			duplicateTaskFiles.set(id, files);
		}
	}

	return { taskIndex, projectIndex, sectionIndex, vaultIdIndex, duplicateTaskFiles, noteTaskIndex };
}

/**
 * Long-lived cache for the vault index. Listens to Obsidian file events to
 * invalidate the cache, rebuilding lazily on next access. This avoids the cost
 * of a full vault scan on every buildVaultIndexes() call within a sync run.
 */
export class VaultIndex {
	private dirty = true;
	private cachedSnapshot: VaultIndexSnapshot | null = null;
	private settings: TaskTodoistSettings;

	constructor(private readonly app: App, settings: TaskTodoistSettings) {
		this.settings = settings;
	}

	/**
	 * Register Obsidian file-system events so the cache is invalidated whenever
	 * files are created, renamed, deleted, or their metadata changes.
	 * Pass `plugin.registerEvent` bound to the plugin instance.
	 */
	register(registerEvent: (eventRef: ReturnType<App['metadataCache']['on']>) => void): void {
		registerEvent(this.app.metadataCache.on('changed', () => { this.dirty = true; }));
		// vault events use a different overload but share the same EventRef shape
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vaultRegister = registerEvent as (e: any) => void;
		vaultRegister(this.app.vault.on('rename', () => { this.dirty = true; }));
		vaultRegister(this.app.vault.on('delete', () => { this.dirty = true; }));
		vaultRegister(this.app.vault.on('create', () => { this.dirty = true; }));
	}

	/** Called when plugin settings change so the index is rebuilt with the new propNames. */
	updateSettings(settings: TaskTodoistSettings): void {
		this.settings = settings;
		this.dirty = true;
	}

	/**
	 * Returns the cached snapshot, rebuilding from scratch if the cache is stale.
	 * The rebuild cost is O(N vault files) — amortised across all callers within
	 * a sync run since the cache is only dirty once per set of file changes.
	 */
	get(): VaultIndexSnapshot {
		if (!this.dirty && this.cachedSnapshot) {
			return this.cachedSnapshot;
		}
		this.cachedSnapshot = buildVaultIndexSnapshot(this.app, this.settings);
		this.dirty = false;
		return this.cachedSnapshot;
	}

	/** Force a rebuild on the next get() call. */
	invalidate(): void {
		this.dirty = true;
	}
}
