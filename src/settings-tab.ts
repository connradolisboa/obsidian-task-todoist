import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type TaskTodoistPlugin from './main';
import { DEFAULT_PROP_NAMES } from './settings';
import type { ArchiveMode, ConflictResolution, ImportProjectScope, PropNames, TodoistLinkStyle } from './settings';

type TabId = 'general' | 'import' | 'sync' | 'notes' | 'properties';

const TABS: { id: TabId; label: string }[] = [
	{ id: 'general', label: 'General' },
	{ id: 'import', label: 'Import' },
	{ id: 'sync', label: 'Sync' },
	{ id: 'notes', label: 'Notes' },
	{ id: 'properties', label: 'Properties' },
];

export class TaskTodoistSettingTab extends PluginSettingTab {
	plugin: TaskTodoistPlugin;
	private activeTab: TabId = 'general';

	constructor(app: App, plugin: TaskTodoistPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Tab bar
		const tabBar = containerEl.createDiv({ cls: 'task-todoist-settings-tab-bar' });
		for (const tab of TABS) {
			const btn = tabBar.createEl('button', {
				text: tab.label,
				cls: ['task-todoist-settings-tab', this.activeTab === tab.id ? 'is-active' : ''],
			});
			btn.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.display();
			});
		}

		// Tab content
		const content = containerEl.createDiv();
		switch (this.activeTab) {
			case 'general': this.renderGeneralTab(content); break;
			case 'import': this.renderImportTab(content); break;
			case 'sync': this.renderSyncTab(content); break;
			case 'notes': this.renderNotesTab(content); break;
			case 'properties': this.renderPropertiesTab(content); break;
		}
	}

	// ── General ────────────────────────────────────────────────────────────────
	// Todoist connection, link style, and core storage settings.

	private renderGeneralTab(el: HTMLElement): void {
		new Setting(el).setName('Todoist connection').setHeading();

		const secureStorageText = this.plugin.isSecretStorageAvailable()
			? 'Token is stored in Obsidian secret storage.'
			: 'Obsidian secret storage is unavailable in this app version.';

		new Setting(el)
			.setName('Token secret name')
			.setDesc('Name of the secret key used for the todoist API token.')
			.addText((text) => {
				text
					.setPlaceholder('Todoist API token key')
					.setValue(this.plugin.settings.todoistTokenSecretName)
					.onChange(async (value) => {
						await this.plugin.updateTodoistTokenSecretName(value);
					});
				text.inputEl.size = 24;
			});

		new Setting(el)
			.setName('Todoist API token')
			.setDesc(secureStorageText)
			.addComponent((componentEl) => {
				return new SecretComponent(this.app, componentEl)
					.setValue(this.plugin.settings.todoistTokenSecretName)
					.onChange(async (value) => {
						await this.plugin.updateTodoistTokenSecretName(value);
						this.display();
					});
			})
			.setDisabled(!this.plugin.isSecretStorageAvailable());

		new Setting(el)
			.setName('Connection check')
			.setDesc('Verify the configured token against the todoist API.')
			.addButton((button) => {
				button.setButtonText('Test connection').onClick(async () => {
					const result = await this.plugin.testTodoistConnection();
					const prefix = result.ok ? 'Success:' : 'Failed:';
					new Notice(`${prefix} ${result.message}`, 6000);
					this.display();
				});
			});

		new Setting(el)
			.setName('Last connection check')
			.setDesc(this.plugin.getLastConnectionCheckMessage());

		new Setting(el).setName('Link style').setHeading();

		new Setting(el)
			.setName('Link format')
			.setDesc('Format used for the todoist_url property on task notes. App URI opens the Todoist app directly.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('web', 'Web URL (https://app.todoist.com/...)')
					.addOption('app', 'App URI (todoist://task?id=...)')
					.setValue(this.plugin.settings.todoistLinkStyle)
					.onChange(async (value) => {
						this.plugin.settings.todoistLinkStyle = value as TodoistLinkStyle;
						await this.plugin.saveSettings();
					});
			});

		new Setting(el).setName('Task storage').setHeading();

		new Setting(el)
			.setName('Task folder path')
			.setDesc('Folder where synced task notes are created. Supports date variables: {{YYYY}}, {{MM}}, {{DD}}, {{YYYY-MM}}, {{YYYY-MM-DD}}.')
			.addText((text) => {
				text
					.setPlaceholder('Tasks')
					.setValue(this.plugin.settings.tasksFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.tasksFolderPath = value.trim() || 'Tasks';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});

		new Setting(el)
			.setName('Default task tag')
			.setDesc('Default tag added to task notes. Supports date variables: {{YYYY}}, {{MM}}, {{DD}}.')
			.addText((text) => {
				text
					.setPlaceholder('tasks')
					.setValue(this.plugin.settings.defaultTaskTag)
					.onChange(async (value) => {
						this.plugin.settings.defaultTaskTag = value.trim() || 'tasks';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 24;
			});

		new Setting(el).setName('Task tools').setHeading();

		new Setting(el)
			.setName('Create task note')
			.setDesc('Open a modal to create a new task note in your task folder.')
			.addButton((button) => {
				button.setButtonText('Create task').onClick(() => {
					this.plugin.openCreateTaskModal();
				});
			});
	}

	// ── Import ─────────────────────────────────────────────────────────────────
	// Rules for which Todoist tasks to automatically pull in.

	private renderImportTab(el: HTMLElement): void {
		new Setting(el).setName('Auto import rules').setHeading();

		new Setting(el)
			.setName('Enable auto import')
			.setDesc('Automatically create task notes for matching todoist tasks.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoImportEnabled).onChange(async (value) => {
					this.plugin.settings.autoImportEnabled = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName('Project scope')
			.setDesc('Choose whether to import from all projects or only named projects.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('all-projects', 'All projects')
					.addOption('allow-list-by-name', 'Allow list by project name')
					.setValue(this.plugin.settings.autoImportProjectScope)
					.onChange(async (value) => {
						this.plugin.settings.autoImportProjectScope = value as ImportProjectScope;
						await this.plugin.saveSettings();
					});
			});

		new Setting(el)
			.setName('Allowed project names')
			.setDesc('Comma-separated names used when project scope is allow list.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Work, personal')
					.setValue(this.plugin.settings.autoImportAllowedProjectNames)
					.onChange(async (value) => {
						this.plugin.settings.autoImportAllowedProjectNames = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 2;
				textArea.inputEl.cols = 36;
			});

		new Setting(el)
			.setName('Required todoist label')
			.setDesc('Only import tasks that include this label. Leave empty for no label filter.')
			.addText((text) => {
				text
					.setPlaceholder('Obsidian')
					.setValue(this.plugin.settings.autoImportRequiredLabel)
					.onChange(async (value) => {
						this.plugin.settings.autoImportRequiredLabel = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 20;
			});

		new Setting(el)
			.setName('Assigned to me only')
			.setDesc('Only auto import tasks assigned to your todoist account.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoImportAssignedToMeOnly).onChange(async (value) => {
					this.plugin.settings.autoImportAssignedToMeOnly = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el).setName('Exclusion rules').setHeading();

		new Setting(el)
			.setName('Excluded project names')
			.setDesc('Comma-separated project names to skip during import. Tasks in these projects are never imported.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Archive, Templates')
					.setValue(this.plugin.settings.excludedProjectNames)
					.onChange(async (value) => {
						this.plugin.settings.excludedProjectNames = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 2;
				textArea.inputEl.cols = 36;
			});

		new Setting(el)
			.setName('Excluded section names')
			.setDesc('Comma-separated section names to skip during import. Tasks in these sections are never imported.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Archive, Backlog')
					.setValue(this.plugin.settings.excludedSectionNames)
					.onChange(async (value) => {
						this.plugin.settings.excludedSectionNames = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 2;
				textArea.inputEl.cols = 36;
			});
	}

	// ── Sync ───────────────────────────────────────────────────────────────────
	// Sync schedule, conflict resolution, file organization, and archive.

	private renderSyncTab(el: HTMLElement): void {
		new Setting(el).setName('Todoist sync').setHeading();

		new Setting(el)
			.setName('Run sync now')
			.setDesc('Import todoist tasks and update task notes using current rules.')
			.addButton((button) => {
				button.setButtonText('Sync now').onClick(async () => {
					const result = await this.plugin.runImportSync();
					const prefix = result.ok ? 'Success:' : 'Failed:';
					new Notice(`${prefix} ${result.message}`, 8000);
					this.display();
				});
			});

		new Setting(el)
			.setName('Enable scheduled sync')
			.setDesc('Run sync automatically in the background.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange(async (value) => {
					await this.plugin.updateAutoSyncEnabled(value);
				});
			});

		new Setting(el)
			.setName('Scheduled sync interval')
			.setDesc('Minutes between automatic sync runs.')
			.addText((text) => {
				text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							await this.plugin.updateAutoSyncIntervalMinutes(parsed);
						}
					});
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '120';
				text.inputEl.size = 6;
			});

		new Setting(el)
			.setName('Show scheduled sync notices')
			.setDesc('Show a notice after each automatic sync run.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showScheduledSyncNotices).onChange(async (value) => {
					this.plugin.settings.showScheduledSyncNotices = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName('Conflict resolution')
			.setDesc('When both local and remote changed since last sync, choose which side wins.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('local-wins', 'Local wins (default — skip remote overwrite)')
					.addOption('remote-wins', 'Remote wins — overwrite local changes with Todoist data')
					.setValue(this.plugin.settings.conflictResolution)
					.onChange(async (value) => {
						this.plugin.settings.conflictResolution = value as ConflictResolution;
						await this.plugin.saveSettings();
					});
			});

		new Setting(el)
			.setName('Last sync')
			.setDesc(this.plugin.getLastSyncMessage());

		new Setting(el).setName('File organization').setHeading();

		new Setting(el)
			.setName('Auto-rename task files from title')
			.setDesc('Rename the note file when the task title changes in Todoist. When disabled (default), only the task_title frontmatter property is updated — you control the filename.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoRenameTaskFiles).onChange(async (value) => {
					this.plugin.settings.autoRenameTaskFiles = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName('Use project subfolders')
			.setDesc('Organize task notes into subfolders named after their Todoist project (e.g. Tasks/Business/Task.md).')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.useProjectSubfolders).onChange(async (value) => {
					this.plugin.settings.useProjectSubfolders = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(el)
			.setName('Use section subfolders')
			.setDesc('Further nest task notes by section within the project subfolder (e.g. Tasks/Business/Urgent/Task.md). Requires project subfolders to be enabled.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useSectionSubfolders)
					.setDisabled(!this.plugin.settings.useProjectSubfolders)
					.onChange(async (value) => {
						this.plugin.settings.useSectionSubfolders = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(el).setName('Archive').setHeading();

		new Setting(el)
			.setName('Archive mode')
			.setDesc('How to represent completed or deleted todoist tasks locally.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('none', 'Keep notes in place')
					.addOption('move-to-archive-folder', 'Move notes to archive folder')
					.addOption('mark-local-done', 'Only mark notes as done')
					.addOption('delete-file', 'Move to Obsidian trash (recoverable)')
					.setValue(this.plugin.settings.archiveMode)
					.onChange(async (value) => {
						this.plugin.settings.archiveMode = value as ArchiveMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(el)
			.setName('Archive folder path')
			.setDesc('Used when archive mode is set to move notes to archive folder. Supports date variables: {{YYYY}}, {{MM}}, {{DD}}.')
			.addText((text) => {
				text
					.setPlaceholder('Tasks/_archive')
					.setValue(this.plugin.settings.archiveFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.archiveFolderPath = value.trim() || 'Tasks/_archive';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});

		new Setting(el).setName('Project & section archive').setHeading();

		new Setting(el)
			.setName('Project archive folder path')
			.setDesc('Folder where archived Todoist project notes are moved during sync. Default: Projects/_archive.')
			.addText((text) => {
				text
					.setPlaceholder('Projects/_archive')
					.setValue(this.plugin.settings.projectArchiveFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.projectArchiveFolderPath = value.trim() || 'Projects/_archive';
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});

		new Setting(el)
			.setName('Section archive folder path')
			.setDesc('Folder where archived Todoist section notes are moved. Leave empty to use the project archive folder.')
			.addText((text) => {
				text
					.setPlaceholder('Leave empty to use project archive folder')
					.setValue(this.plugin.settings.sectionArchiveFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.sectionArchiveFolderPath = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 32;
			});
	}

	// ── Notes ──────────────────────────────────────────────────────────────────
	// Task note template, project notes, and section notes.

	private renderNotesTab(el: HTMLElement): void {
		new Setting(el).setName('Task note template').setHeading();

		new Setting(el)
			.setName('Auto-open new note')
			.setDesc('Automatically open the new task note in the editor after creation.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoOpenNewNote).onChange(async (value) => {
					this.plugin.settings.autoOpenNewNote = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName('Task note template')
			.setDesc(
				'Full-file template for new task notes (both frontmatter and body). Leave empty to use the default auto-generated frontmatter. ' +
				'Available variables: {{title}}, {{description}}, {{due_date}}, {{due_string}}, {{deadline_date}}, {{priority}}, {{priority_label}}, ' +
				'{{project}}, {{project_id}}, {{section}}, {{section_id}}, {{todoist_id}}, {{url}}, {{tags}}, {{created}}, ' +
				'{{YYYY}}, {{MM}}, {{DD}}, {{YYYY-MM-DD}}.'
			)
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Leave empty to use the default frontmatter layout.')
					.setValue(this.plugin.settings.noteTemplate)
					.onChange(async (value) => {
						this.plugin.settings.noteTemplate = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 10;
				textArea.inputEl.cols = 50;
				textArea.inputEl.style.fontFamily = 'monospace';
			});

		new Setting(el).setName('Project & section notes').setHeading();

		new Setting(el)
			.setName('Create project notes')
			.setDesc('Automatically create a note for each Todoist project encountered during sync.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.createProjectNotes).onChange(async (value) => {
					this.plugin.settings.createProjectNotes = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (this.plugin.settings.createProjectNotes) {
			new Setting(el)
				.setName('Project notes folder')
				.setDesc('Folder for project notes. Leave empty to place them inside the project subfolder as _project.md (requires project subfolders).')
				.addText((text) => {
					text
						.setPlaceholder('Projects')
						.setValue(this.plugin.settings.projectNotesFolderPath)
						.onChange(async (value) => {
							this.plugin.settings.projectNotesFolderPath = value.trim();
							await this.plugin.saveSettings();
						});
					text.inputEl.size = 32;
				});

			new Setting(el)
				.setName('Project note template')
				.setDesc('Full-file template for project notes. Available variables: {{project_name}}, {{project_id}}, {{YYYY}}, {{MM}}, {{DD}}.')
				.addTextArea((textArea) => {
					textArea
						.setPlaceholder('Leave empty to use default project note layout.')
						.setValue(this.plugin.settings.projectNoteTemplate)
						.onChange(async (value) => {
							this.plugin.settings.projectNoteTemplate = value;
							await this.plugin.saveSettings();
						});
					textArea.inputEl.rows = 6;
					textArea.inputEl.cols = 50;
					textArea.inputEl.style.fontFamily = 'monospace';
				});
		}

		new Setting(el)
			.setName('Create section notes')
			.setDesc('Automatically create a note for each Todoist section encountered during sync. Requires project subfolders to be enabled.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.createSectionNotes)
					.setDisabled(!this.plugin.settings.useProjectSubfolders)
					.onChange(async (value) => {
						this.plugin.settings.createSectionNotes = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.createSectionNotes && this.plugin.settings.useProjectSubfolders) {
			new Setting(el)
				.setName('Section notes folder')
				.setDesc('Folder for section notes. Leave empty to place them inside the section subfolder as _section.md.')
				.addText((text) => {
					text
						.setPlaceholder('Sections')
						.setValue(this.plugin.settings.sectionNotesFolderPath)
						.onChange(async (value) => {
							this.plugin.settings.sectionNotesFolderPath = value.trim();
							await this.plugin.saveSettings();
						});
					text.inputEl.size = 32;
				});

			new Setting(el)
				.setName('Section note template')
				.setDesc('Full-file template for section notes. Available variables: {{section_name}}, {{section_id}}, {{project_name}}, {{project_id}}, {{YYYY}}, {{MM}}, {{DD}}.')
				.addTextArea((textArea) => {
					textArea
						.setPlaceholder('Leave empty to use default section note layout.')
						.setValue(this.plugin.settings.sectionNoteTemplate)
						.onChange(async (value) => {
							this.plugin.settings.sectionNoteTemplate = value;
							await this.plugin.saveSettings();
						});
					textArea.inputEl.rows = 6;
					textArea.inputEl.cols = 50;
					textArea.inputEl.style.fontFamily = 'monospace';
				});
		}

		new Setting(el).setName('Area projects').setHeading();

		new Setting(el)
			.setName('Area project names')
			.setDesc('Comma-separated project names treated as "areas". These use the area note template instead of the standard project note template.')
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder('Work, Personal')
					.setValue(this.plugin.settings.areaProjectNames)
					.onChange(async (value) => {
						this.plugin.settings.areaProjectNames = value;
						await this.plugin.saveSettings();
						this.display();
					});
				textArea.inputEl.rows = 2;
				textArea.inputEl.cols = 36;
			});

		if (this.plugin.settings.areaProjectNames.trim()) {
			new Setting(el)
				.setName('Area project note template')
				.setDesc('Full-file template for area project notes. Available variables: {{project_name}}, {{project_id}}, {{YYYY}}, {{MM}}, {{DD}}.')
				.addTextArea((textArea) => {
					textArea
						.setPlaceholder('Leave empty to use default project note layout.')
						.setValue(this.plugin.settings.areaProjectNoteTemplate)
						.onChange(async (value) => {
							this.plugin.settings.areaProjectNoteTemplate = value;
							await this.plugin.saveSettings();
						});
					textArea.inputEl.rows = 6;
					textArea.inputEl.cols = 50;
					textArea.inputEl.style.fontFamily = 'monospace';
				});
		}
	}

	// ── Properties ─────────────────────────────────────────────────────────────
	// Customize frontmatter property names used in task notes.

	private renderPropertiesTab(el: HTMLElement): void {
		const desc = el.createEl('p', {
			text: 'Customize the frontmatter property names used in task notes. Changing these will only affect new writes — existing notes keep their current keys until the next sync.',
			cls: 'setting-item-description',
		});
		desc.style.marginBottom = '0.5em';

		new Setting(el).setName('Core task properties').setHeading();

		this.addPropNameSetting(el, 'Task title', 'Property storing the task title.', 'taskTitle');
		this.addPropNameSetting(el, 'Task status', 'Property storing open/done status string.', 'taskStatus');
		this.addPropNameSetting(el, 'Task done (boolean)', 'Boolean property for done state (Bases compatibility).', 'taskDone');
		this.addPropNameSetting(el, 'Created date', 'Property storing the note creation date.', 'created');
		this.addPropNameSetting(el, 'Modified date', 'Property storing the last modified timestamp.', 'modified');
		this.addPropNameSetting(el, 'Tags', 'Property storing note tags.', 'tags');
		this.addPropNameSetting(el, 'Links', 'Property storing related links.', 'links');
		this.addPropNameSetting(el, 'Parent task', 'Property storing the wiki-link to a parent task.', 'parentTask');
		this.addPropNameSetting(el, 'Local updated at', 'Property storing when local changes were last made.', 'localUpdatedAt');

		new Setting(el).setName('Todoist sync properties').setHeading();

		this.addPropNameSetting(el, 'Todoist sync', 'Whether this note is synced with Todoist.', 'todoistSync');
		this.addPropNameSetting(el, 'Todoist sync status', 'Internal sync state (synced, dirty_local, etc.).', 'todoistSyncStatus');
		this.addPropNameSetting(el, 'Todoist ID', 'The remote Todoist task ID.', 'todoistId');
		this.addPropNameSetting(el, 'Todoist project ID', 'The remote Todoist project ID.', 'todoistProjectId');
		this.addPropNameSetting(el, 'Todoist project name', 'Human-readable Todoist project name.', 'todoistProjectName');
		this.addPropNameSetting(el, 'Todoist section ID', 'The remote Todoist section ID.', 'todoistSectionId');
		this.addPropNameSetting(el, 'Todoist section name', 'Human-readable Todoist section name.', 'todoistSectionName');
		this.addPropNameSetting(el, 'Todoist priority', 'Task priority (1–4).', 'todoistPriority');
		this.addPropNameSetting(el, 'Todoist due date', 'ISO due date from Todoist.', 'todoistDue');
		this.addPropNameSetting(el, 'Todoist due string', 'Natural language recurrence string from Todoist.', 'todoistDueString');
		this.addPropNameSetting(el, 'Todoist is recurring', 'Whether the task is a recurring task.', 'todoistIsRecurring');
		this.addPropNameSetting(el, 'Todoist labels', 'Array of labels applied in Todoist.', 'todoistLabels');
		this.addPropNameSetting(el, 'Todoist parent ID', 'The Todoist ID of the parent task.', 'todoistParentId');
		this.addPropNameSetting(el, 'Todoist has children', 'Whether this task has child tasks.', 'todoistHasChildren');
		this.addPropNameSetting(el, 'Todoist child task count', 'Number of child tasks.', 'todoistChildTaskCount');
		this.addPropNameSetting(el, 'Todoist child tasks', 'Wiki-links to child task notes.', 'todoistChildTasks');
		this.addPropNameSetting(el, 'Todoist last imported signature', 'Internal hash for remote change detection.', 'todoistLastImportedSignature');
		this.addPropNameSetting(el, 'Todoist last synced signature', 'Internal hash for local change detection.', 'todoistLastSyncedSignature');
		this.addPropNameSetting(el, 'Todoist last imported at', 'Timestamp of last sync from Todoist.', 'todoistLastImportedAt');

		new Setting(el).setName('Additional properties').setHeading();

		this.addPropNameSetting(el, 'Todoist description', 'Stores the Todoist task description. The note body is your personal notes and is not synced.', 'todoistDescription');
		this.addPropNameSetting(el, 'Todoist URL', 'Link to the task in Todoist (format controlled by "Link format" setting).', 'todoistUrl');
		this.addPropNameSetting(el, 'Due date (date type)', 'Date-typed due date for Obsidian Bases calendar views. Stores the same date as the due date field but as a pure YYYY-MM-DD.', 'todoistDueDateTyped');
		this.addPropNameSetting(el, 'Priority label', 'Human-readable priority: none, low, medium, or high.', 'todoistPriorityLabel');
		this.addPropNameSetting(el, 'Deadline date', 'Hard deadline from Todoist (separate from due date).', 'todoistDeadline');
		this.addPropNameSetting(el, 'Deadline date (date type)', 'Date-typed deadline for Obsidian Bases calendar views.', 'todoistDeadlineDateTyped');
		this.addPropNameSetting(el, 'Task created date', 'Date-typed creation date. Use in Bases to compute task age (e.g. days since created).', 'todoistCreatedDate');

		new Setting(el).setName('Project & section note properties').setHeading();

		this.addPropNameSetting(el, 'Project ID', 'Frontmatter key written into project notes to track the Todoist project ID.', 'projectId');
		this.addPropNameSetting(el, 'Section ID', 'Frontmatter key written into section notes to track the Todoist section ID.', 'sectionId');

		new Setting(el).setName('Vault identity').setHeading();

		this.addPropNameSetting(el, 'Vault ID', 'Write-once stable UUID added to every plugin note at creation. Existing notes are backfilled on first sync. Never overwritten after initial write.', 'vaultId');

		new Setting(el)
			.setName('Reset property names to defaults')
			.setDesc('Restore all property names to their default values.')
			.addButton((button) => {
				button.setButtonText('Reset to defaults').setWarning().onClick(async () => {
					this.plugin.settings.propNames = { ...DEFAULT_PROP_NAMES };
					await this.plugin.saveSettings();
					this.display();
					new Notice('Property names reset to defaults.', 3000);
				});
			});
	}

	private addPropNameSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: keyof PropNames,
	): void {
		const defaultValue = DEFAULT_PROP_NAMES[key];
		new Setting(containerEl)
			.setName(name)
			.setDesc(`${desc} Default: "${defaultValue}"`)
			.addText((text) => {
				text
					.setPlaceholder(defaultValue)
					.setValue(this.plugin.settings.propNames[key])
					.onChange(async (value) => {
						const normalized = value.trim() || defaultValue;
						this.plugin.settings.propNames[key] = normalized;
						await this.plugin.saveSettings();
					});
				text.inputEl.size = 28;
			});
	}
}
