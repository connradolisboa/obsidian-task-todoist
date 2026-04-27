import { TFile, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskTodoistSettings } from './settings';

export interface DailyNoteEvent {
	action: 'added' | 'completed';
	file: TFile;
	title: string;
	matchingLabel: string;
	project: string;
	/** Project note TFile, used to render {{taskProjectLink}}. Undefined if no project note exists. */
	projectFile?: TFile;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * Resolves date tokens in the daily note path template.
 * Supported tokens:
 *   {{YYYY}}       4-digit year (e.g. 2026)
 *   {{YY}}         2-digit year (e.g. 26)
 *   {{MM}}         2-digit month (e.g. 04)
 *   {{M}}          month, no pad (e.g. 4)
 *   {{DD}}         2-digit day (e.g. 07)
 *   {{D}}          day, no pad (e.g. 7)
 *   {{dddd}}       full day name (e.g. Monday)
 *   {{ddd}}        short day name (e.g. Mon)
 *   {{YYYY-MM}}    year-month (e.g. 2026-04)
 *   {{YYYY-MM-DD}} full date (e.g. 2026-04-26)
 *   {{Q}}          quarter number (e.g. 2)
 *   {{QQ}}         "Q" + quarter (e.g. Q2) — equivalent to moment's [Q]Q
 */
export function resolveDailyNotePath(template: string, date: Date = new Date()): string {
	const yyyy = String(date.getFullYear());
	const yy = yyyy.slice(-2);
	const mm = pad2(date.getMonth() + 1);
	const m = String(date.getMonth() + 1);
	const dd = pad2(date.getDate());
	const d = String(date.getDate());
	const dddd = DAY_NAMES[date.getDay()] ?? '';
	const ddd = DAY_SHORT_NAMES[date.getDay()] ?? '';
	const quarter = Math.ceil((date.getMonth() + 1) / 3);
	const q = String(quarter);
	const qq = `Q${quarter}`;

	return template
		.replace(/\{\{YYYY-MM-DD\}\}/g, `${yyyy}-${mm}-${dd}`)
		.replace(/\{\{YYYY-MM\}\}/g, `${yyyy}-${mm}`)
		.replace(/\{\{YYYY\}\}/g, yyyy)
		.replace(/\{\{YY\}\}/g, yy)
		.replace(/\{\{MM\}\}/g, mm)
		.replace(/\{\{M\}\}/g, m)
		.replace(/\{\{DD\}\}/g, dd)
		.replace(/\{\{D\}\}/g, d)
		.replace(/\{\{dddd\}\}/g, dddd)
		.replace(/\{\{ddd\}\}/g, ddd)
		.replace(/\{\{QQ\}\}/g, qq)
		.replace(/\{\{Q\}\}/g, q);
}

/**
 * Resolves template variables in a daily note line.
 * Available tokens:
 *   {{taskLink}}        wikilink to the task note (e.g. [[Tasks/My Task|My Task]])
 *   {{taskTitle}}       plain task title
 *   {{taskLabel}}       the label that triggered this event
 *   {{taskAction}}      "added" or "completed"
 *   {{taskProject}}     Todoist project name (plain text)
 *   {{taskProjectLink}} wikilink to the project note; falls back to plain project name if no note exists
 */
export function resolveDailyNoteLineTemplate(
	template: string,
	event: DailyNoteEvent,
): string {
	const linkPath = event.file.path.replace(/\.md$/i, '');
	const taskLink = `[[${linkPath}|${event.title}]]`;

	const taskProjectLink = event.projectFile
		? `[[${event.projectFile.path.replace(/\.md$/i, '')}|${event.project}]]`
		: event.project;

	return template
		.replace(/\{\{taskLink\}\}/g, taskLink)
		.replace(/\{\{taskTitle\}\}/g, event.title)
		.replace(/\{\{taskLabel\}\}/g, event.matchingLabel)
		.replace(/\{\{taskAction\}\}/g, event.action)
		.replace(/\{\{taskProject\}\}/g, event.project)
		.replace(/\{\{taskProjectLink\}\}/g, taskProjectLink);
}

/**
 * Appends daily note events to the configured daily note file.
 * Creates the file (and any parent folders) if it does not exist.
 */
export async function appendEventsToDailyNote(
	app: App,
	settings: TaskTodoistSettings,
	events: DailyNoteEvent[],
): Promise<void> {
	if (!settings.dailyNoteEnabled || events.length === 0) return;
	const pathTemplate = settings.dailyNotePath.trim();
	if (!pathTemplate) return;

	const date = new Date();
	const resolved = resolveDailyNotePath(pathTemplate, date);
	const filePath = normalizePath(resolved.endsWith('.md') ? resolved : `${resolved}.md`);

	const lineTemplate = settings.dailyNoteTemplate || '- {{taskAction}}: {{taskLink}} ({{taskLabel}})';
	const lines = events.map((event) => resolveDailyNoteLineTemplate(lineTemplate, event));
	const appendText = '\n' + lines.join('\n');

	const existing = app.vault.getAbstractFileByPath(filePath);
	if (existing instanceof TFile) {
		await app.vault.append(existing, appendText);
	} else {
		// Ensure parent folders exist before creating the file
		const lastSlash = filePath.lastIndexOf('/');
		if (lastSlash > 0) {
			await ensureFolderPath(app, filePath.substring(0, lastSlash));
		}
		await app.vault.create(filePath, appendText.trimStart());
	}
}

async function ensureFolderPath(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	if (app.vault.getAbstractFileByPath(normalized)) return;
	// Create each segment of the path
	const parts = normalized.split('/');
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Folder may have been created concurrently — ignore
			}
		}
	}
}
