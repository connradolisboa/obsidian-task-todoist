import { App, TFile, normalizePath } from 'obsidian';
import type { TaskTodoistSettings } from './settings';
import { formatCreatedDate, formatModifiedDate, generateUuid, getDefaultTaskTag, getPropNames, priorityLabel } from './task-frontmatter';
import { resolveTemplateVars, TaskTemplateContext } from './template-variables';

export interface LocalTaskNoteInput {
	title: string;
	description?: string;
	parentTaskLink?: string;
	todoistSync: boolean;
	todoistId?: string;
	todoistProjectId?: string;
	todoistProjectName?: string;
	todoistSectionId?: string;
	todoistSectionName?: string;
	todoistDueDate?: string;
	todoistDueString?: string;
	todoistDeadlineDate?: string;
	todoistPriority?: number;
}

export async function createLocalTaskNote(
	app: App,
	settings: TaskTodoistSettings,
	input: LocalTaskNoteInput,
): Promise<TFile> {
	const resolvedFolder = resolveTemplateVars(settings.tasksFolderPath);
	const folderPath = buildTaskFolderPath(resolvedFolder, settings, input.todoistProjectName, input.todoistSectionName);
	await ensureFolderExists(app, folderPath);

	const filePath = await getUniqueTaskFilePath(app, folderPath, input.title);
	const now = new Date();
	const p = getPropNames(settings);
	const defaultTag = getDefaultTaskTag(settings);
	const dueDate = input.todoistDueDate?.trim() ?? '';
	const dueString = input.todoistDueString?.trim() ?? '';
	const isRecurring = Boolean(dueString);
	const rawProjectName = input.todoistProjectName?.trim() ?? '';
	const effectiveProjectName = input.todoistSync ? (rawProjectName || 'Inbox') : rawProjectName;
	const effectiveProjectId = input.todoistProjectId?.trim() ?? '';
	const effectiveSectionId = input.todoistSectionId?.trim() ?? '';
	const effectiveSectionName = input.todoistSectionName?.trim() ?? '';
	const todoistId = input.todoistId?.trim() ?? '';
	const todoistUrl = input.todoistSync && todoistId
		? buildTodoistUrl(todoistId, settings)
		: '';
	const description = input.description?.trim() ?? '';
	const deadlineDate = input.todoistDeadlineDate?.trim() ?? '';
	const priority = input.todoistPriority ?? 1;
	const createdDateStr = formatCreatedDate(now);

	if (settings.noteTemplate?.trim()) {
		const context: TaskTemplateContext = {
			title: input.title,
			description,
			due_date: dueDate,
			due_string: dueString,
			deadline_date: deadlineDate,
			priority,
			priority_label: priorityLabel(priority),
			project: effectiveProjectName,
			project_id: effectiveProjectId,
			section: effectiveSectionName,
			section_id: effectiveSectionId,
			todoist_id: todoistId,
			url: todoistUrl,
			tags: defaultTag ?? '',
			created: createdDateStr,
			parent_task_link: input.parentTaskLink?.trim() ?? '',
		};
		const content = resolveTemplateVars(settings.noteTemplate, now, context);
		const file = await app.vault.create(filePath, content);
		// Hydrate all required frontmatter properties. The template provides layout/body
		// structure; hydration ensures all properties are set even if the template only
		// listed property names with empty values (or omitted them entirely).
		await app.fileManager.processFrontMatter(file, (frontmatter) => {
			const data = frontmatter as Record<string, unknown>;
			// vault_id: always generate a fresh UUID for each new note
			data[p.vaultId] = generateUuid();
			// Fill in if missing or empty
			if (!data[p.created]) data[p.created] = createdDateStr;
			if (!data[p.modified]) data[p.modified] = formatModifiedDate(now);
			const existingTags = data[p.tags];
			if (!existingTags || (Array.isArray(existingTags) && (existingTags as unknown[]).length === 0)) {
				data[p.tags] = defaultTag ? [defaultTag] : ['tasks'];
			}
			// Task fields: always set
			data[p.taskTitle] = input.title;
			data[p.taskStatus] = 'Open';
			data[p.taskDone] = false;
			if (input.parentTaskLink?.trim()) {
				data[p.parentTask] = input.parentTaskLink.trim();
			}
			// Todoist sync properties: always set
			data[p.todoistSync] = input.todoistSync;
			data[p.todoistId] = todoistId;
			data[p.todoistProjectId] = effectiveProjectId;
			data[p.todoistProjectName] = effectiveProjectName;
			data[p.todoistSectionId] = effectiveSectionId;
			data[p.todoistSectionName] = effectiveSectionName;
			data[p.todoistPriority] = priority;
			data[p.todoistPriorityLabel] = priorityLabel(priority);
			data[p.todoistDue] = dueDate;
			data[p.todoistDueString] = dueString;
			data[p.todoistIsRecurring] = isRecurring;
			data[p.todoistDeadline] = deadlineDate || null;
			data[p.todoistDescription] = description;
			data[p.todoistUrl] = todoistUrl;
			// Project/section links: empty for locally created notes (set by sync when the task is imported)
			if (!data[p.todoistProjectLink]) data[p.todoistProjectLink] = '';
			if (!data[p.todoistSectionLink]) data[p.todoistSectionLink] = '';
			data[p.todoistSyncStatus] = input.todoistSync ? 'queued_local_create' : 'local_only';
			data[p.localUpdatedAt] = new Date().toISOString();
		});
		return file;
	}

	const frontmatter = [
		'---',
		`${p.vaultId}: "${generateUuid()}"`,
		`${p.taskStatus}: Open`,
		`${p.taskDone}: false`,
		`${p.created}: "${createdDateStr}"`,
		`${p.modified}: "${formatModifiedDate(now)}"`,
		`${p.tags}:`,
		defaultTag ? `  - ${defaultTag}` : '  - tasks',
		`${p.taskTitle}: "${escapeDoubleQuotes(input.title)}"`,
		input.parentTaskLink?.trim() ? `${p.parentTask}: "${escapeDoubleQuotes(input.parentTaskLink.trim())}"` : null,
		`${p.todoistSync}: ${input.todoistSync ? 'true' : 'false'}`,
		`${p.todoistId}: "${escapeDoubleQuotes(todoistId)}"`,
		`${p.todoistProjectId}: "${escapeDoubleQuotes(effectiveProjectId)}"`,
		`${p.todoistProjectName}: "${escapeDoubleQuotes(effectiveProjectName)}"`,
		`${p.todoistSectionId}: "${escapeDoubleQuotes(effectiveSectionId)}"`,
		`${p.todoistSectionName}: "${escapeDoubleQuotes(effectiveSectionName)}"`,
		`${p.todoistPriority}: ${priority}`,
		`${p.todoistPriorityLabel}: "${priorityLabel(priority)}"`,
		`${p.todoistDue}: "${escapeDoubleQuotes(dueDate)}"`,
		`${p.todoistDueString}: "${escapeDoubleQuotes(dueString)}"`,
		`${p.todoistIsRecurring}: ${isRecurring ? 'true' : 'false'}`,
		deadlineDate ? `${p.todoistDeadline}: "${escapeDoubleQuotes(deadlineDate)}"` : `${p.todoistDeadline}: null`,
		`${p.todoistDescription}: "${escapeDoubleQuotes(description)}"`,
		todoistUrl ? `${p.todoistUrl}: "${escapeDoubleQuotes(todoistUrl)}"` : `${p.todoistUrl}: ""`,
		`${p.todoistProjectLink}: ""`,
		`${p.todoistSectionLink}: ""`,
		`${p.todoistSyncStatus}: "${input.todoistSync ? 'queued_local_create' : 'local_only'}"`,
		`${p.localUpdatedAt}: "${new Date().toISOString()}"`,
		'---',
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

export function buildTodoistUrl(todoistId: string, settings: TaskTodoistSettings): string {
	if (settings.todoistLinkStyle === 'app') {
		return `todoist://task?id=${todoistId}`;
	}
	return `https://app.todoist.com/app/task/${todoistId}`;
}

function buildTaskFolderPath(
	resolvedBaseFolder: string,
	settings: TaskTodoistSettings,
	projectName?: string,
	sectionName?: string,
): string {
	if (!settings.useProjectSubfolders || !projectName?.trim()) {
		return resolvedBaseFolder;
	}
	const sanitizedProject = sanitizeFileName(projectName.trim());
	if (!sanitizedProject) {
		return resolvedBaseFolder;
	}
	const projectPath = `${resolvedBaseFolder}/${sanitizedProject}`;

	if (settings.useSectionSubfolders && sectionName?.trim()) {
		const sanitizedSection = sanitizeFileName(sectionName.trim());
		if (sanitizedSection) {
			return `${projectPath}/${sanitizedSection}`;
		}
	}
	return projectPath;
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

export function sanitizeFileName(value: string): string {
	return value
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);
}

function escapeDoubleQuotes(value: string): string {
	return value.replace(/"/g, '\\"');
}
