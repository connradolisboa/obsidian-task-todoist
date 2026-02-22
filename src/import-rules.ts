import type { TaskTodoistSettings } from './settings';
import type { TodoistItem, TodoistProject } from './todoist-client';

export function filterImportableItems(
	items: TodoistItem[],
	projects: TodoistProject[],
	settings: TaskTodoistSettings,
	userId: string | null,
	sectionNameById: Map<string, string> = new Map(),
): TodoistItem[] {
	if (!settings.autoImportEnabled) {
		return [];
	}

	const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
	const allowedProjectNames = parseNameSet(settings.autoImportAllowedProjectNames);
	const excludedProjectNames = parseNameSet(settings.excludedProjectNames);
	const excludedSectionNames = parseNameSet(settings.excludedSectionNames);
	const requiredLabel = settings.autoImportRequiredLabel.trim().toLowerCase();

	return items.filter((item) => {
		if (item.is_deleted) {
			return false;
		}

		if (settings.autoImportAssignedToMeOnly && userId && item.responsible_uid && item.responsible_uid !== userId) {
			return false;
		}

		const projectName = projectNameById.get(item.project_id)?.toLowerCase();

		if (settings.autoImportProjectScope === 'allow-list-by-name' && allowedProjectNames.size > 0) {
			if (!projectName || !allowedProjectNames.has(projectName)) {
				return false;
			}
		}

		if (excludedProjectNames.size > 0 && projectName && excludedProjectNames.has(projectName)) {
			return false;
		}

		if (excludedSectionNames.size > 0 && item.section_id) {
			const sectionName = sectionNameById.get(item.section_id)?.toLowerCase();
			if (sectionName && excludedSectionNames.has(sectionName)) {
				return false;
			}
		}

		if (requiredLabel) {
			const labels = (item.labels ?? []).map((label) => label.toLowerCase());
			if (!labels.includes(requiredLabel)) {
				return false;
			}
		}

		return true;
	});
}

function parseNameSet(rawValue: string): Set<string> {
	return new Set(
		(rawValue ?? '')
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
}
