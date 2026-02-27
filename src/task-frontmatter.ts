import type { PropNames, TaskTodoistSettings } from './settings';
import { resolveTemplateVars } from './template-variables';

export function getPropNames(settings: TaskTodoistSettings): PropNames {
	return settings.propNames;
}

export function applyStandardTaskFrontmatter(
	frontmatter: Record<string, unknown>,
	settings: TaskTodoistSettings,
	options?: { skipDefaultTag?: boolean },
): void {
	const p = getPropNames(settings);

	if (typeof frontmatter[p.created] !== 'string' || !(frontmatter[p.created] as string).trim()) {
		frontmatter[p.created] = formatCreatedDate(new Date());
	}
	if (typeof frontmatter[p.modified] !== 'string' || !(frontmatter[p.modified] as string).trim()) {
		frontmatter[p.modified] = formatModifiedDate(new Date());
	}

	// Dual-purpose project notes (todoist_project_task_id === todoist_id, both non-empty)
	// must never receive the default task tag, regardless of the call site.
	const rawProjectTaskId = frontmatter[p.todoistProjectTaskId];
	const rawTaskId = frontmatter[p.todoistId];
	const isDualPurpose =
		typeof rawProjectTaskId === 'string' &&
		rawProjectTaskId.trim() !== '' &&
		typeof rawTaskId === 'string' &&
		rawProjectTaskId.trim() === rawTaskId.trim();

	if (!options?.skipDefaultTag && !isDualPurpose) {
		const defaultTag = normalizeTag(resolveTemplateVars(settings.defaultTaskTag));
		const existingTags = normalizeTags(frontmatter[p.tags]);
		if (defaultTag && !existingTags.includes(defaultTag)) {
			existingTags.unshift(defaultTag);
		}
		frontmatter[p.tags] = existingTags;
	}
}

export function touchModifiedDate(frontmatter: Record<string, unknown>, settings: TaskTodoistSettings): void {
	frontmatter[getPropNames(settings).modified] = formatModifiedDate(new Date());
}

export function getTaskTitle(frontmatter: Record<string, unknown>, settings: TaskTodoistSettings, fallback = ''): string {
	const p = getPropNames(settings);
	const taskTitle = typeof frontmatter[p.taskTitle] === 'string' ? (frontmatter[p.taskTitle] as string).trim() : '';
	if (taskTitle) {
		return taskTitle;
	}
	// Legacy fallback
	const legacyTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
	if (legacyTitle) {
		return legacyTitle;
	}
	return fallback;
}

export function getTaskStatus(frontmatter: Record<string, unknown>, settings: TaskTodoistSettings): 'open' | 'done' {
	const p = getPropNames(settings);
	const taskDone = frontmatter[p.taskDone];
	if (taskDone === true || taskDone === 'true') {
		return 'done';
	}
	if (taskDone === false || taskDone === 'false') {
		return 'open';
	}
	const taskStatus = typeof frontmatter[p.taskStatus] === 'string'
		? (frontmatter[p.taskStatus] as string).trim().toLowerCase()
		: '';
	if (taskStatus === 'done') {
		return 'done';
	}
	if (taskStatus === 'open') {
		return 'open';
	}
	// Legacy fallbacks
	if (frontmatter.done === true || frontmatter.done === 'true') {
		return 'done';
	}
	const legacyStatus = typeof frontmatter.status === 'string' ? frontmatter.status.trim().toLowerCase() : '';
	if (legacyStatus === 'done') {
		return 'done';
	}
	return 'open';
}

export function setTaskTitle(frontmatter: Record<string, unknown>, title: string, settings: TaskTodoistSettings): void {
	const p = getPropNames(settings);
	frontmatter[p.taskTitle] = title;
	// Remove legacy keys if present
	if (p.taskTitle !== 'title' && 'title' in frontmatter) {
		delete frontmatter.title;
	}
}

export function setTaskStatus(
	frontmatter: Record<string, unknown>,
	status: 'open' | 'done',
	settings: TaskTodoistSettings,
	preserveCustom = false,
): void {
	const p = getPropNames(settings);

	if (preserveCustom) {
		const currentStatus = typeof frontmatter[p.taskStatus] === 'string'
			? (frontmatter[p.taskStatus] as string).trim().toLowerCase()
			: '';
		const isCustomStatus = currentStatus !== '' && currentStatus !== 'done' && currentStatus !== 'open';
		if (isCustomStatus) {
			// Only update task_done; leave task_status untouched
			frontmatter[p.taskDone] = status === 'done';
			return;
		}
	}

	frontmatter[p.taskStatus] = status === 'done' ? 'Done' : 'Open';
	frontmatter[p.taskDone] = status === 'done';
	// Remove legacy keys if present
	if (p.taskStatus !== 'status' && 'status' in frontmatter) {
		delete frontmatter.status;
	}
	if (p.taskDone !== 'done' && 'done' in frontmatter) {
		delete frontmatter.done;
	}
}

/**
 * Maps a Todoist numeric priority to a human-readable label.
 * Todoist API: 4 = urgent (p1), 3 = high (p2), 2 = medium (p3), 1 = normal (p4).
 */
export function priorityLabel(priority: number): string {
	const map: Record<number, string> = { 4: 'High', 3: 'Medium', 2: 'Low', 1: 'None' };
	return map[priority] ?? 'none';
}

export function getDefaultTaskTag(settings: TaskTodoistSettings): string | null {
	return normalizeTag(resolveTemplateVars(settings.defaultTaskTag));
}

export function formatCreatedDate(date: Date): string {
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	return `${year}-${month}-${day}`;
}

export function formatModifiedDate(date: Date): string {
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hours = pad2(date.getHours());
	const minutes = pad2(date.getMinutes());
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function normalizeTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.map((entry) => normalizeTag(entry))
			.filter((entry): entry is string => Boolean(entry));
	}
	if (typeof value === 'string') {
		const normalized = normalizeTag(value);
		return normalized ? [normalized] : [];
	}
	return [];
}

function normalizeTag(value: string | undefined): string | null {
	const trimmed = (value ?? '').trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/^#+/, '');
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

export function generateUuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Fallback pseudo-UUID v4
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.floor((Date.now() * Math.random() * 16)) % 16;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}
