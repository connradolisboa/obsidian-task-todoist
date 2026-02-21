function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * Resolves date-based template variables in a string.
 * Supported tokens:
 *   {{YYYY}}       4-digit year      (e.g. 2026)
 *   {{YY}}         2-digit year      (e.g. 26)
 *   {{MM}}         2-digit month     (e.g. 02)
 *   {{M}}          month, no pad     (e.g. 2)
 *   {{DD}}         2-digit day       (e.g. 07)
 *   {{D}}          day, no pad       (e.g. 7)
 *   {{YYYY-MM}}    year-month        (e.g. 2026-02)
 *   {{YYYY-MM-DD}} full date         (e.g. 2026-02-07)
 *
 * When a TaskTemplateContext is provided, additional task-specific tokens are resolved.
 * When a ProjectTemplateContext is provided, project-specific tokens are resolved.
 * When a SectionTemplateContext is provided, section-specific tokens are resolved.
 */

export interface TaskTemplateContext {
	title: string;
	description?: string;
	due_date?: string;
	due_string?: string;
	deadline_date?: string;
	priority?: number;
	priority_label?: string;
	project?: string;
	project_id?: string;
	section?: string;
	section_id?: string;
	todoist_id?: string;
	url?: string;
	tags?: string;
	created?: string;
}

export interface ProjectTemplateContext {
	project_name: string;
	project_id: string;
}

export interface SectionTemplateContext {
	section_name: string;
	section_id: string;
	project_name: string;
	project_id: string;
}

export function resolveTemplateVars(template: string, date?: Date): string;
export function resolveTemplateVars(template: string, date: Date | undefined, context: TaskTemplateContext): string;
export function resolveTemplateVars(template: string, date: Date | undefined, context: ProjectTemplateContext): string;
export function resolveTemplateVars(template: string, date: Date | undefined, context: SectionTemplateContext): string;
export function resolveTemplateVars(
	template: string,
	date: Date = new Date(),
	context?: TaskTemplateContext | ProjectTemplateContext | SectionTemplateContext,
): string {
	const d = date ?? new Date();
	const yyyy = String(d.getFullYear());
	const yy = yyyy.slice(-2);
	const mm = pad2(d.getMonth() + 1);
	const m = String(d.getMonth() + 1);
	const dd = pad2(d.getDate());
	const dStr = String(d.getDate());

	let result = template
		.replace(/\{\{YYYY-MM-DD\}\}/g, `${yyyy}-${mm}-${dd}`)
		.replace(/\{\{YYYY-MM\}\}/g, `${yyyy}-${mm}`)
		.replace(/\{\{YYYY\}\}/g, yyyy)
		.replace(/\{\{YY\}\}/g, yy)
		.replace(/\{\{MM\}\}/g, mm)
		.replace(/\{\{M\}\}/g, m)
		.replace(/\{\{DD\}\}/g, dd)
		.replace(/\{\{D\}\}/g, dStr);

	if (!context) {
		return result;
	}

	// Task context
	if ('title' in context) {
		const tc = context as TaskTemplateContext;
		result = result
			.replace(/\{\{title\}\}/g, tc.title ?? '')
			.replace(/\{\{description\}\}/g, tc.description ?? '')
			.replace(/\{\{due_date\}\}/g, tc.due_date ?? '')
			.replace(/\{\{due_string\}\}/g, tc.due_string ?? '')
			.replace(/\{\{deadline_date\}\}/g, tc.deadline_date ?? '')
			.replace(/\{\{priority\}\}/g, tc.priority != null ? String(tc.priority) : '')
			.replace(/\{\{priority_label\}\}/g, tc.priority_label ?? '')
			.replace(/\{\{project\}\}/g, tc.project ?? '')
			.replace(/\{\{project_id\}\}/g, tc.project_id ?? '')
			.replace(/\{\{section\}\}/g, tc.section ?? '')
			.replace(/\{\{section_id\}\}/g, tc.section_id ?? '')
			.replace(/\{\{todoist_id\}\}/g, tc.todoist_id ?? '')
			.replace(/\{\{url\}\}/g, tc.url ?? '')
			.replace(/\{\{tags\}\}/g, tc.tags ?? '')
			.replace(/\{\{created\}\}/g, tc.created ?? `${yyyy}-${mm}-${dd}`);
		return result;
	}

	// Section context (check before project — it has more fields)
	if ('section_name' in context) {
		const sc = context as SectionTemplateContext;
		result = result
			.replace(/\{\{section_name\}\}/g, sc.section_name ?? '')
			.replace(/\{\{section_id\}\}/g, sc.section_id ?? '')
			.replace(/\{\{project_name\}\}/g, sc.project_name ?? '')
			.replace(/\{\{project_id\}\}/g, sc.project_id ?? '');
		return result;
	}

	// Project context
	if ('project_name' in context) {
		const pc = context as ProjectTemplateContext;
		result = result
			.replace(/\{\{project_name\}\}/g, pc.project_name ?? '')
			.replace(/\{\{project_id\}\}/g, pc.project_id ?? '');
		return result;
	}

	return result;
}
