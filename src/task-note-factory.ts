import { App, TFile, normalizePath } from 'obsidian';
import type { TaskTodoistSettings } from './settings';
import { formatCreatedDate, formatModifiedDate, getDefaultTaskTag } from './task-frontmatter';

export interface LocalTaskNoteInput {
	title: string;
	description?: string;
	parentTaskLink?: string;
	todoistSync: boolean;
	todoistProjectId?: string;
	todoistProjectName?: string;
	todoistSectionId?: string;
	todoistSectionName?: string;
	todoistDueDate?: string;
	todoistDueString?: string;
}

export async function createLocalTaskNote(
	app: App,
	settings: TaskTodoistSettings,
	input: LocalTaskNoteInput,
): Promise<TFile> {
	await ensureFolderExists(app, settings.tasksFolderPath);

	const filePath = await getUniqueTaskFilePath(app, settings.tasksFolderPath, input.title);
	const now = new Date();
	const defaultTag = getDefaultTaskTag(settings);
	const dueDate = input.todoistDueDate?.trim() ?? '';
	const dueString = input.todoistDueString?.trim() ?? '';
	const isRecurring = Boolean(dueString);
	const rawProjectName = input.todoistProjectName?.trim() ?? '';
	const effectiveProjectName = input.todoistSync ? (rawProjectName || 'Inbox') : rawProjectName;
	const effectiveProjectId = input.todoistProjectId?.trim() ?? '';
	const effectiveSectionId = input.todoistSectionId?.trim() ?? '';
	const effectiveSectionName = input.todoistSectionName?.trim() ?? '';
	const frontmatter = [
		'---',
		'task_status: open',
		'task_done: false',
		`created: "${formatCreatedDate(now)}"`,
		`modified: "${formatModifiedDate(now)}"`,
		'tags:',
		defaultTag ? `  - ${defaultTag}` : '  - tasks',
		'links: []',
		`task_title: "${escapeDoubleQuotes(input.title)}"`,
		input.parentTaskLink?.trim() ? `parent_task: "${escapeDoubleQuotes(input.parentTaskLink.trim())}"` : null,
		`todoist_sync: ${input.todoistSync ? 'true' : 'false'}`,
		`todoist_project_id: "${escapeDoubleQuotes(effectiveProjectId)}"`,
		`todoist_project_name: "${escapeDoubleQuotes(effectiveProjectName)}"`,
		`todoist_section_id: "${escapeDoubleQuotes(effectiveSectionId)}"`,
		`todoist_section_name: "${escapeDoubleQuotes(effectiveSectionName)}"`,
		`todoist_due: "${escapeDoubleQuotes(dueDate)}"`,
		`todoist_due_string: "${escapeDoubleQuotes(dueString)}"`,
		`todoist_is_recurring: ${isRecurring ? 'true' : 'false'}`,
		`todoist_sync_status: "${input.todoistSync ? 'queued_local_create' : 'local_only'}"`,
		`local_updated_at: "${new Date().toISOString()}"`,
		'---',
		'',
		input.description?.trim() ?? '',
		'',
	]
		.filter((line): line is string => line !== null)
		.join('\n');

	return app.vault.create(filePath, frontmatter);
}

export function toTaskWikiLink(file: TFile, alias?: string): string {
	const linkTarget = file.path.replace(/\.md$/i, '');
	if (alias?.trim()) {
		return `[[${linkTarget}|${alias.trim()}]]`;
	}
	return `[[${linkTarget}]]`;
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	if (!normalized) {
		return;
	}

	const parts = normalized.split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

async function getUniqueTaskFilePath(app: App, tasksFolderPath: string, taskTitle: string): Promise<string> {
	const folder = normalizePath(tasksFolderPath);
	const base = sanitizeFileName(taskTitle) || 'Task';
	let candidate = normalizePath(`${folder}/${base}.md`);
	if (!app.vault.getAbstractFileByPath(candidate)) {
		return candidate;
	}

	let suffix = 2;
	while (true) {
		candidate = normalizePath(`${folder}/${base}-${suffix}.md`);
		if (!app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
		suffix += 1;
	}
}

function sanitizeFileName(value: string): string {
	return value
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function escapeDoubleQuotes(value: string): string {
	return value.replace(/"/g, '\\"');
}
