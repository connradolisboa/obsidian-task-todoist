import { TFile } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import type { PropNames, TaskTodoistSettings } from './settings';
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
 * The set of index keys a single file contributes. Computed identically by the
 * full scan and the incremental updater so both stay in lock-step.
 */
interface FileContribution {
	taskId: string | null;
	projectId: string | null;
	sectionId: string | null;
	vaultId: string | null;
	noteTaskId: string | null;
}

/**
 * Computes which indexes a file belongs to, based on its frontmatter. This is
 * the single source of truth for index membership rules (dual-purpose notes,
 * section-vs-project disambiguation, etc.).
 */
function computeContribution(fm: Record<string, unknown> | undefined, p: PropNames): FileContribution {
	const empty: FileContribution = { taskId: null, projectId: null, sectionId: null, vaultId: null, noteTaskId: null };
	if (!fm) {
		return empty;
	}

	// Task index: by todoist_id (vault-wide, not restricted to tasksFolderPath)
	const rawId = fm[p.todoistId];
	let taskId: string | null = null;
	if (typeof rawId === 'string' && rawId.trim()) {
		taskId = rawId.trim();
	} else if (typeof rawId === 'number') {
		taskId = String(rawId);
	}

	let projectId: string | null = null;
	let sectionId: string | null = null;

	// Dual-purpose note: a project note that also represents a Todoist task.
	// When todoist_project_task_id matches todoist_id (both non-empty), the note
	// appears in BOTH taskIndex and projectIndex so project operations keep working.
	const rawProjectTaskId = fm[p.todoistProjectTaskId];
	const isDualPurposeNote =
		taskId !== null &&
		typeof rawProjectTaskId === 'string' &&
		rawProjectTaskId.trim() !== '' &&
		rawProjectTaskId.trim() === taskId;

	if (isDualPurposeNote) {
		const rawProjectId =
			fm[p.todoistProjectId] ??
			(p.todoistProjectId !== 'project_id' ? fm['project_id'] : undefined);
		if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
			projectId = rawProjectId.trim();
		}
	} else if (!taskId) {
		// Project/section indexes: only index project/section notes (not task notes).
		// A note with a section ID is a section note — index it ONLY in sectionIndex,
		// even if it also has a project ID (which it stores for the parent link).
		const rawSectionId =
			fm[p.todoistSectionId] ??
			(p.todoistSectionId !== 'section_id' ? fm['section_id'] : undefined);
		if (typeof rawSectionId === 'string' && rawSectionId.trim()) {
			sectionId = rawSectionId.trim();
		} else {
			const rawProjectId =
				fm[p.todoistProjectId] ??
				(p.todoistProjectId !== 'project_id' ? fm['project_id'] : undefined);
			if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
				projectId = rawProjectId.trim();
			}
		}
	}

	const rawVaultId = fm[p.vaultId];
	const vaultId = typeof rawVaultId === 'string' && rawVaultId.trim() ? rawVaultId.trim() : null;

	const rawNoteTaskId = fm[p.todoistNoteTaskId];
	const noteTaskId = typeof rawNoteTaskId === 'string' && rawNoteTaskId.trim() ? rawNoteTaskId.trim() : null;

	return { taskId, projectId, sectionId, vaultId, noteTaskId };
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
		const c = computeContribution(fm, p);

		if (c.taskId) {
			const existing = allFilesById.get(c.taskId);
			if (existing) {
				existing.push(file);
			} else {
				allFilesById.set(c.taskId, [file]);
				taskIndex.set(c.taskId, file);
			}
		}
		if (c.projectId) projectIndex.set(c.projectId, file);
		if (c.sectionId) sectionIndex.set(c.sectionId, file);
		if (c.vaultId) vaultIdIndex.set(c.vaultId, file);
		if (c.noteTaskId) noteTaskIndex.set(c.noteTaskId, file);
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
 * A single-valued index (id → file) backed by an insertion-ordered list so that
 * incremental removals stay correct when more than one file claims the same id.
 * The canonical entry is the FIRST file added for an id, matching the full-scan
 * build (`buildVaultIndexSnapshot`), which keeps the first occurrence. Duplicate
 * todoist_ids are surfaced via duplicates() and resolved by the repository.
 */
