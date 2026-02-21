import { AbstractInputSuggest, App, Modal, Notice, Setting, TFile, TextComponent, normalizePath } from 'obsidian';
import type TaskTodoistPlugin from './main';
import { formatDueForDisplay, parseInlineTaskDirectives } from './task-directives';
import type { TodoistProject, TodoistSection } from './todoist-client';
import { getTaskTitle } from './task-frontmatter';

export class CreateTaskModal extends Modal {
	private readonly plugin: TaskTodoistPlugin;
	private readonly initialTitle: string;
	private title = '';
	private description = '';
	private parentTaskLink = '';
	private todoistProjectId = '';
	private todoistProjectName = '';
	private todoistSectionId = '';
	private todoistSectionName = '';
	private todoistDueDate = '';
	private todoistRecurrence = '';
	private todoistPriority = 1;
	private todoistSync = true;
	private parsedHintEl: HTMLDivElement | null = null;
	private dueDateInput: TextComponent | null = null;
	private recurrenceInput: TextComponent | null = null;
	private parentTaskInput: TextComponent | null = null;
	private dueDateManuallyEdited = false;
	private recurrenceManuallyEdited = false;
	private suppressFieldChangeHandlers = false;
	private projectInput: TextComponent | null = null;
	private sectionInput: TextComponent | null = null;
	private projectSuggest: ModalInputSuggest | null = null;
	private sectionSuggest: ModalInputSuggest | null = null;
	private parentTaskSuggest: ModalInputSuggest | null = null;
	private projectInputContainerEl: HTMLElement | null = null;
	private projectLockIndicatorEl: HTMLSpanElement | null = null;
	private projectLookupNoticeEl: HTMLDivElement | null = null;
	private parentConstraintNoticeEl: HTMLDivElement | null = null;
	private todoistProjects: TodoistProject[] = [];
	private todoistSections: TodoistSection[] = [];
	private parentTaskLookup = new Map<string, ParentTaskLookupEntry>();
	private parentTaskLookupByLink = new Map<string, ParentTaskLookupEntry>();

