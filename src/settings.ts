export const DEFAULT_TODOIST_TOKEN_SECRET_NAME = 'todoist-api';

export type CompletedTaskMode = 'keep-in-place' | 'move-to-folder';
export type DeletedTaskMode = 'keep-in-place' | 'move-to-folder' | 'stop-syncing';
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
	// Human-readable labels and additional Todoist properties
	todoistPriorityLabel: string;
	todoistDeadline: string;
	// Wikilinks to project/section notes
	todoistProjectLink: string;
	todoistSectionLink: string;
	todoistProjectColor: string;
	todoistParentProjectLink: string;
	todoistParentProjectName: string;
	// Deletion flag — set to true when the task is confirmed deleted in Todoist
	todoistIsDeleted: string;
	// Stable write-once vault UUID
	vaultId: string;
	// Idempotency guard for in-flight local creates
	todoistPendingId: string;
	// TaskNotes recurring task compatibility
	recurrence: string;
	completeInstances: string;
}

export const DEFAULT_PROP_NAMES: PropNames = {
	taskTitle: 'task_title',
	taskStatus: 'task_status',
	taskDone: 'task_done',
	created: 'created',
	modified: 'modified',
	tags: 'tags',
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
	todoistPriorityLabel: 'task_priority_label',
	todoistDeadline: 'todoist_deadline',
	todoistProjectLink: 'todoist_project_link',
	todoistSectionLink: 'todoist_section_link',
	todoistProjectColor: 'todoist_project_color',
	todoistParentProjectLink: 'parent_project_link',
	todoistParentProjectName: 'parent_project_name',
	todoistIsDeleted: 'todoist_is_deleted',
	vaultId: 'vault_id',
	todoistPendingId: 'todoist_pending_id',
	recurrence: 'recurrence',
	completeInstances: 'complete_instances',
};

export interface TaskTodoistSettings {
	tasksFolderPath: string;
	defaultTaskTag: string;
	autoRenameTaskFiles: boolean;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	showScheduledSyncNotices: boolean;
	completedTaskMode: CompletedTaskMode;
	completedFolderPath: string;
	deletedTaskMode: DeletedTaskMode;
	deletedFolderPath: string;
	autoImportEnabled: boolean;
	autoImportProjectScope: ImportProjectScope;
	autoImportAllowedProjectNames: string;
	autoImportRequiredLabel: string;
	autoImportExcludeLabel: string;
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
	showConvertButton: boolean;
	createProjectNotes: boolean;
	projectNotesFolderPath: string;
	projectNoteTemplate: string;
	createSectionNotes: boolean;
	sectionNotesFolderPath: string;
	sectionNoteTemplate: string;
	excludedProjectNames: string;
	excludedSectionNames: string;
	areaProjectNames: string;
	areaProjectNoteTemplate: string;
	projectArchiveFolderPath: string;
	sectionArchiveFolderPath: string;
}

export const DEFAULT_SETTINGS: TaskTodoistSettings = {
	tasksFolderPath: 'Tasks',
	defaultTaskTag: 'tasks',
	autoRenameTaskFiles: false,
	autoSyncEnabled: true,
	autoSyncIntervalMinutes: 5,
	showScheduledSyncNotices: false,
	completedTaskMode: 'keep-in-place',
	completedFolderPath: 'Tasks/_archive',
	deletedTaskMode: 'keep-in-place',
	deletedFolderPath: 'Tasks/_archive',
	autoImportEnabled: true,
	autoImportProjectScope: 'allow-list-by-name',
	autoImportAllowedProjectNames: '',
	autoImportRequiredLabel: 'obsidian',
	autoImportExcludeLabel: '',
	autoImportAssignedToMeOnly: true,
	todoistTokenSecretName: DEFAULT_TODOIST_TOKEN_SECRET_NAME,
	propNames: { ...DEFAULT_PROP_NAMES },
	useProjectSubfolders: false,
	useSectionSubfolders: false,
	todoistLinkStyle: 'web',
	conflictResolution: 'local-wins',
	noteTemplate: '',
	autoOpenNewNote: false,
	showConvertButton: true,
	createProjectNotes: false,
	projectNotesFolderPath: '',
	projectNoteTemplate: '',
	createSectionNotes: false,
	sectionNotesFolderPath: '',
	sectionNoteTemplate: '',
	excludedProjectNames: '',
	excludedSectionNames: '',
	areaProjectNames: '',
	areaProjectNoteTemplate: '',
	projectArchiveFolderPath: 'Projects/_archive',
	sectionArchiveFolderPath: '',
};