class CanonicalIndex {
	readonly canonical = new Map<string, TFile>();
	private readonly all = new Map<string, TFile[]>();

	add(id: string, file: TFile): void {
		const arr = this.all.get(id);
		if (arr) {
			if (!arr.includes(file)) arr.push(file);
		} else {
			this.all.set(id, [file]);
		}
		this.recompute(id);
	}

	remove(id: string, file: TFile): void {
		const arr = this.all.get(id);
		if (!arr) return;
		const next = arr.filter((f) => f !== file);
		if (next.length > 0) this.all.set(id, next);
		else this.all.delete(id);
		this.recompute(id);
	}

	/** Returns ids with more than one claiming file (duplicates). */
	duplicates(): Map<string, TFile[]> {
		const result = new Map<string, TFile[]>();
		for (const [id, files] of this.all) {
			if (files.length > 1) result.set(id, files);
		}
		return result;
	}

	clear(): void {
		this.canonical.clear();
		this.all.clear();
	}

	private recompute(id: string): void {
		const arr = this.all.get(id);
		const first = arr && arr.length > 0 ? arr[0] : undefined;
		if (first) this.canonical.set(id, first);
		else this.canonical.delete(id);
	}
}

/**
 * Long-lived, event-driven cache of the vault index. On first access it scans
 * the vault once; thereafter it maintains the indexes incrementally in response
 * to Obsidian's create/modify/delete/rename events, avoiding a full filesystem
 * scan on every sync. A full rebuild only happens on plugin load, on settings
 * change, or when a caller explicitly invalidates after bulk writes.
 */
export class VaultIndex {
	private built = false;
	private settings: TaskTodoistSettings;

	private readonly tasks = new CanonicalIndex();
	private readonly projects = new CanonicalIndex();
	private readonly sections = new CanonicalIndex();
	private readonly vaultIds = new CanonicalIndex();
	private readonly noteTasks = new CanonicalIndex();
	/** Reverse map: path → contribution currently applied, so updates can be diffed. */
	private contributions = new Map<string, FileContribution>();

	/** T2.3: cached "no duplicate todoist_ids need resolving" state. */
	private duplicatesResolved = false;

	constructor(private readonly app: App, settings: TaskTodoistSettings) {
		this.settings = settings;
	}

