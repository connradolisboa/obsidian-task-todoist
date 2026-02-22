import { MarkdownPostProcessorContext, Notice, Plugin, TFile } from 'obsidian';
import type TaskTodoistPlugin from './main';
import { toTaskWikiLink } from './task-note-factory';

const UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;

export function registerInlineTaskConverter(plugin: TaskTodoistPlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const taskItems = el.querySelectorAll('li');
		taskItems.forEach((taskItem) => {
			if (!(taskItem instanceof HTMLLIElement)) {
				return;
			}
			const listItem = taskItem;
			if (listItem.dataset.todoistConvertReady === 'true') {
				return;
			}

			const checkbox = listItem.querySelector('input[type="checkbox"]');
			if (!(checkbox instanceof HTMLInputElement) || checkbox.checked) {
				return;
			}

			if (!plugin.settings.showConvertButton) {
				return;
			}

			const taskText = extractTaskText(listItem);
			if (!taskText) {
				return;
			}

			const button = createConvertButton();
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void convertInlineTask(plugin, ctx, listItem, taskText);
			});

			const container = listItem.querySelector('.task-list-item-checkbox')?.parentElement ?? listItem;
			container.appendChild(button);
			listItem.dataset.todoistConvertReady = 'true';
		});
	});
}

async function convertInlineTask(
	plugin: TaskTodoistPlugin,
	ctx: MarkdownPostProcessorContext,
	listItem: HTMLLIElement,
	taskText: string,
): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) {
		new Notice('Unable to locate source file for task conversion.', 5000);
		return;
	}

	try {
		const createdTaskNote = await plugin.createTaskNote({
			title: taskText,
			description: '',
			todoistSync: true,
			todoistDueDate: '',
			todoistDueString: '',
		});

		const updated = await replaceTaskLineWithLink(plugin, ctx, listItem, file, taskText, createdTaskNote);
		if (!updated) {
			new Notice('Task note created, but original task line was not updated.', 6000);
			return;
		}

		new Notice(`Converted task to note: ${createdTaskNote.basename}`, 5000);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown conversion error';
		new Notice(`Task conversion failed: ${message}`, 6000);
	}
}

async function replaceTaskLineWithLink(
	plugin: Plugin,
	ctx: MarkdownPostProcessorContext,
	listItem: HTMLLIElement,
	file: TFile,
	taskText: string,
	createdTaskNote: TFile,
): Promise<boolean> {
	const sectionInfo = ctx.getSectionInfo(listItem);
	const content = await plugin.app.vault.cachedRead(file);
	const lines = content.split('\n');

	const start = sectionInfo ? Math.max(0, sectionInfo.lineStart) : 0;
	const endExclusive = sectionInfo ? Math.min(lines.length, sectionInfo.lineEnd + 1) : lines.length;

	const link = toTaskWikiLink(createdTaskNote, taskText);
	const targetLineIndex = findTaskLineIndex(lines, start, endExclusive, taskText);
	if (targetLineIndex < 0) {
		return false;
	}

	const originalLine = lines[targetLineIndex];
	if (!originalLine) {
		return false;
	}

	const lineMatch = originalLine.match(UNCHECKED_TASK_LINE_REGEX);
	if (!lineMatch) {
		return false;
	}

	lines[targetLineIndex] = `${lineMatch[1]}${link}`;
	await plugin.app.vault.modify(file, lines.join('\n'));
	return true;
}

function findTaskLineIndex(lines: string[], start: number, endExclusive: number, taskText: string): number {
	const normalizedTarget = normalizeTaskText(taskText);
	for (let i = start; i < endExclusive; i += 1) {
		const line = lines[i] ?? '';
		const match = line.match(UNCHECKED_TASK_LINE_REGEX);
		if (!match) {
			continue;
		}

		if (normalizeTaskText(match[2] ?? '') === normalizedTarget) {
			return i;
		}
	}

	for (let i = start; i < endExclusive; i += 1) {
		const line = lines[i] ?? '';
		if (UNCHECKED_TASK_LINE_REGEX.test(line)) {
			return i;
		}
	}
	return -1;
}

function createConvertButton(): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'task-todoist-convert-button';
	button.textContent = '↗';
	button.title = 'Convert to task note';
	button.setAttribute('aria-label', 'Convert to task note');
	return button;
}

function extractTaskText(listItem: HTMLLIElement): string {
	const clone = listItem.cloneNode(true) as HTMLElement;
	clone.querySelectorAll('.task-todoist-convert-button').forEach((button) => button.remove());
	clone.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => checkbox.remove());
	return normalizeTaskText(clone.textContent ?? '');
}

function normalizeTaskText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}