	constructor(app: App, plugin: TaskTodoistPlugin, initialTitle = '') {
		super(app);
		this.plugin = plugin;
		this.initialTitle = initialTitle.trim();
		this.title = this.initialTitle;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Create task note');

		new Setting(contentEl)
			.setName('Title')
			.setDesc('Task title for the new task note.')
			.addText((text) => {
				text
					.setPlaceholder('Task title')
					.setValue(this.title)
					.onChange((value) => {
						this.title = value;
						this.applyParsedFieldSuggestions();
						this.renderParsedHint();
					});
				text.inputEl.size = 36;
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		this.parsedHintEl = contentEl.createDiv({ cls: 'task-todoist-parse-hint' });
		this.renderParsedHint();

		new Setting(contentEl)
			.setName('Description')
			.setDesc('Optional Markdown description in the task note body.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Optional details')
					.setValue(this.description)
					.onChange((value) => {
						this.description = value;
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 40;
			});

		new Setting(contentEl)
			.setName('Todoist project')
			.setDesc('Optional project name. Will map to todoist project on sync.')
			.addText((text) => {
				this.projectInput = text;
				text.inputEl.addClass('task-todoist-lookup-input');
				const inputContainer = text.inputEl.parentElement;
				if (inputContainer) {
					inputContainer.addClass('task-todoist-lookup-input-wrap');
					this.projectInputContainerEl = inputContainer;
					const lockEl = inputContainer.createSpan({ cls: 'task-todoist-lock-indicator' });
					lockEl.setText('🔒');
					lockEl.setAttribute('aria-hidden', 'true');
					this.projectLockIndicatorEl = lockEl;
				}
				text
					.setPlaceholder('Work')
					.setValue(this.todoistProjectName)
					.onChange((value) => {
						this.todoistProjectName = value;
						this.todoistProjectId = this.resolveProjectId(value);
						if (!this.todoistProjectId) {
							this.todoistSectionId = '';
						}
						this.todoistSectionId = this.resolveSectionId(this.todoistSectionName);
						this.refreshSuggesters();
					});
				text.inputEl.size = 28;
			});

		new Setting(contentEl)
			.setName('Todoist section')
			.setDesc('Optional section name within the selected project.')
			.addText((text) => {
				this.sectionInput = text;
				text.inputEl.addClass('task-todoist-lookup-input');
				text
					.setPlaceholder('Urgent')
					.setValue(this.todoistSectionName)
					.onChange((value) => {
						this.todoistSectionName = value;
						this.todoistSectionId = this.resolveSectionId(value);
					});
				text.inputEl.size = 28;
			});

		this.projectLookupNoticeEl = contentEl.createDiv({ cls: 'task-todoist-parse-hint' });
		this.projectLookupNoticeEl.setText('Loading todoist projects...');

		new Setting(contentEl)
			.setName('Parent task')
			.setDesc('Optional parent task. Pick from suggestions or enter a wiki link manually.')
			.addText((text) => {
				this.parentTaskInput = text;
				text.inputEl.addClass('task-todoist-lookup-input');
				text
					.setPlaceholder('Pick a parent task')
					.setValue(this.parentTaskLink)
					.onChange((value) => {
						this.parentTaskLink = this.resolveParentTaskLinkValue(value);
						this.applyParentTaskProjectConstraint(this.parentTaskLink);
					});
				text.inputEl.size = 36;
			});
		this.parentConstraintNoticeEl = contentEl.createDiv({ cls: 'task-todoist-parse-hint' });
		this.parentConstraintNoticeEl.setText('No parent selected.');

		new Setting(contentEl)
			.setName('Due date')
			.setDesc('Optional due date.')
			.addText((text) => {
				this.dueDateInput = text;
				text
					.setValue(this.todoistDueDate)
					.onChange((value) => {
						this.todoistDueDate = value;
						if (!this.suppressFieldChangeHandlers) {
							this.dueDateManuallyEdited = true;
						}
						this.renderParsedHint();
					});
				text.inputEl.type = 'date';
				text.inputEl.size = 24;
			});

		new Setting(contentEl)
			.setName('Recurrence')
			.setDesc('Optional todoist recurrence rule, e.g. "every weekday".')
				.addText((text) => {
					this.recurrenceInput = text;
					text
						.setPlaceholder('Every weekday')
						.setValue(this.todoistRecurrence)
					.onChange((value) => {
						this.todoistRecurrence = value;
						if (!this.suppressFieldChangeHandlers) {
							this.recurrenceManuallyEdited = true;
						}
						this.renderParsedHint();
					});
				text.inputEl.size = 28;
			});

		new Setting(contentEl)
			.setName('Priority')
			.setDesc('Todoist task priority.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('1', 'None (p4)')
					.addOption('2', 'Low (p3)')
					.addOption('3', 'Medium (p2)')
					.addOption('4', 'High (p1)')
					.setValue(String(this.todoistPriority))
					.onChange((value) => {
						this.todoistPriority = parseInt(value, 10) || 1;
					});
			});

		new Setting(contentEl)
			.setName('Sync with todoist')
			.setDesc('Marks this task note as eligible for todoist sync.')
			.addToggle((toggle) => {
				toggle.setValue(this.todoistSync).onChange((value) => {
					this.todoistSync = value;
				});
			});

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText('Create task').setCta().onClick(async () => {
					await this.handleCreate();
				});
			})
			.addExtraButton((button) => {
				button.setIcon('cross').setTooltip('Cancel').onClick(() => {
					this.close();
				});
			});

