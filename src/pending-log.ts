import type { App } from 'obsidian';

export type PendingCreateKind = 'task' | 'project' | 'noteTask';

export interface PendingCreateEntry {
	/** Unique id for this dispatch. For tasks this matches the note's todoist_pending_id. */
	id: string;
	kind: PendingCreateKind;
	/** Source note path, for diagnostics and recovery. */
	path: string;
	/** Task/project title at dispatch time, for diagnostics. */
	title: string;
	/** ISO timestamp the create was dispatched to Todoist. */
	dispatchedAt: string;
}

/**
 * A single-file write-ahead log for in-flight Todoist creates, stored at
 * `<configDir>/plugins/<id>/pending.json`.
 *
 * An entry is appended immediately BEFORE the network call and removed on
 * confirmation. If Obsidian crashes (or is quit) after the create reaches
 * Todoist but before the frontmatter write that records the new ID lands on
 * disk, the entry survives. On the next sync the leftover entries are surfaced
 * so the create can be reconciled instead of silently duplicated or lost.
 */
export class PendingLog {
	private readonly path: string;
	private entries: PendingCreateEntry[] = [];
	private loaded = false;

	constructor(private readonly app: App, pluginId: string) {
		this.path = `${app.vault.configDir}/plugins/${pluginId}/pending.json`;
	}

	/** Loads the log from disk. Safe to call repeatedly; only reads once. */
	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		try {
			if (await this.app.vault.adapter.exists(this.path)) {
				const raw = await this.app.vault.adapter.read(this.path);
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					this.entries = parsed.filter(isPendingEntry);
				}
			}
		} catch (e) {
			console.error('[TaskTodoist] Failed to read pending.json — starting empty:', e);
			this.entries = [];
		}
	}

	/** Returns a copy of the current entries. */
	list(): PendingCreateEntry[] {
		return [...this.entries];
	}

	/** Appends an entry and persists immediately (write-ahead). */
	async record(entry: PendingCreateEntry): Promise<void> {
		await this.load();
		this.entries = this.entries.filter((e) => e.id !== entry.id);
		this.entries.push(entry);
		await this.persist();
	}

	/** Removes the entry with the given id and persists (confirmation). */
	async confirm(id: string): Promise<void> {
		await this.load();
		const next = this.entries.filter((e) => e.id !== id);
		if (next.length === this.entries.length) {
			return;
		}
		this.entries = next;
		await this.persist();
	}

	/** Removes all entries and persists. */
	async clearAll(): Promise<void> {
		await this.load();
		if (this.entries.length === 0) {
			return;
		}
		this.entries = [];
		await this.persist();
	}

	private async persist(): Promise<void> {
		try {
			await this.app.vault.adapter.write(this.path, JSON.stringify(this.entries));
		} catch (e) {
			console.error('[TaskTodoist] Failed to write pending.json:', e);
		}
	}
}

function isPendingEntry(value: unknown): value is PendingCreateEntry {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === 'string' &&
		(v.kind === 'task' || v.kind === 'project' || v.kind === 'noteTask') &&
		typeof v.path === 'string' &&
		typeof v.title === 'string' &&
		typeof v.dispatchedAt === 'string'
	);
}
