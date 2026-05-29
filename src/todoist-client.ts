import { requestUrl } from 'obsidian';
import { RateLimiter, withRetryOn429 } from './rate-limiter';

export interface TodoistItem {
	id: string;
	content: string;
	description?: string;
	project_id: string;
	section_id?: string | null;
	parent_id?: string | null;
	priority?: number;
	due?: {
		date?: string | null;
		string?: string | null;
		is_recurring?: boolean | null;
		datetime?: string | null;
		timezone?: string | null;
		lang?: string | null;
	} | null;
	labels?: string[];
	checked?: boolean;
	is_deleted?: boolean;
	responsible_uid?: string | null;
	deadline?: {
		date: string;
		lang?: string | null;
	} | null;
	duration?: {
		amount: number;
		unit: string;
	} | null;
	order?: number;
}

export interface TodoistProject {
	id: string;
	name: string;
	parent_id: string | null;
	is_archived: boolean;
	color: string | null;
}

export interface TodoistSection {
	id: string;
	name: string;
	project_id: string;
	is_archived: boolean;
}

export interface TodoistSyncSnapshot {
	userId: string | null;
	items: TodoistItem[];
	projects: TodoistProject[];
	sections: TodoistSection[];
	syncToken: string;
}

export interface TodoistProjectSectionLookup {
	projects: TodoistProject[];
	sections: TodoistSection[];
}

/**
 * Result of fetching recently-deleted task IDs. When `ok` is false the caller
 * must NOT treat the absence of an ID as "not deleted" — the lookup itself
 * failed, so deletion detection is unreliable for this sync run.
 */
export type DeletedIdsResult =
	| { ok: true; ids: Set<string> }
	| { ok: false; reason: string };

/**
 * Thrown when a Sync API command fails because the target item no longer
 * exists in Todoist (HTTP 404 or an item-not-found error code). Callers can
 * catch this to clean up frontmatter that points at a vanished task.
 */
export class TodoistNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TodoistNotFoundError';
	}
}

export interface TodoistCreateTaskInput {
	content: string;
	description?: string;
	projectId?: string;
	sectionId?: string;
	parentId?: string;
	priority?: number;
	labels?: string[];
	dueDate?: string;
	dueString?: string;
	deadline?: string; // YYYY-MM-DD
	duration?: number; // minutes
	order?: number;
}

export interface TodoistTaskUpdateInput {
	id: string;
	content?: string;
	description?: string;
	isDone?: boolean; // undefined = don't change completion state; true = close; false = uncomplete
	isRecurring?: boolean;
	projectId?: string;
	sectionId?: string;
	priority?: number;
	labels?: string[];
	dueDate?: string;
	dueString?: string;
	clearDue?: boolean;
	deadline?: string; // YYYY-MM-DD, or empty string to clear
	clearDeadline?: boolean;
	duration?: number; // minutes
	clearDuration?: boolean;
}

export interface TodoistCreateProjectInput {
	name: string;
	parent_id?: string;
}

interface TodoistSyncResponse {
	user?: { id?: string | number };
	items?: Array<Record<string, unknown>>;
	projects?: Array<Record<string, unknown>>;
	sections?: Array<Record<string, unknown>>;
	temp_id_mapping?: Record<string, string>;
	sync_status?: Record<string, unknown>;
	sync_token?: string;
}

interface TodoistActivitiesResponse {
	next_cursor?: string;
	results?: Array<Record<string, unknown>>;
}

export class TodoistClient {
	private readonly token: string;
	private readonly rateLimiter: RateLimiter;

	constructor(token: string) {
		this.token = token;
		this.rateLimiter = new RateLimiter(2);
	}

	async testConnection(): Promise<{ ok: boolean; message: string }> {
		const response = await this.sync(['user']);
		if (response.status === 200) {
			return { ok: true, message: 'Todoist connection successful.' };
		}
		if (response.status === 401) {
			return { ok: false, message: 'Todoist authentication failed. Check your token.' };
		}
		return { ok: false, message: `Todoist connection failed with status ${response.status}.` };
	}

	async fetchSyncSnapshot(): Promise<TodoistSyncSnapshot> {
		const response = await this.sync(['user', 'projects', 'sections', 'items']);
		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist sync failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		return {
			userId: payload.user?.id == null ? null : String(payload.user.id),
			items: normalizeItems(payload.items ?? []),
			projects: normalizeProjects(payload.projects ?? []),
			sections: normalizeSections(payload.sections ?? []),
			syncToken: typeof payload.sync_token === 'string' ? payload.sync_token : '',
		};
	}