		this.applyParsedFieldSuggestions();
		this.renderParsedHint();
		this.initializeInputSuggesters();
		void this.loadProjectLookup();
		void this.loadParentTaskLookup();
	}

	onClose(): void {
		this.parsedHintEl = null;
		this.dueDateInput = null;
		this.recurrenceInput = null;
		this.projectInput = null;
		this.sectionInput = null;
		this.parentTaskInput = null;
		this.projectInputContainerEl = null;
		this.projectLockIndicatorEl = null;
		this.projectSuggest = null;
		this.sectionSuggest = null;
		this.parentTaskSuggest = null;
		this.projectLookupNoticeEl = null;
		this.parentConstraintNoticeEl = null;
		this.parentTaskLookup.clear();
		this.parentTaskLookupByLink.clear();
		this.contentEl.empty();
	}

	private async handleCreate(): Promise<void> {
		const dueOverride = this.todoistDueDate.trim();
		const recurrenceOverride = this.todoistRecurrence.trim();
		const parsed = parseInlineTaskDirectives(this.title);
		const finalTitle = parsed.title.trim();
		const finalDueDate = dueOverride || (parsed.dueRaw?.trim() ?? '');
		const finalRecurrence = recurrenceOverride || parsed.recurrenceRaw?.trim() || '';
		const parentEntry = this.findParentTaskEntry(this.parentTaskLink);
		const enforcedProjectId = parentEntry?.projectId ?? this.todoistProjectId;
		const enforcedProjectName = parentEntry?.projectName ?? this.todoistProjectName;
		const enforcedSectionId = this.todoistSectionId;
		const enforcedSectionName = this.todoistSectionName;

		if (!finalTitle) {
			new Notice('Task title is required.', 4000);
			return;
		}

		const createdFile = await this.plugin.createTaskNote({
			title: finalTitle,
			description: this.description,
			parentTaskLink: this.parentTaskLink,
			todoistSync: this.todoistSync,
			todoistProjectId: enforcedProjectId,
			todoistProjectName: enforcedProjectName,
			todoistSectionId: enforcedSectionId,
			todoistSectionName: enforcedSectionName,
			todoistDueDate: finalDueDate,
			todoistDueString: finalRecurrence,
			todoistPriority: this.todoistPriority,
		});
		const parsedSummary = finalRecurrence
			? ` • Parsed recurrence: ${finalRecurrence}`
			: (finalDueDate ? ` • Parsed due: ${formatDueForDisplay(finalDueDate)}` : '');
		new Notice(`Created task note: ${createdFile.basename}${parsedSummary}`, 5000);
		this.close();
	}

	private renderParsedHint(): void {
		if (!this.parsedHintEl) {
			return;
		}

		const dueValue = this.todoistDueDate.trim();
		const recurrenceValue = this.todoistRecurrence.trim();
		if (this.dueDateManuallyEdited || this.recurrenceManuallyEdited) {
			const activeOverride = this.recurrenceManuallyEdited && recurrenceValue
				? `Recurrence override active: ${recurrenceValue}`
				: (this.dueDateManuallyEdited && dueValue
					? `Due date override active: ${formatDueForDisplay(dueValue)}`
					: 'Manual override active.');
			this.parsedHintEl.setText(activeOverride);
			return;
		}

		const parsed = parseInlineTaskDirectives(this.title);
		if (parsed.recurrenceRaw?.trim()) {
			const dueBit = parsed.dueRaw?.trim() ? `, first due -> ${formatDueForDisplay(parsed.dueRaw.trim())}` : '';
			this.parsedHintEl.setText(`Detected from title: recurrence -> ${parsed.recurrenceRaw.trim()}${dueBit}`);
			return;
		}
		if (parsed.dueRaw?.trim()) {
			this.parsedHintEl.setText(`Detected from title: due -> ${formatDueForDisplay(parsed.dueRaw.trim())}`);
			return;
		}

		this.parsedHintEl.setText('No natural date detected from title.');
	}

	private applyParsedFieldSuggestions(): void {
		const parsed = parseInlineTaskDirectives(this.title);
		const parsedRecurrence = parsed.recurrenceRaw?.trim() ?? '';
		const parsedDueDate = parsed.dueRaw?.trim() ?? '';

		if (!this.recurrenceManuallyEdited) {
			this.setRecurrenceFieldValue(parsedRecurrence);
		}
		if (!this.dueDateManuallyEdited) {
			this.setDueDateFieldValue(parsedDueDate);
		}
	}

	private setDueDateFieldValue(value: string): void {
		this.todoistDueDate = value;
		if (!this.dueDateInput) {
			return;
		}
		this.suppressFieldChangeHandlers = true;
		this.dueDateInput.setValue(value);
		this.suppressFieldChangeHandlers = false;
	}

	private setRecurrenceFieldValue(value: string): void {
		this.todoistRecurrence = value;
		if (!this.recurrenceInput) {
			return;
		}
		this.suppressFieldChangeHandlers = true;
		this.recurrenceInput.setValue(value);
		this.suppressFieldChangeHandlers = false;
	}

	private async loadProjectLookup(): Promise<void> {
		if (!this.todoistSync) {
			if (this.projectLookupNoticeEl) {
				this.projectLookupNoticeEl.setText('Todoist sync disabled. Enter project/section manually.');
			}
			return;
		}

		try {
			const lookup = await this.plugin.getTodoistProjectSectionLookup();
			this.todoistProjects = lookup.projects;
			this.todoistSections = lookup.sections;
			this.todoistProjectId = this.resolveProjectId(this.todoistProjectName);
			this.todoistSectionId = this.resolveSectionId(this.todoistSectionName);
			if (this.projectLookupNoticeEl) {
				if (lookup.projects.length > 0) {
					this.projectLookupNoticeEl.setText('Project and section suggestions loaded from todoist.');
				} else {
					this.projectLookupNoticeEl.setText('No todoist projects loaded. Manual entry is still available.');
				}
			}
			this.refreshSuggesters();
		} catch (error) {
				if (this.projectLookupNoticeEl) {
					this.projectLookupNoticeEl.setText('Could not load todoist projects. Manual entry is still available.');
				}
				void error;
			}
	}

	private resolveProjectId(projectName: string): string {
		const normalized = projectName.trim().toLowerCase();
		if (!normalized) {
			return '';
		}
		const project = this.todoistProjects.find((candidate) => candidate.name.trim().toLowerCase() === normalized);
		return project?.id ?? '';
	}

	private resolveSectionId(sectionName: string): string {
		const normalized = sectionName.trim().toLowerCase();
		if (!normalized) {
			return '';
		}
		const projectId = this.resolveProjectId(this.todoistProjectName);
		const section = this.todoistSections.find((candidate) =>
			candidate.name.trim().toLowerCase() === normalized
			&& (!projectId || candidate.project_id === projectId)
		);
		return section?.id ?? '';
	}

	private initializeInputSuggesters(): void {
		if (this.projectInput && !this.projectSuggest) {
			this.projectSuggest = new ModalInputSuggest(
				this.app,
				this.projectInput.inputEl,
				() => this.todoistProjects.map((project) => project.name),
				30,
			);
		}
		if (this.sectionInput && !this.sectionSuggest) {
			this.sectionSuggest = new ModalInputSuggest(
				this.app,
				this.sectionInput.inputEl,
				() => {
					const projectId = this.resolveProjectId(this.todoistProjectName);
					const sections = projectId
						? this.todoistSections.filter((section) => section.project_id === projectId)
						: this.todoistSections;
					return sections.map((section) => section.name);
				},
				30,
			);
		}
		if (this.parentTaskInput && !this.parentTaskSuggest) {
			this.parentTaskSuggest = new ModalInputSuggest(
				this.app,
				this.parentTaskInput.inputEl,
				() => Array.from(this.parentTaskLookup.values())
					.map((entry) => entry.display)
					.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
				100,
			);
		}
	}

	private refreshSuggesters(): void {
		this.projectSuggest?.rebuild();
		this.sectionSuggest?.rebuild();
		this.parentTaskSuggest?.rebuild();
	}

	private async loadParentTaskLookup(): Promise<void> {
		this.parentTaskLookup.clear();
		this.parentTaskLookupByLink.clear();
		const taskFolder = normalizePath(this.plugin.settings.tasksFolderPath);
		const taskPrefix = `${taskFolder}/`;
		const files = this.app.vault.getMarkdownFiles().filter((file) =>
			file.path === taskFolder || file.path.startsWith(taskPrefix),
		);
		for (const file of files) {
			if (!this.isTopLevelTask(file)) {
				continue;
			}
			const parentInfo = this.getParentTaskInfo(file);
			const display = parentInfo.display;
			const link = `[[${file.path.replace(/\.md$/i, '')}]]`;
			const key = display.toLowerCase();
			if (!display || this.parentTaskLookup.has(key)) {
				continue;
			}
			const entry: ParentTaskLookupEntry = {
				display,
				link,
				projectId: parentInfo.projectId,
				projectName: parentInfo.projectName,
			};
			this.parentTaskLookup.set(key, entry);
			this.parentTaskLookupByLink.set(link, entry);
		}
		this.refreshSuggesters();
		this.applyParentTaskProjectConstraint(this.parentTaskLink);
	}

	private resolveParentTaskLinkValue(rawValue: string): string {
		const trimmed = rawValue.trim();
		if (!trimmed) {
			return '';
		}
		if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
			return trimmed;
		}
		const matched = this.parentTaskLookup.get(trimmed.toLowerCase());
		return matched?.link ?? trimmed;
	}

	private getParentTaskDisplayName(file: TFile): string {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		return getTaskTitle(frontmatter ?? {}, this.plugin.settings, file.basename);
	}

	private getParentTaskInfo(file: TFile): { display: string; projectId: string; projectName: string } {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const display = getTaskTitle(frontmatter ?? {}, this.plugin.settings, file.basename);
		const p = this.plugin.settings.propNames;
		const projectId = typeof frontmatter?.[p.todoistProjectId] === 'string' ? (frontmatter[p.todoistProjectId] as string).trim() : '';
		const projectName = typeof frontmatter?.[p.todoistProjectName] === 'string' ? (frontmatter[p.todoistProjectName] as string).trim() : '';
		return { display, projectId, projectName };
	}

	private findParentTaskEntry(parentValue: string): ParentTaskLookupEntry | null {
		const trimmed = parentValue.trim();
		if (!trimmed) {
			return null;
		}
		if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
			return this.parentTaskLookupByLink.get(trimmed) ?? null;
		}
		return this.parentTaskLookup.get(trimmed.toLowerCase()) ?? null;
	}

	private applyParentTaskProjectConstraint(parentValue: string): void {
		const parentEntry = this.findParentTaskEntry(parentValue);
		if (!parentEntry || !parentEntry.projectName) {
			this.setProjectFieldLocked(false);
			if (this.parentConstraintNoticeEl) {
				this.parentConstraintNoticeEl.setText('No parent project constraint detected.');
			}
			return;
		}

		this.todoistProjectName = parentEntry.projectName;
		this.todoistProjectId = parentEntry.projectId || this.resolveProjectId(parentEntry.projectName);
		if (this.projectInput && this.projectInput.getValue() !== parentEntry.projectName) {
			this.projectInput.setValue(parentEntry.projectName);
		}
		this.todoistSectionId = this.resolveSectionId(this.todoistSectionName);
		this.refreshSuggesters();
		this.setProjectFieldLocked(true);

		if (this.parentConstraintNoticeEl) {
			this.parentConstraintNoticeEl.setText(`Parent selected. Child will sync in project: ${parentEntry.projectName}.`);
		}
	}

	private setProjectFieldLocked(locked: boolean): void {
		if (!this.projectInput) {
			return;
		}
		this.projectInput.inputEl.disabled = locked;
		this.projectInput.inputEl.toggleClass('task-todoist-lookup-locked', locked);
		this.projectInputContainerEl?.toggleClass('task-todoist-lookup-locked', locked);
		this.projectLockIndicatorEl?.toggleClass('is-visible', locked);
		if (locked) {
			this.projectInput.inputEl.title = 'Locked by selected parent task';
		} else {
			this.projectInput.inputEl.removeAttribute('title');
		}
	}

	private isTopLevelTask(file: TFile): boolean {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) {
			return true;
		}
		const parent = typeof frontmatter.parent_task === 'string' ? frontmatter.parent_task.trim() : '';
		return parent.length === 0;
	}
}

type ParentTaskLookupEntry = {
	display: string;
	link: string;
	projectId: string;
	projectName: string;
};

class ModalInputSuggest extends AbstractInputSuggest<string> {
	private readonly getItems: () => string[];
	private readonly textInputEl: HTMLInputElement;
	private readonly maxItems: number;
	private itemCache: string[] = [];

	constructor(app: App, inputEl: HTMLInputElement, getItems: () => string[], maxItems = 30) {
		super(app, inputEl);
		this.getItems = getItems;
		this.textInputEl = inputEl;
		this.maxItems = maxItems;
	}

	rebuild(): void {
		this.itemCache = this.getItems().slice();
	}

	getSuggestions(query: string): string[] {
		const source = this.itemCache.length > 0 ? this.itemCache : this.getItems();
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return source.slice(0, this.maxItems);
		}
		return source.filter((item) => item.toLowerCase().includes(normalizedQuery)).slice(0, this.maxItems);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.textInputEl.value = value;
		this.textInputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}
