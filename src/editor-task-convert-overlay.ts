import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type TaskTodoistPlugin from './main';

const UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[\s\]\s+)(.+)$/;
const LINKED_TASK_LINE_REGEX = /^(\s*[-*+]\s+\[[ xX]\]\s+)(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])(\s*)$/;

export function createTaskConvertOverlayExtension(plugin: TaskTodoistPlugin) {
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet;
		linkedStatusByTarget: Map<string, boolean>;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view, plugin);
			this.linkedStatusByTarget = readLinkedTaskStatusMap(view.state.doc.toString());
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = buildDecorations(update.view, plugin);
			}
			if (update.docChanged) {
				const next = readLinkedTaskStatusMap(update.state.doc.toString());
				for (const [linkTarget, checked] of next) {
					const previous = this.linkedStatusByTarget.get(linkTarget);
					if (previous !== undefined && previous !== checked) {
						void plugin.updateLinkedTaskNoteStatusByLink(linkTarget, checked);
					}
				}
				this.linkedStatusByTarget = next;
			}
		}
	}, {
		decorations: (value) => value.decorations,
	});
}

function buildDecorations(view: EditorView, plugin: TaskTodoistPlugin): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	for (const range of view.visibleRanges) {
		let position = range.from;
		while (position <= range.to) {
			const line = view.state.doc.lineAt(position);

			const linkedMatch = line.text.match(LINKED_TASK_LINE_REGEX);
			if (linkedMatch) {
				const prefix = linkedMatch[1] ?? '';
				const wikiLink = linkedMatch[2] ?? '';
				const linkTarget = linkedMatch[3] ?? '';
				const linkAlias = linkedMatch[4] ?? '';
				const title = normalizeTaskText(linkAlias || basename(linkTarget));

				if (wikiLink && title && linkTarget) {
					const from = line.from + prefix.length;
					const to = from + wikiLink.length;
					builder.add(
						from,
						to,
						Decoration.replace({
							widget: new LinkedTaskTextWidget(plugin, title, linkTarget),
						}),
					);
				}
			} else if (plugin.settings.showConvertButton) {
				const uncheckedMatch = line.text.match(UNCHECKED_TASK_LINE_REGEX);
				if (uncheckedMatch) {
					const title = normalizeTaskText(uncheckedMatch[2] ?? '');
					if (title) {
						builder.add(
							line.to,
							line.to,
							Decoration.widget({
								side: 1,
								widget: new ConvertTaskWidget(plugin, line.number, title),
							}),
						);
					}
				}
			}

			if (line.to >= range.to) {
				break;
			}
			position = line.to + 1;
		}
	}

	return builder.finish();
}

class ConvertTaskWidget extends WidgetType {
	private readonly plugin: TaskTodoistPlugin;
	private readonly lineNumber: number;
	private readonly taskTitle: string;

	constructor(plugin: TaskTodoistPlugin, lineNumber: number, taskTitle: string) {
		super();
		this.plugin = plugin;
		this.lineNumber = lineNumber;
		this.taskTitle = taskTitle;
	}

	toDOM(): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'task-todoist-convert-button';
		button.textContent = '↗';
		button.title = 'Convert to task note';
		button.setAttribute('aria-label', 'Convert to task note');
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.plugin.convertChecklistLineInActiveEditor(this.lineNumber, this.taskTitle);
		});
		return button;
	}
}

class LinkedTaskTextWidget extends WidgetType {
	private readonly plugin: TaskTodoistPlugin;
	private readonly title: string;
	private readonly linkTarget: string;

	constructor(plugin: TaskTodoistPlugin, title: string, linkTarget: string) {
		super();
		this.plugin = plugin;
		this.title = title;
		this.linkTarget = linkTarget;
	}

	toDOM(): HTMLElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'task-todoist-linked-inline';
		button.title = 'Open task note';
		button.setAttribute('aria-label', 'Open task note');

		const titleEl = document.createElement('span');
		titleEl.className = 'task-todoist-inline-title';
		titleEl.textContent = this.title;
		button.appendChild(titleEl);

		const metaSummary = this.plugin.getLinkedTaskMetaSummary(this.linkTarget);
		if (metaSummary) {
			const meta = document.createElement('span');
			meta.className = 'task-todoist-inline-meta';
			meta.textContent = metaSummary;
			button.appendChild(meta);
		}

		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const sourcePath = this.plugin.app.workspace.getActiveFile()?.path ?? '';
			void this.plugin.app.workspace.openLinkText(this.linkTarget, sourcePath, true);
		});
		return button;
	}
}

function normalizeTaskText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function basename(path: string): string {
	const noExt = path.replace(/\.md$/i, '');
	const parts = noExt.split('/');
	return parts[parts.length - 1] ?? noExt;
}

function readLinkedTaskStatusMap(docText: string): Map<string, boolean> {
	const map = new Map<string, boolean>();
	const lines = docText.split('\n');
	for (const line of lines) {
		const match = line.match(LINKED_TASK_LINE_REGEX);
		if (!match) {
			continue;
		}
		const checkedMark = (match[0].match(/\[([ xX])\]/)?.[1] ?? ' ').toLowerCase();
		const isChecked = checkedMark === 'x';
		const linkTarget = match[3] ?? '';
		if (!linkTarget) {
			continue;
		}
		map.set(linkTarget, isChecked);
	}
	return map;
}
