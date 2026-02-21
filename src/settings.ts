export const DEFAULT_TODOIST_TOKEN_SECRET_NAME = 'todoist-api';

export type ArchiveMode = 'none' | 'move-to-archive-folder' | 'mark-local-done';
export type ImportProjectScope = 'all-projects' | 'allow-list-by-name';
export type TodoistLinkStyle = 'app' | 'web';
export type ConflictResolution = 'local-wins' | 'remote-wins';

export interface PropNames {
	// Core task properties
	taskTitle: string;
	taskStatus: string;
	taskDone: string;
	created: string;
	modified: string;
	tags: string;
	links: string;
	parentTask: string;
	localUpdatedAt: string;
	// Todoist sync properties
	todoistSync: string;
	todoistSyncStatus: string;
	todoistId: string;
	todoistProjectId: string;
	todoistProjectName: string;
	todoistSectionId: string;
	todoistSectionName: string;
	todoistPriority: string;
	todoistDue: string;
	todoistDueString: string;
	todoistIsRecurring: string;
	todoistLabels: string;
	todoistParentId: string;
	todoistHasChildren: string;
	todoistChildTaskCount: string;
	todoistChildTasks: string;
	todoistLastImportedSignature: string;
	todoistLastSyncedSignature: string;
	todoistLastImportedAt: string;
	// New properties
	todoistDescription: string;
	todoistUrl: string;
	// Date-typed properties for Obsidian Bases
	todoistDueDateTyped: string;
	todoistPriorityLabel: string;
	todoistDeadline: string;
	todoistDeadlineDateTyped: string;
	todoistCreatedDate: string;
}

export const DEFAULT_PROP_NAMES: PropNames = {
	taskTitle: 'task_title',
	taskStatus: 'task_status',
	taskDone: 'task_done',
	created: 'created',
	modified: 'modified',
	tags: 'tags',
	links: 'links',
	parentTask: 'parent_task',
	localUpdatedAt: 'local_updated_at',
	todoistSync: 'todoist_sync',
	todoistSyncStatus: 'todoist_sync_status',
	todoistId: 'todoist_id',
	todoistProjectId: 'todoist_project_id',
	todoistProjectName: 'todoist_project_name',
	todoistSectionId: 'todoist_section_id',
	todoistSectionName: 'todoist_section_name',
	todoistPriority: 'todoist_priority',
	todoistDue: 'todoist_due',
	todoistDueString: 'todoist_due_string',
	todoistIsRecurring: 'todoist_is_recurring',
	todoistLabels: 'todoist_labels',
	todoistParentId: 'todoist_parent_id',
	todoistHasChildren: 'todoist_has_children',
	todoistChildTaskCount: 'todoist_child_task_count',
	todoistChildTasks: 'todoist_child_tasks',
	todoistLastImportedSignature: 'todoist_last_imported_signature',
	todoistLastSyncedSignature: 'todoist_last_synced_signature',
	todoistLastImportedAt: 'todoist_last_imported_at',
	todoistDescription: 'todoist_description',
	todoistUrl: 'todoist_url',
	todoistDueDateTyped: 'task_due_date',
	todoistPriorityLabel: 'task_priority_label',
	todoistDeadline: 'todoist_deadline',
	todoistDeadlineDateTyped: 'task_deadline_date',
	todoistCreatedDate: 'task_created_date',
};

export interface TaskTodoistSettings {
	tasksFolderPath: string;
	defaultTaskTag: string;
	autoRenameTaskFiles: boolean;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	showScheduledSyncNotices: boolean;
	archiveMode: ArchiveMode;
	archiveFolderPath: string;
	autoImportEnabled: boolean;
	autoImportProjectScope: ImportProjectScope;
	autoImportAllowedProjectNames: string;
	autoImportRequiredLabel: string;
	autoImportAssignedToMeOnly: boolean;
	todoistTokenSecretName: string;
	// New settings
	propNames: PropNames;
	useProjectSubfolders: boolean;
	useSectionSubfolders: boolean;
	todoistLinkStyle: TodoistLinkStyle;
	conflictResolution: ConflictResolution;
	noteTemplate: string;
	autoOpenNewNote: boolean;
	createProjectNotes: boolean;
	projectNotesFolderPath: string;
	projectNoteTemplate: string;
	createSectionNotes: boolean;
	sectionNotesFolderPath: string;
	sectionNoteTemplate: string;
}

export const DEFAULT_SETTINGS: TaskTodoistSettings = {
	tasksFolderPath: 'Tasks',
	defaultTaskTag: 'tasks',
	autoRenameTaskFiles: true,
	autoSyncEnabled: true,
	autoSyncIntervalMinutes: 5,
	showScheduledSyncNotices: false,
	archiveMode: 'move-to-archive-folder',
	archiveFolderPath: 'Tasks/_archive',
	autoImportEnabled: true,
	autoImportProjectScope: 'allow-list-by-name',
	autoImportAllowedProjectNames: '',
	autoImportRequiredLabel: 'obsidian',
	autoImportAssignedToMeOnly: true,
	todoistTokenSecretName: DEFAULT_TODOIST_TOKEN_SECRET_NAME,
	propNames: { ...DEFAULT_PROP_NAMES },
	useProjectSubfolders: false,
	useSectionSubfolders: false,
	todoistLinkStyle: 'web',
	conflictResolution: 'local-wins',
	noteTemplate: '',
	autoOpenNewNote: false,
	createProjectNotes: false,
	projectNotesFolderPath: '',
	projectNoteTemplate: '',
	createSectionNotes: false,
	sectionNotesFolderPath: '',
	sectionNoteTemplate: '',
};