	/**
	 * Register Obsidian file-system events so the index is maintained incrementally
	 * whenever files are created, renamed, deleted, or their metadata changes.
	 * Pass `plugin.registerEvent` bound to the plugin instance.
	 */
	register(registerEvent: (eventRef: ReturnType<App['metadataCache']['on']>) => void): void {
		registerEvent(this.app.metadataCache.on('changed', (file) => { this.applyFile(file); }));
		// vault events use a different overload but share the same EventRef shape
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const vaultRegister = registerEvent as (e: any) => void;
		vaultRegister(this.app.vault.on('create', (file: TAbstractFile) => { this.applyAbstract(file); }));
		vaultRegister(this.app.vault.on('delete', (file: TAbstractFile) => {
			this.removeFile(file.path, isTFile(file) ? file : undefined);
			this.duplicatesResolved = false;
		}));
		vaultRegister(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			// Obsidian renames in place: the same TFile instance is reused with an
			// updated path, so we can detach its old-path contribution by reference.
			this.removeFile(oldPath, isTFile(file) ? file : undefined);
			this.applyAbstract(file);
		}));
	}

	/** Called when plugin settings change so the index is rebuilt with the new propNames. */
	updateSettings(settings: TaskTodoistSettings): void {
		this.settings = settings;
		this.invalidate();
	}

	/**
	 * Returns the current snapshot, building it from scratch on first access or
	 * after an invalidation. Subsequent accesses reuse the incrementally-maintained
	 * indexes — no full scan.
	 */
	get(): VaultIndexSnapshot {
		if (!this.built) {
			this.fullBuild();
		}
		return {
			taskIndex: this.tasks.canonical,
			projectIndex: this.projects.canonical,
			sectionIndex: this.sections.canonical,
			vaultIdIndex: this.vaultIds.canonical,
			noteTaskIndex: this.noteTasks.canonical,
			duplicateTaskFiles: this.tasks.duplicates(),
		};
	}

	/** Force a full rebuild on the next get() call. */
	invalidate(): void {
		this.built = false;
		this.duplicatesResolved = false;
	}

	/** T2.3: true when duplicate todoist_ids have already been resolved against the current state. */
	areDuplicatesResolved(): boolean {
		return this.built && this.duplicatesResolved;
	}

	/** T2.3: record that duplicate resolution has run against the current state. */
	markDuplicatesResolved(): void {
		this.duplicatesResolved = true;
	}

	private fullBuild(): void {
		this.tasks.clear();
		this.projects.clear();
		this.sections.clear();
		this.vaultIds.clear();
		this.noteTasks.clear();
		this.contributions = new Map();
		const p = getPropNames(this.settings);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const c = computeContribution(fm, p);
			this.applyContribution(file, c);
		}
		this.built = true;
		this.duplicatesResolved = false;
	}

	private applyAbstract(file: TAbstractFile): void {
		// Only markdown files carry indexable frontmatter.
		if (file instanceof TFile && file.extension === 'md') {
			this.applyFile(file);
		}
	}

	private applyFile(file: TFile): void {
		// Before the first full build there is nothing to maintain; the eventual
		// get() will scan the current state from scratch.
		if (!this.built) {
			return;
		}
		const p = getPropNames(this.settings);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const next = computeContribution(fm, p);
		this.applyContribution(file, next);
		this.duplicatesResolved = false;
	}

	private removeFile(path: string, file?: TFile): void {
		if (!this.built) {
			return;
		}
		const prev = this.contributions.get(path);
		if (!prev) {
			return;
		}
		// Prefer detaching by the actual TFile reference; fall back to the canonical
		// entry when the reference is unavailable (e.g. non-TFile delete events).
		this.detach(prev, file);
		this.contributions.delete(path);
	}

	/** Applies a freshly computed contribution for a file, replacing any prior one. */
	private applyContribution(file: TFile, next: FileContribution): void {
		const prev = this.contributions.get(file.path);
		if (prev) {
			if (prev.taskId && prev.taskId !== next.taskId) this.tasks.remove(prev.taskId, file);
			if (prev.projectId && prev.projectId !== next.projectId) this.projects.remove(prev.projectId, file);
			if (prev.sectionId && prev.sectionId !== next.sectionId) this.sections.remove(prev.sectionId, file);
			if (prev.vaultId && prev.vaultId !== next.vaultId) this.vaultIds.remove(prev.vaultId, file);
			if (prev.noteTaskId && prev.noteTaskId !== next.noteTaskId) this.noteTasks.remove(prev.noteTaskId, file);
		}
		if (next.taskId) this.tasks.add(next.taskId, file);
		if (next.projectId) this.projects.add(next.projectId, file);
		if (next.sectionId) this.sections.add(next.sectionId, file);
		if (next.vaultId) this.vaultIds.add(next.vaultId, file);
		if (next.noteTaskId) this.noteTasks.add(next.noteTaskId, file);

		const hasAny = next.taskId || next.projectId || next.sectionId || next.vaultId || next.noteTaskId;
		if (hasAny) this.contributions.set(file.path, next);
		else this.contributions.delete(file.path);
	}

	/** Detaches a prior contribution from all indexes. */
	private detach(prev: FileContribution, file?: TFile): void {
		const detachOne = (index: CanonicalIndex, id: string | null) => {
			if (!id) return;
			const target = file ?? index.canonical.get(id);
			if (target) index.remove(id, target);
		};
		detachOne(this.tasks, prev.taskId);
		detachOne(this.projects, prev.projectId);
		detachOne(this.sections, prev.sectionId);
		detachOne(this.vaultIds, prev.vaultId);
		detachOne(this.noteTasks, prev.noteTaskId);
	}
}

function isTFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === 'md';
}
