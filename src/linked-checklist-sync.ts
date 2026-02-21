import { App, TFile } from 'obsidian';
import { getTaskStatus, getPropNames } from './task-frontmatter';
import type { TaskTodoistSettings } from './settings';

const LINKED_CHECKLIST_LINE_REGEX = /^(\s*[-*+]\s+)\[([ xX])\]\s+\[\[([^\]|]+)(?:\|([^\]]+))?\]\](\s*)$/;

export async function syncLinkedChecklistStates(app: App, settings: TaskTodoistSettings): Promise<number> {
	let changedLines = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		const content = await app.vault.cachedRead(file);
		const lines = content.split('\n');
		let fileChanged = false;

		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? '';
			const match = line.match(LINKED_CHECKLIST_LINE_REGEX);
			if (!match) {
				continue;
			}

			const linkTarget = (match[3] ?? '').trim();
			if (!linkTarget) {
				continue;
			}

			const linkedFile = app.metadataCache.getFirstLinkpathDest(linkTarget, file.path);
			if (!(linkedFile instanceof TFile)) {
				continue;
			}

			const linkedStatus = getLinkedTaskStatus(app, linkedFile, settings);
			if (!linkedStatus) {
				continue;
			}

			const shouldBeChecked = linkedStatus === 'done';
			const isChecked = (match[2] ?? ' ').toLowerCase() === 'x';
			if (isChecked === shouldBeChecked) {
				continue;
			}

			lines[i] = `${match[1]}[${shouldBeChecked ? 'x' : ' '}] [[${match[3]}${match[4] ? `|${match[4]}` : ''}]]${match[5] ?? ''}`;
			fileChanged = true;
			changedLines += 1;
		}

		if (fileChanged) {
			await app.vault.modify(file, lines.join('\n'));
		}
	}

	return changedLines;
}

function getLinkedTaskStatus(app: App, file: TFile, settings: TaskTodoistSettings): 'open' | 'done' | null {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (!frontmatter) {
		return null;
	}
	return getTaskStatus(frontmatter, settings);
}