	/**
	 * Fetches items that changed since the given sync token (incremental sync).
	 * Returns the set of item IDs that were explicitly deleted (is_deleted: true).
	 * Used to distinguish deleted tasks from completed tasks, since both are absent
	 * from a full sync response.
	 */
	async fetchDeletedItemIds(sinceSyncToken: string): Promise<Set<string>> {
		const response = await this.syncWithBody({
			sync_token: sinceSyncToken,
			resource_types: '["items"]',
		});
		if (response.status !== 200) {
			return new Set();
		}
		const payload = response.json as TodoistSyncResponse;
		const items = normalizeItems(payload.items ?? []);
		return new Set(items.filter((item) => item.is_deleted).map((item) => item.id));
	}

	/**
	 * Fetches the most recent deleted item IDs from the Todoist Activities API.
	 * Unlike the sync-token approach, this works across restarts and doesn't
	 * require a previous sync token.
	 */
	async fetchRecentlyDeletedTaskIds(limit = 50): Promise<DeletedIdsResult> {
		const params = new URLSearchParams({
			object_event_types: '["item:deleted"]',
			count: String(limit),
		});
		await this.rateLimiter.throttle();
		const response = await withRetryOn429(() => requestUrl({
			url: `https://api.todoist.com/api/v1/activities?${params.toString()}`,
			method: 'GET',
			headers: { Authorization: `Bearer ${this.token}` },
			throw: false,
		}));
		if (response.status !== 200) {
			// Includes exhausted-retry 429s. Surface the failure so the caller can
			// skip deletion handling rather than silently treating deleted tasks as
			// "not deleted" (which would leave them orphaned in Obsidian forever).
			return { ok: false, reason: `Todoist activities API returned status ${response.status}` };
		}
		const payload = response.json as TodoistActivitiesResponse;
		const ids = new Set<string>();
		for (const event of payload.results ?? []) {
			const id = toId(event.object_id);
			if (id) ids.add(id);
		}
		return { ok: true, ids };
	}

	async fetchProjectSectionLookup(): Promise<TodoistProjectSectionLookup> {
		const response = await this.sync(['projects', 'sections']);
		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist project lookup failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		return {
			projects: normalizeProjects(payload.projects ?? []),
			sections: normalizeSections(payload.sections ?? []),
		};
	}

	async createTask(input: TodoistCreateTaskInput): Promise<string> {
		// The command UUID and temp_id are generated ONCE here, outside the 429
		// retry loop in syncWithBody(). The Sync API dedupes commands by UUID, so
		// reusing the same UUID across retries guarantees a rate-limited create is
		// never applied twice. Never move generation inside the retry loop.
		const commandUuid = generateUuid();
		const tempId = generateUuid();
		const args: Record<string, unknown> = {
			content: input.content,
		};
		if (input.description?.trim()) {
			args.description = input.description.trim();
		}
		if (input.projectId) {
			args.project_id = input.projectId;
		}
		if (input.sectionId) {
			args.section_id = input.sectionId;
		}
		if (input.parentId) {
			args.parent_id = input.parentId;
		}
		if (typeof input.priority === 'number') {
			args.priority = input.priority;
		}
		if (input.labels && input.labels.length > 0) {
			args.labels = input.labels;
		}
		const due = buildDueObject(input.dueDate, input.dueString);
		if (due) {
			args.due = due;
		}
		if (input.deadline?.trim()) {
			args.deadline = { date: input.deadline.trim() };
		}
		if (typeof input.duration === 'number' && input.duration > 0) {
			args.duration = { amount: input.duration, unit: 'minute' };
		}
		if (typeof input.order === 'number') {
			args.order = input.order;
		}

		const response = await this.syncWithCommands([
			{
				type: 'item_add',
				uuid: commandUuid,
				temp_id: tempId,
				args,
			},
		]);

		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist create task failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		const status = payload.sync_status?.[commandUuid];
		if (status !== 'ok') {
			throw new Error('Todoist did not accept the create task command.');
		}

		const mappedId = payload.temp_id_mapping?.[tempId];
		if (!mappedId) {
			throw new Error('Todoist create task response did not include a task ID.');
		}
		return mappedId;
	}

	async createProject(input: TodoistCreateProjectInput): Promise<string> {
		const commandUuid = generateUuid();
		const tempId = generateUuid();
		const args: Record<string, unknown> = { name: input.name };
		if (input.parent_id) args.parent_id = input.parent_id;

		const response = await this.syncWithCommands([{
			type: 'project_add',
			uuid: commandUuid,
			temp_id: tempId,
			args,
		}]);

		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist create project failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		const status = payload.sync_status?.[commandUuid];
		if (status !== 'ok') {
			throw new Error('Todoist did not accept the create project command.');
		}

		const mappedId = payload.temp_id_mapping?.[tempId];
		if (!mappedId) {
			throw new Error('Todoist create project response did not include a project ID.');
		}
		return mappedId;
	}

