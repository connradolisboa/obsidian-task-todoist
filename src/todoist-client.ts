import { requestUrl } from 'obsidian';

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
}

export interface TodoistProject {
	id: string;
	name: string;
	parent_id: string | null;
	is_archived: boolean;
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
}

export interface TodoistProjectSectionLookup {
	projects: TodoistProject[];
	sections: TodoistSection[];
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
}

export interface TodoistTaskUpdateInput {
	id: string;
	content: string;
	description?: string;
	isDone: boolean;
	isRecurring?: boolean;
	projectId?: string;
	sectionId?: string;
	dueDate?: string;
	dueString?: string;
	clearDue?: boolean;
}

interface TodoistSyncResponse {
	user?: { id?: string | number };
	items?: Array<Record<string, unknown>>;
	projects?: Array<Record<string, unknown>>;
	sections?: Array<Record<string, unknown>>;
	temp_id_mapping?: Record<string, string>;
	sync_status?: Record<string, unknown>;
}

export class TodoistClient {
	private readonly token: string;

	constructor(token: string) {
		this.token = token;
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
		};
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
				content: input.content,
				description: input.description ?? '',
				...(input.projectId ? { project_id: input.projectId } : {}),
				...(input.sectionId ? { section_id: input.sectionId } : {}),
				...(isRecurringCompletion ? {} : (due ? { due } : {})),
				...(isRecurringCompletion ? {} : (!due && input.clearDue ? { due: null } : {})),
			},
		});

		const statusCommandId = generateUuid();
		commands.push({
			type: input.isDone ? 'item_close' : 'item_uncomplete',
			uuid: statusCommandId,
			args: {
				id: input.id,
			},
		});

		const response = await this.syncWithCommands(commands);
		if (response.status === 401) {
			throw new Error('Todoist authentication failed. Check your token.');
		}
		if (response.status !== 200) {
			throw new Error(`Todoist update task failed with status ${response.status}.`);
		}

		const payload = response.json as TodoistSyncResponse;
		assertSyncStatusOk(payload, updateCommandId, 'update');
		assertSyncStatusOk(
			payload,
			statusCommandId,
			input.isDone ? 'close' : 'uncomplete',
		);
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
			resource_types: '["items"]',
			commands: JSON.stringify(commands),
		});
	}

	private async syncWithBody(params: Record<string, string>) {
		const body = new URLSearchParams({
			...params,
		}).toString();

		return requestUrl({
			url: 'https://api.todoist.com/api/v1/sync',
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			headers: {
				Authorization: `Bearer ${this.token}`,
			},
			body,
			throw: false,
		});
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
	if (status !== 'ok') {
		throw new Error(`Todoist ${label} command failed.`);
	}
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
			return { id, name, parent_id: toOptionalId(raw.parent_id), is_archived: Boolean(raw.is_archived) };
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