	async deleteTask(id: string): Promise<void> {
		const commandId = generateUuid();
		const response = await this.syncWithCommands([
			{
				type: 'item_delete',
				uuid: commandId,
				args: { id },
			},
		]);
		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status === 404) {
			throw new TodoistNotFoundError('Todoist delete task failed: item not found.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist delete task failed with status ${response.status}.`);
		}
		const payload = response.json as TodoistSyncResponse;
		assertSyncStatusOk(payload, commandId, 'delete');
	}

	async updateTask(input: TodoistTaskUpdateInput): Promise<void> {
		const commands = [];
		const updateCommandId = generateUuid();
		const isRecurringCompletion = Boolean(input.isDone && input.isRecurring);
		const due = buildDueObject(input.dueDate, input.dueString);
		commands.push({
			type: 'item_update',
			uuid: updateCommandId,
			args: {
				id: input.id,
				...(input.content !== undefined ? { content: input.content } : {}),
				description: input.description ?? '',
				...(input.projectId ? { project_id: input.projectId } : {}),
				// Note: section moves use item_move below — item_update does not support section_id
				...(typeof input.priority === 'number' ? { priority: input.priority } : {}),
				...(input.labels !== undefined ? { labels: input.labels } : {}),
				...(isRecurringCompletion ? {} : (due ? { due } : {})),
				...(isRecurringCompletion ? {} : (!due && input.clearDue ? { due: null } : {})),
				...(input.deadline?.trim() ? { deadline: { date: input.deadline.trim() } } : {}),
				...(!input.deadline?.trim() && input.clearDeadline ? { deadline: null } : {}),
				...(typeof input.duration === 'number' && input.duration > 0
					? { duration: { amount: input.duration, unit: 'minute' } }
					: input.clearDuration ? { duration: null } : {}),
			},
		});

		// item_update does not support section moves; use item_move when a target section is specified
		const moveCommandId = generateUuid();
		if (input.sectionId) {
			commands.push({
				type: 'item_move',
				uuid: moveCommandId,
				args: {
					id: input.id,
					section_id: input.sectionId,
				},
			});
		}

		// Only send item_close / item_uncomplete when the caller explicitly requests a
		// completion-state change.  Sending item_uncomplete on an already-open task can
		// cause Todoist to restore the item to its original section, undoing the item_move above.
		const statusCommandId = generateUuid();
		if (input.isDone !== undefined) {
			commands.push({
				type: input.isDone ? 'item_close' : 'item_uncomplete',
				uuid: statusCommandId,
				args: {
					id: input.id,
				},
			});
		}

		const response = await this.syncWithCommands(commands);
		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status === 404) {
			throw new TodoistNotFoundError('Todoist update task failed: item not found.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist update task failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		assertSyncStatusOk(payload, updateCommandId, 'update');
		if (input.sectionId) {
			assertSyncStatusOk(payload, moveCommandId, 'move');
		}
		if (input.isDone !== undefined) {
			assertSyncStatusOk(
				payload,
				statusCommandId,
				input.isDone ? 'close' : 'uncomplete',
			);
		}
	}

	private async sync(resourceTypes: string[]) {
		return this.syncWithBody({
			sync_token: '*',
			resource_types: JSON.stringify(resourceTypes),
		});
	}

	private async syncWithCommands(commands: unknown[]) {
		return this.syncWithBody({
			sync_token: '*',
			resource_types: '[]',
			commands: JSON.stringify(commands),
		});
	}

	private async syncWithBody(params: Record<string, string>) {
		const body = new URLSearchParams({ ...params }).toString();
		await this.rateLimiter.throttle();
		return withRetryOn429(() => requestUrl({
			url: 'https://api.todoist.com/api/v1/sync',
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			headers: {
				Authorization: `Bearer ${this.token}`,
			},
			body,
			throw: false,
		}));
	}
}

function buildDueObject(dueDate?: string, dueString?: string): { date?: string; string?: string } | undefined {
	const normalizedDate = dueDate?.trim() || '';
	const normalizedString = dueString?.trim() || '';
	if (!normalizedDate && !normalizedString) {
		return undefined;
	}
	return {
		...(normalizedDate ? { date: normalizedDate } : {}),
		...(normalizedString ? { string: normalizedString } : {}),
	};
}

function generateUuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assertSyncStatusOk(payload: TodoistSyncResponse, commandId: string, label: string): void {
	const status = payload.sync_status?.[commandId];
	if (status === 'ok') {
		return;
	}
	if (isNotFoundStatus(status)) {
		throw new TodoistNotFoundError(`Todoist ${label} command failed: item not found.`);
	}
	throw new Error(`Todoist ${label} command failed.`);
}

/** Detects a Sync API per-command error object that means the target item no longer exists. */
function isNotFoundStatus(status: unknown): boolean {
	if (!status || typeof status !== 'object') {
		return false;
	}
	const s = status as { http_code?: unknown; error_code?: unknown; error?: unknown };
	if (s.http_code === 404) {
		return true;
	}
	// Todoist's item-not-found maps to error_code 22.
	if (s.error_code === 22) {
		return true;
	}
	if (typeof s.error === 'string' && /not\s*found|does(?:n'?t| not) exist/i.test(s.error)) {
		return true;
	}
	return false;
}

function normalizeItems(rawItems: Array<Record<string, unknown>>): TodoistItem[] {
	const items: TodoistItem[] = [];
	for (const raw of rawItems) {
		const id = toId(raw.id);
		const content = toStringValue(raw.content);
		const projectId = toId(raw.project_id);
		if (!id || !content || !projectId) {
			continue;
		}

		items.push({
			id,
			content,
			description: toOptionalString(raw.description),
			project_id: projectId,
			section_id: toOptionalId(raw.section_id),
			parent_id: toOptionalId(raw.parent_id),
			priority: toOptionalNumber(raw.priority),
			due: toDue(raw.due),
			labels: toStringArray(raw.labels),
			checked: Boolean(raw.checked),
			is_deleted: Boolean(raw.is_deleted),
			responsible_uid: toOptionalId(raw.responsible_uid),
			deadline: toDeadline(raw.deadline),
			duration: toDuration(raw.duration),
			order: toOptionalNumber(raw.order),
		});
	}
	return items;
}

function normalizeProjects(rawProjects: Array<Record<string, unknown>>): TodoistProject[] {
	return rawProjects
		.map((raw) => {
			const id = toId(raw.id);
			const name = toStringValue(raw.name);
			if (!id || !name) {
				return null;
			}
			return { id, name, parent_id: toOptionalId(raw.parent_id), is_archived: Boolean(raw.is_archived), color: typeof raw.color === 'string' ? raw.color : null };
		})
		.filter((project): project is TodoistProject => Boolean(project));
}

function normalizeSections(rawSections: Array<Record<string, unknown>>): TodoistSection[] {
	return rawSections
		.map((raw) => {
			const id = toId(raw.id);
			const name = toStringValue(raw.name);
			const projectId = toId(raw.project_id);
			if (!id || !name || !projectId) {
				return null;
			}
			return { id, name, project_id: projectId, is_archived: Boolean(raw.is_archived) };
		})
		.filter((section): section is TodoistSection => Boolean(section));
}

function toId(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	if (typeof value === 'number') {
		return String(value);
	}
	return null;
}

function toOptionalId(value: unknown): string | null {
	return toId(value);
}

function toStringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return null;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function toDue(value: unknown): {
	date?: string | null;
	string?: string | null;
	is_recurring?: boolean | null;
	datetime?: string | null;
	timezone?: string | null;
	lang?: string | null;
} | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const due = value as {
		date?: unknown;
		string?: unknown;
		is_recurring?: unknown;
		datetime?: unknown;
		timezone?: unknown;
		lang?: unknown;
	};

	const normalized = {
		date: typeof due.date === 'string' ? due.date : null,
		string: typeof due.string === 'string' ? due.string : null,
		is_recurring: typeof due.is_recurring === 'boolean' ? due.is_recurring : null,
		datetime: typeof due.datetime === 'string' ? due.datetime : null,
		timezone: typeof due.timezone === 'string' ? due.timezone : null,
		lang: typeof due.lang === 'string' ? due.lang : null,
	};

	if (
		normalized.date === null &&
		normalized.string === null &&
		normalized.is_recurring === null &&
		normalized.datetime === null &&
		normalized.timezone === null &&
		normalized.lang === null
	) {
		return null;
	}

	return normalized;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === 'string');
}

function toDeadline(value: unknown): { date: string; lang?: string | null } | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const dl = value as { date?: unknown; lang?: unknown };
	const date = typeof dl.date === 'string' && dl.date.trim() ? dl.date : null;
	if (!date) {
		return null;
	}
	return {
		date,
		lang: typeof dl.lang === 'string' ? dl.lang : null,
	};
}

function toDuration(value: unknown): { amount: number; unit: string } | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const d = value as { amount?: unknown; unit?: unknown };
	if (typeof d.amount !== 'number' || typeof d.unit !== 'string') {
		return null;
	}
	return { amount: d.amount, unit: d.unit };
}
