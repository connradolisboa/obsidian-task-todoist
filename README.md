# Obsidian Task Todoist

A powerful two-way sync plugin for [Obsidian](https://obsidian.md/) that bridges your [Todoist](https://todoist.com/) tasks and your Obsidian vault. Each Todoist task becomes a dedicated markdown note with rich YAML frontmatter, giving you the best of both worlds: Todoist's task management and Obsidian's note-taking and linking capabilities.

---

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
- [How Syncing Works](#how-syncing-works)
- [Task Notes](#task-notes)
- [Note Types](#note-types)
- [Frontmatter Properties](#frontmatter-properties)
- [Template Variables](#template-variables)
- [Commands](#commands)
- [Settings Reference](#settings-reference)
  - [General](#general-tab)
  - [Import](#import-tab)
  - [Sync](#sync-tab)
  - [Notes](#notes-tab)
  - [Projects](#projects-tab)
  - [NoteTask](#notetask-tab)
  - [Properties](#properties-tab)
- [Features Guide](#features-guide)
  - [NoteTask Feature](#notetask-feature)
  - [Project and Section Notes](#project-and-section-notes)
  - [Reference Projects](#reference-projects)
  - [Folder Notes Mode](#folder-notes-mode)
  - [Project Folder Organization](#project-folder-organization)
  - [Archive Handling](#archive-handling)
  - [Checklist Conversion](#checklist-conversion)
  - [Linked Checklist Sync](#linked-checklist-sync)
- [Advanced Topics](#advanced-topics)
  - [Priority Mapping](#priority-mapping)
  - [Sync Status Values](#sync-status-values)
  - [Conflict Resolution](#conflict-resolution)
  - [Change Detection](#change-detection)

---

## Features

- **Two-way sync** — Changes in Obsidian sync to Todoist; new/updated Todoist tasks sync back as notes
- **NoteTask linking** — Link any Obsidian note to a Todoist task with automatic title, property, and status syncing
- **Flexible import filters** — Import by project, label, assignee, or any combination with exclusion support
- **Custom task note templates** — Full control over note structure with variable substitution
- **Project & section management** — Auto-create and organize notes for each project and section with custom templates
- **Reference projects** — Designate projects as reference materials with special folder structure
- **Folder notes mode** — Organize project/section notes in dedicated folder structures
- **Nested project hierarchy** — Automatic folder structure mirroring Todoist parent-child project relationships
- **Project tasks** — Auto-create Todoist tasks for new project notes
- **Area projects** — Special formatting for area-of-responsibility projects (Work, Personal, Health, etc.)
- **Conflict resolution** — Choose whether local edits or remote data wins when both sides change
- **Archive handling** — Multiple strategies for completed and deleted tasks
- **Checklist conversion** — Turn any unchecked checklist item into a synced task note
- **Linked checklist sync** — Checklist items linked to task notes stay in sync with task status
- **Project colors** — Todoist project colors are stored and available in frontmatter
- **Offline support** — Create and edit tasks while offline; they sync when connectivity returns
- **Fully customizable frontmatter** — Rename every property to fit your own naming conventions
- **Scheduled auto-sync** — Background sync at a configurable interval
- **Template variables** — Date and task variables for dynamic folder paths and templates

---

## Getting Started

### 1. Install the Plugin

This plugin is not yet in the community plugins browser. Install it manually:

1. Download the latest release from the GitHub releases page
2. Copy `main.js` and `manifest.json` into `.obsidian/plugins/obsidian-task-todoist/` in your vault
3. Enable the plugin in **Settings → Community Plugins**

### 2. Get Your Todoist API Token

1. Go to **Todoist → Settings → Integrations**
2. Copy your personal API token from the "API token" section

### 3. Configure the Plugin

1. Open **Settings → Task Todoist**
2. Paste your API token into the **Todoist API token** field
3. Click **Test connection** to verify the token
4. Set the **Task folder path** — the base folder where task notes will be stored
5. In the **Import** tab, configure which projects/labels to sync
6. Configure any other settings to match your workflow
7. Run **Sync Todoist Now** from the command palette to import your first batch of tasks

---

## How Syncing Works

The sync engine performs a full reconciliation between Todoist and your vault on every sync run. Here is the order of operations:

1. **Fetch deleted task IDs** — Check the Todoist activity API for recently deleted tasks
2. **Repair signatures** — Fix any malformed frontmatter signature lines from prior runs
3. **Backfill vault IDs** — Add stable UUIDs to existing notes that don't have one yet
4. **Process pending local creates** — Send new task notes (status: `queued_local_create`) to Todoist
5. **Process pending local updates** — Send modified task notes (status: `dirty_local`) to Todoist
6. **Sync NoteTask updates** — Push property changes from linked Obsidian notes to Todoist tasks
7. **Fetch remote state** — Pull the latest tasks, projects, and sections from the Todoist API
8. **Filter importable tasks** — Apply your import rules to determine which remote tasks should exist as notes
9. **Include ancestors** — Any parent tasks of importable tasks are also included, even if they don't match rules
10. **Upsert task notes** — Create new notes or update existing ones with the latest remote data
11. **Apply wikilinks** — Update project, section, and parent task wikilinks in frontmatter
12. **Handle missing tasks** — Archive, mark as deleted, or mark as stopped based on configuration
13. **Archive/unarchive projects and sections** — Move metadata notes when projects/sections change state
14. **Sync NoteTask pulls** — Update linked notes with latest task properties (when notes are unchanged locally)
15. **Create NoteTask auto-creates** — Create new NoteTasks for notes with designated tags
16. **Sync linked checklists** — Update checklist item check states to match linked task note statuses

### Change Detection

The plugin uses **signature-based hashing** (FNV-1a) to avoid unnecessary writes:

- **Remote signature** (`todoist_last_imported_signature`) — A hash of all remote task data as of the last import. If this matches the current remote data, the note is not overwritten.
- **Synced signature** (`todoist_last_synced_signature`) — A hash of the local task data as of the last successful push to Todoist. If local frontmatter has changed since then, the task is marked `dirty_local` and queued for an update.
- **NoteTask sync timestamp** (`todoist_note_task_synced_at`) — For linked notes, tracks when the last sync occurred to detect if the note has changed locally.

### Conflict Resolution

When both local and remote have changed since the last sync, the plugin uses your configured **conflict resolution** strategy:

| Mode | Behavior |
|---|---|
| `local-wins` (default) | Local changes are preserved; remote data is not applied |
| `remote-wins` | Remote data overwrites local changes |

For NoteTask features specifically, **Obsidian always wins**: if the note was modified more recently than the last sync, push-only mode is used; otherwise pull is allowed.

### Idempotency on Crash Recovery

When a local-only task is first queued for creation in Todoist, the plugin writes a `todoist_pending_id` to the note's frontmatter **before** dispatching the API call. If the plugin crashes between dispatch and confirmation, the next sync sees the pending ID and skips creating a duplicate. Once confirmed, the real `todoist_id` is written and `todoist_pending_id` is cleared.

---

## Task Notes

Each Todoist task is represented as a single markdown note. The YAML frontmatter holds all structured metadata; the **note body is your personal notes and is never synced to or from Todoist**.

The task's Todoist description is stored in the `todoist_description` frontmatter property, not the note body.

### Default Note Structure

When no custom template is configured, a new task note looks like this:

```markdown
---
vault_id: "550e8400-e29b-41d4-a716-446655440000"
task_title: "Buy groceries"
task_status: Open
task_done: false
created: "2026-02-22"
modified: "2026-02-22T14:35"
tags:
  - tasks
links: []
todoist_sync: true
todoist_sync_status: synced
todoist_id: "123456789"
todoist_project_id: "project_id"
todoist_project_name: "Personal"
todoist_project_link: "[[Projects/Personal|Personal]]"
todoist_project_color: "#FF0000"
todoist_section_id: "section_id"
todoist_section_name: "Shopping"
todoist_section_link: "[[Projects/Personal/Shopping|Shopping]]"
todoist_priority: 2
todoist_priority_label: low
todoist_due: "2026-02-25"
todoist_due_string: "every Monday"
todoist_is_recurring: true
todoist_deadline: null
todoist_description: "Milk, eggs, bread"
todoist_url: "https://app.todoist.com/app/task/123456789"
todoist_labels:
  - grocery
todoist_parent_id: null
todoist_parent_project_link: null
todoist_has_children: false
todoist_child_task_count: 0
todoist_child_tasks: []
todoist_duration: null
todoist_last_imported_at: "2026-02-22T14:35:00Z"
---

Your personal notes go here. This body is never synced to Todoist.
```

### Custom Templates

You can fully control the note structure with a template (configured in **Settings → Notes**). Templates support all [template variables](#template-variables). Example:

```markdown
---
title: "{{title}}"
status: {{status}}
due: {{due_date}}
priority: {{priority_label}}
project: "[[{{project_link}}]]"
tags:
  - {{tags}}
---

## {{title}}

> **Due:** {{due_date}} | **Priority:** {{priority_label}} | **Project:** {{project}}

{{description}}
```

---

## Note Types

The plugin manages three types of notes:

### Task Notes

Individual Todoist tasks, stored with all task metadata in frontmatter. See [Task Notes](#task-notes) above.

### Project Notes

Metadata notes for each Todoist project. When **Create project notes** is enabled:
- Auto-created in the **Project notes folder**
- Use the **Project note template** (or **Area project note template** for designated area projects)
- Contain `todoist_project_id`, `todoist_project_name`, and other project metadata
- Include links to parent projects (if nested) via `todoist_parent_project_link`
- Store the project's Todoist color in `todoist_project_color`

### Section Notes

Metadata notes for each Todoist section. When **Create section notes** is enabled:
- Auto-created in the **Section notes folder**
- Use the **Section note template**
- Contain `todoist_section_id`, `todoist_section_name`, and parent project reference
- Only created within projects (sections are project-specific)

### NoteTask-Linked Notes

Any existing Obsidian note that has a `todoist_note_task_id` property:
- Represents a custom Obsidian note (not a dedicated task note)
- Can be created manually or via auto-create based on tags
- Syncs properties to/from a linked Todoist task
- Never imported as a regular task note
- See [NoteTask Feature](#notetask-feature) for details

---

## Frontmatter Properties

All property names are customizable via **Settings → Properties**. The defaults are:

### Core Task Properties

| Property | Default Key | Type | Description |
|---|---|---|---|
| Task title | `task_title` | string | The task's title |
| Task status | `task_status` | string | `Open`, `Done`, or custom status |
| Task done | `task_done` | boolean | Boolean flag for Obsidian Bases compatibility |
| Created | `created` | date | Creation date (`YYYY-MM-DD`) |
| Modified | `modified` | datetime | Last modified timestamp (`YYYY-MM-DDTHH:MM`) |
| Tags | `tags` | array | Array of Obsidian tags |
| Links | `links` | array | Array of wikilinks |
| Parent task | `parent_task` | wikilink | Wikilink to parent task note (if subtask) |
| Local updated at | `local_updated_at` | timestamp | ISO timestamp of last local change |

### Todoist Sync Properties

| Property | Default Key | Type | Description |
|---|---|---|---|
| Todoist sync | `todoist_sync` | boolean | Whether note participates in sync |
| Sync status | `todoist_sync_status` | string | Internal sync state (see [Sync Status Values](#sync-status-values)) |
| Todoist ID | `todoist_id` | string | Remote task ID |
| Project ID | `todoist_project_id` | string | Todoist project ID |
| Project name | `todoist_project_name` | string | Human-readable project name |
| Project link | `todoist_project_link` | wikilink | Wikilink to project note |
| Project color | `todoist_project_color` | string | Hex color from Todoist (e.g., `#FF0000`) |
| Section ID | `todoist_section_id` | string | Todoist section ID |
| Section name | `todoist_section_name` | string | Human-readable section name |
| Section link | `todoist_section_link` | wikilink | Wikilink to section note |
| Parent project link | `parent_project_link` | wikilink | Wikilink to parent project (for nested projects) |
| Parent project name | `parent_project_name` | string | Name of parent project |
| Priority | `todoist_priority` | number | Priority number 1–4 |
| Priority label | `task_priority_label` | string | Human-readable: `none`, `low`, `medium`, `high` |
| Due date | `todoist_due` | date | ISO due date (`YYYY-MM-DD`) |
| Due string | `todoist_due_string` | string | Natural language recurrence (e.g., `"every Monday"`) |
| Is recurring | `todoist_is_recurring` | boolean | Whether task recurs |
| Deadline | `todoist_deadline` | date | Hard deadline date (`YYYY-MM-DD`) |
| Duration | `todoist_duration` | number | Task duration in minutes (synced two-way) |
| Description | `todoist_description` | string | Task description (synced to/from Todoist) |
| URL | `todoist_url` | string | Link to the task in Todoist (app URI or web URL) |
| Labels | `todoist_labels` | array | Array of Todoist labels |
| Parent ID | `todoist_parent_id` | string | Todoist ID of parent task |
| Has children | `todoist_has_children` | boolean | Whether task has subtasks |
| Child task count | `todoist_child_task_count` | number | Number of subtasks |
| Child tasks | `todoist_child_tasks` | array | Wikilinks to child task notes |
| Is deleted | `todoist_is_deleted` | boolean | Whether task was deleted in Todoist |

### Project & Section Properties

| Property | Default Key | Type | Description |
|---|---|---|---|
| Todoist project ID | `todoist_project_id` | string | Project ID (for project notes) |
| Todoist project name | `todoist_project_name` | string | Project name (for project notes) |
| Todoist project task ID | `todoist_project_task_id` | string | Task ID created for this project (if **Create project tasks** enabled) |
| Todoist section ID | `todoist_section_id` | string | Section ID (for section notes) |
| Todoist section name | `todoist_section_name` | string | Section name (for section notes) |

### Vault Identity & Idempotency

| Property | Default Key | Type | Description |
|---|---|---|---|
| Vault ID | `vault_id` | string | Write-once stable UUID for the note |
| Pending ID | `todoist_pending_id` | string | Temporary ID during local create dispatch |

### NoteTask Properties

| Property | Default Key | Type | Description |
|---|---|---|---|
| NoteTask ID | `todoist_note_task_id` | string | Todoist task ID linked to this note |
| NoteTask synced at | `todoist_note_task_synced_at` | timestamp | ISO timestamp of last NoteTask sync |

### Change Detection Properties

| Property | Default Key | Type | Description |
|---|---|---|---|
| Last imported signature | `todoist_last_imported_signature` | string | FNV-1a hash of remote data at last import |
| Last synced signature | `todoist_last_synced_signature` | string | FNV-1a hash of local data at last push |
| Last imported at | `todoist_last_imported_at` | timestamp | ISO timestamp of last import |

---

## Template Variables

Template variables work in task note templates, project note templates, section note templates, folder path settings, and tag settings. They are resolved at runtime with current values.

### Date Variables (Available Everywhere)

| Variable | Example Output | Description |
|---|---|---|
| `{{YYYY}}` | `2026` | 4-digit year |
| `{{YY}}` | `26` | 2-digit year |
| `{{MM}}` | `02` | 2-digit month (zero-padded) |
| `{{M}}` | `2` | Month without padding |
| `{{DD}}` | `22` | 2-digit day (zero-padded) |
| `{{D}}` | `22` | Day without padding |
| `{{YYYY-MM}}` | `2026-02` | Year-month |
| `{{YYYY-MM-DD}}` | `2026-02-22` | Full ISO date |

**Example:** Set **Task folder path** to `Tasks/{{YYYY}}/{{MM}}` to organize notes by year and month.

### Task Template Variables

| Variable | Description |
|---|---|
| `{{title}}` | Task title |
| `{{description}}` | Todoist description |
| `{{due_date}}` | ISO due date |
| `{{due_string}}` | Natural language recurrence string |
| `{{deadline_date}}` | Hard deadline date |
| `{{priority}}` | Priority number (1–4) |
| `{{priority_label}}` | Human-readable priority |
| `{{project}}` | Project name |
| `{{project_id}}` | Project ID |
| `{{project_link}}` | Wikilink to project note |
| `{{section}}` | Section name |
| `{{section_id}}` | Section ID |
| `{{section_link}}` | Wikilink to section note |
| `{{todoist_id}}` | Todoist task ID |
| `{{url}}` | Todoist task URL or app link |
| `{{tags}}` | Default task tag |
| `{{created}}` | Creation date |
| `{{parent_task_link}}` | Wikilink to parent task note |
| `{{duration}}` | Task duration in minutes |

### Project Template Variables

| Variable | Description |
|---|---|
| `{{project_name}}` | Project name |
| `{{project_id}}` | Project ID |
| `{{parent_project_link}}` | Wikilink to parent project (if applicable) |
| `{{project_color}}` | Hex color code from Todoist |
| All date variables | See above |

### Section Template Variables

| Variable | Description |
|---|---|
| `{{section_name}}` | Section name |
| `{{section_id}}` | Section ID |
| `{{project_name}}` | Parent project name |
| `{{project_id}}` | Parent project ID |
| `{{project_link}}` | Wikilink to parent project note |
| All date variables | See above |

---

## Commands

All commands are available from the Obsidian command palette (`Ctrl/Cmd+P`).

### Test Todoist Connection
**ID:** `test-todoist-connection`

Tests whether the configured API token can reach the Todoist API. Displays a success or failure notice with a timestamp.

### Sync Todoist Now
**ID:** `sync-todoist-now`

Triggers a full sync immediately. After completion, shows a summary notice with counts of tasks created, updated, and archived.

### Create Task Note
**ID:** `create-task-note`

Opens a modal to create a new task note. Fields include:
- Title
- Description
- Project (picker)
- Section (picker, filtered by selected project)
- Due date
- Recurrence string
- **Todoist Sync** toggle — if enabled, the task is queued for creation in Todoist on the next sync

### Create NoteTask for Current Note
**ID:** `create-note-task`

Creates a Todoist task for the current note. The task is linked via the `todoist_note_task_id` property. If a project wikilink exists in `todoist_project_link`, uses that project; otherwise defaults to inbox.

### Convert Checklist Item to Task Note
**ID:** `convert-checklist-item-to-task-note`

Converts the unchecked checklist item on the current line into a task note. The original checklist line is replaced with a wikilink to the new note. See [Checklist Conversion](#checklist-conversion) for details.

---

## Settings Reference

### General Tab

| Setting | Description |
|---|---|
| **Todoist API token** | Your personal Todoist API token. Stored securely in Obsidian's secret storage. |
| **Token secret name** | The key used to store the token in secret storage. Only change if you have multiple vaults. |
| **Test connection** | Verifies the API token is valid and shows the Todoist account user info. |
| **Link style** | How Todoist task URLs are formatted in notes: `web` (`https://app.todoist.com/...`) or `app` (`todoist://task?id=...`) |
| **Task folder path** | Base folder for all task notes. Supports [date variables](#date-variables-available-everywhere). |
| **Default task tag** | Tag added to every imported task note. Supports date variables. |
| **Show convert button** | Show the `↗` button next to unchecked checklist items for one-click conversion. |
| **Disable notifications** | Suppress all plugin sync notices and alerts. |
| **Create task note** | Button to open the Create Task Note modal directly from settings. |

### Import Tab

| Setting | Description |
|---|---|
| **Enable auto import** | Toggle whether tasks are imported from Todoist during sync. |
| **Project scope** | `all-projects` — import from all projects; `allow-list-by-name` — only from listed projects. |
| **Allowed project names** | Comma-separated list of project names to import (when scope is `allow-list-by-name`). |
| **Required Todoist label** | Only import tasks that carry this specific label. Leave blank to import all. |
| **Exclude label** | Tasks with this Todoist label are excluded from import, even if they match other criteria. |
| **Assigned to me only** | Only import tasks assigned to your Todoist account. |
| **Excluded project names** | Comma-separated list of projects to always skip. |
| **Excluded section names** | Comma-separated list of sections to always skip. |
| **Exclude note prefix** | Don't import tasks whose title starts with `@` (e.g., `@meeting notes`). |

> **Note:** Even if a parent task doesn't match your import rules, it will be imported automatically if any of its children do.

### Sync Tab

| Setting | Description |
|---|---|
| **Run sync now** | Manual sync trigger (same as the command). |
| **Enable scheduled sync** | Toggle background auto-sync. |
| **Scheduled sync interval** | Minutes between auto-syncs (1–120, default 5). |
| **Show sync notices** | Show a notification notice after each scheduled auto-sync. |
| **Conflict resolution** | `local-wins` (default) or `remote-wins`. See [Conflict Resolution](#conflict-resolution). |
| **Last sync** | Displays when the last sync completed. |
| **Auto-rename task files** | Automatically rename note files when a task's title changes in Todoist. |
| **Use project subfolders** | Organize task notes into `{TaskFolder}/{ProjectName}/` subfolders. |
| **Use section subfolders** | Further organize into `{TaskFolder}/{ProjectName}/{SectionName}/` (requires project subfolders). |
| **Completed task mode** | How to handle completed tasks: `keep-in-place` or `move-to-folder`. |
| **Completed folder path** | Destination folder for completed task notes (when using `move-to-folder`). |
| **Deleted task mode** | How to handle deleted tasks: `keep-in-place`, `move-to-folder`, or `stop-syncing`. |
| **Deleted folder path** | Destination folder for deleted task notes (when using `move-to-folder`). |

### Notes Tab

| Setting | Description |
|---|---|
| **Task note template** | Full-file template for new task notes. Supports all [task template variables](#task-template-variables). |
| **Auto-open new note** | Automatically open newly created task notes in the editor. |
| **Create project notes** | Toggle auto-creation of notes for each Todoist project. |
| **Project notes folder** | Folder for project notes. Supports date variables. |
| **Project note template** | Template for project notes. Supports [project template variables](#project-template-variables). |
| **Use project folder notes** | Place each project note inside a subfolder: `{folder}/{ProjectName}/{ProjectName}.md`. |
| **Use project note subfolders** | Mirror parent project hierarchy when placing project notes (only with folder notes enabled). |
| **Create section notes** | Toggle auto-creation of section notes (requires project subfolders). |
| **Section notes folder** | Folder for section notes. Supports date variables. |
| **Section note template** | Template for section notes. Supports [section template variables](#section-template-variables). |
| **Use section folder notes** | Place each section note inside a subfolder: `{folder}/{ProjectName}/{SectionName}/{SectionName}.md`. |
| **Area project names** | Comma-separated names of projects that use the area note template. |
| **Area note folder path** | Optional separate folder for area project notes (overrides **Project notes folder** for these projects). |
| **Area project note template** | Template used for designated "area" projects (e.g., "Work", "Personal", "Health"). |

### Projects Tab

| Setting | Description |
|---|---|
| **Create project tasks** | Auto-create a Todoist task when a new project note is created. |
| **Project archive folder** | Destination folder for archived project notes. |
| **Section archive folder** | Destination folder for archived section notes. |
| **Reference project names** | Comma-separated names of projects designated as "reference" (for co-locating notes and tasks). |
| **Reference notes folder** | Base folder for reference project notes and their tasks. |
| **Reference project note template** | Custom template for reference project notes (falls back to regular project template). |

### NoteTask Tab

| Setting | Description |
|---|---|
| **NoteTask auto-create tags** | Comma-separated Obsidian tags that trigger automatic NoteTask creation on sync. |
| **NoteTask exclude paths** | Comma-separated folder paths to exclude from NoteTask auto-creation. |
| **NoteTask to-do statuses** | Comma-separated status values that mean "open" (default: `Open,Active,Ongoing,Backlog,Waiting`). Used for status-based completion handling. |
| **NoteTask done statuses** | Comma-separated status values that should complete the Todoist task. Leave blank to never auto-complete via status. |
| **NoteTask stop statuses** | Comma-separated status values that delete the Todoist task and prevent re-creation. |

### Properties Tab

Every frontmatter property key the plugin writes can be renamed here. This is useful if you use Obsidian Bases or have existing conventions that conflict with the defaults.

Each property shows:
- A text field to set the key name
- A **Reset to defaults** button to restore all names at once

The categories of configurable properties are:
- **Core task properties** — title, status, done, created, modified, tags, links, parent task
- **Todoist sync properties** — all `todoist_*` fields
- **Project & section** — project link, section link, colors
- **Vault identity** — vault ID, pending ID
- **NoteTask properties** — NoteTask ID and sync timestamp

---

## Features Guide

### NoteTask Feature

The **NoteTask** feature allows you to link any existing Obsidian note to a Todoist task. This is useful when:
- You want a specific note (not a task note) to have a corresponding Todoist task
- You want to track areas, projects, or reference documents as tasks
- You need a single Todoist task that links back to rich Obsidian content
- You want to sync properties (due date, priority, description) between a note and a task

#### Creating a NoteTask

There are two ways to create a NoteTask:

**Manual Creation:**
1. Run **Create NoteTask for current note** command
2. The plugin creates a Todoist task with the note's filename as the title
3. The task is linked via the `todoist_note_task_id` property

**Automatic Creation:**
1. In **Settings → NoteTask**, set **NoteTask auto-create tags** (comma-separated)
2. Any note with those tags automatically gets a NoteTask created on sync
3. Use **NoteTask exclude paths** to skip specific folders
4. Once a NoteTask ID is set (even auto-created), auto-create is disabled for that note

#### NoteTask Sync

**Push (Obsidian → Todoist):**
- Title — updated when note filename changes
- Description — from `todoist_description` property
- Due date — from `todoist_due` property
- Deadline — from `todoist_deadline` property
- Priority — from `todoist_priority` property
- Duration — from `todoist_duration` property
- Labels — merged from explicit `todoist_labels` and Obsidian note tags
- Status/Completion — determined by `task_status` and configured status settings

**Pull (Todoist → Obsidian):**
- Only applied if the note's `modified` timestamp is earlier than `todoist_note_task_synced_at` (note is unchanged locally)
- Updates due, priority, deadline, description when remote task changes

**Conflict Resolution:**
- **Obsidian always wins**: if note was modified since last sync, push only; otherwise pull is allowed
- `todoist_note_task_synced_at` tracks the last sync timestamp to enable this detection

#### NoteTask Status Handling

Status-based completion is configured with three setting groups:

| Setting | Purpose | Example |
|---|---|---|
| **NoteTask to-do statuses** | Statuses that mean "open" | `Open,Active,Ongoing` |
| **NoteTask done statuses** | Statuses that complete the task | `Done,Completed` |
| **NoteTask stop statuses** | Statuses that delete the task | `Archived,Cancelled` |

**Behavior:**
- If a note's `task_status` is in **to-do statuses** and the Todoist task is complete → uncomplete it (push `isDone: false`)
- If a note's `task_status` is in **done statuses** → complete the task (push `isDone: true`)
- If a note's `task_status` is in **stop statuses** → delete the Todoist task and set `todoist_sync_status: 'stopped'` to prevent re-creation

#### NoteTask Deletion

- **Deleted in Todoist** — Note is marked with `todoist_sync_status: 'deleted_remote'` but not removed
- **Deleted in Obsidian** — The note is deleted from vault, no action taken on Todoist task
- **Stop status** — Task is deleted in Todoist and note is marked `stopped` to prevent re-creation

#### Project Assignment

The NoteTask's project is determined by:
1. Wikilink in `todoist_project_link` property (if present)
2. Default to Todoist inbox if no project link specified

### Project and Section Notes

When **Create project notes** is enabled, the plugin automatically maintains a note for each Todoist project. These notes serve as reference hubs and can be linked from task notes via the `todoist_project_link` frontmatter property.

When **Create section notes** is enabled (requires project subfolders), dedicated notes are also created for each section.

#### Project Note Structure

A default project note contains:
- `todoist_project_id` — Project ID
- `todoist_project_name` — Project name
- `todoist_project_color` — Hex color from Todoist (e.g., `#FF0000`)
- `todoist_parent_project_link` — Wikilink to parent project (if nested)
- `todoist_parent_project_name` — Name of parent project

#### Area Projects

Some projects represent areas of responsibility (e.g., "Work", "Personal", "Health") rather than time-bounded projects. You can list these in **Area project names**; they will use the separate **Area project note template** for custom formatting.

Area notes can also be placed in a separate **Area note folder path** if desired.

#### Project Tasks

When **Create project tasks** is enabled:
- A new Todoist task is automatically created in the project when its note is created
- The task ID is stored in `todoist_project_task_id`
- This allows tracking project-level work alongside the project itself

#### Nested Project Support

The plugin automatically mirrors Todoist's parent-child project hierarchy:
- Parent projects are identified via the `parent_id` field
- Folder structure is built as: `{ProjectFolder}/{Parent}/{Child}/{GrandChild}/`
- Project notes can reflect the hierarchy with `todoist_parent_project_link`
- Set **Use project note subfolders** to place project notes inside their own folders with parent links

### Reference Projects

Reference projects represent shared reference materials (templates, checklists, resources) that are organized separately from your active project work.

#### Configuring Reference Projects

1. In **Settings → Projects**, set **Reference project names** (comma-separated)
2. Set **Reference notes folder** — the base folder for all reference projects and their tasks
3. Optionally set **Reference project note template** (falls back to regular template)

#### Reference Project Structure

Reference projects:
- Always use folder-notes style: `{refFolder}/{segments from ref root}/{ProjectName}/{ProjectName}.md`
- Tasks are co-located: `{refFolder}/{segments from ref root}/{ProjectName}/{task}.md`
- Sub-projects of reference projects inherit the reference designation
- Folder structure starts from the reference root (excludes ancestors outside reference)

**Example:** With reference names `"Templates,Resources"` and folder `_Reference/`:
```
_Reference/
  Templates/
    Templates.md
    template-task-1.md
    template-task-2.md
  Resources/
    Resources.md
    resource-task-1.md
```

#### Archive Handling

When a reference project is archived:
- The entire folder is moved to **Project archive folder**
- When unarchived, the folder is restored to `{refFolder}/{segments}/{Name}/`

### Folder Notes Mode

Folder notes mode organizes project and section notes into dedicated subfolder structures, useful for grouping metadata alongside content.

#### Enabling Folder Notes

- **Use project folder notes** — Place project notes in: `{folder}/{ProjectName}/{ProjectName}.md`
- **Use section folder notes** — Place section notes in: `{folder}/{ProjectName}/{SectionName}/{SectionName}.md`
- These settings only appear when the corresponding folder path is configured

#### Folder Hierarchy with Subfolders

When both **Use project folder notes** and **Use project note subfolders** are enabled:
- Project notes mirror the parent-child hierarchy
- Example: `Projects/Department/Team/ProjectName/ProjectName.md`
- Parent links in frontmatter make navigation easy

#### Archive Operations

With folder notes mode:
- Renaming uses `file.parent` to rename the entire subfolder
- Archive/unarchive moves the whole folder (not just the note)
- The folder structure is preserved on restore

### Project Folder Organization

The plugin offers multiple ways to organize task notes relative to their projects:

#### Basic Organization

- **No subfolders** (default): All tasks in `{TaskFolder}/`
- **Use project subfolders**: Tasks in `{TaskFolder}/{ProjectName}/`
- **Use section subfolders**: Tasks in `{TaskFolder}/{ProjectName}/{SectionName}/`

#### Nested Project Hierarchy

When your Todoist projects have parent-child relationships:
- Set **Use project subfolders** — enables hierarchy support
- Folder structure automatically becomes: `{TaskFolder}/{Parent}/{Child}/{Grandchild}/task.md`
- No additional settings needed — automatically detected from `parent_id`

#### Collision Handling

If two projects share the same name:
- The plugin appends the project ID: `{folder}/{ProjectName}-{project_id}/`
- Prevents folder conflicts while keeping names readable

#### Section Organization

Sections are scoped to projects (no global sections):
- With **Use section subfolders**: `{TaskFolder}/{ProjectName}/{SectionName}/`
- Section folders only created under their parent project
- Sections with duplicate names within a project: `{SectionName}-{section_id}/`

### Archive Handling

When a task is completed or deleted in Todoist, you can choose from four archive modes:

| Mode | Behavior |
|---|---|
| `keep-in-place` | Leave the note in its current location; update `todoist_sync_status` to reflect remote state |
| `move-to-folder` | Move the note to the **Completed folder path** or **Deleted folder path** |

**Task Lifecycle:**
1. Completed in Todoist → handled by **Completed task mode**
2. Deleted in Todoist → handled by **Deleted task mode**
3. Uncompleted in Todoist (after being completed) → restored if in archive folder

Project and section notes have their own separate archive folder settings.

When a project or section is **unarchived** in Todoist, the plugin moves the corresponding note back out of the archive folder.

### Checklist Conversion

Any unchecked checklist item in any note can be converted into a full task note.

**How to trigger:**
- Click the `↗` button that appears next to the item (requires **Show convert button** enabled in settings)
- Place the cursor on the checklist line and run the **Convert Checklist Item to Task Note** command

**What happens:**
1. A new task note is created in the task folder using your task note template
2. The original checklist line is replaced with a wikilink: `- [ ] [[TaskTitle]]`
3. If **Todoist Sync** is enabled, the task is queued for creation in Todoist on the next sync

**Inline task directives** in the checklist item text can pre-populate task metadata:
- `@project(ProjectName)` — assign to a project
- `@section(SectionName)` — assign to a section
- `@due(YYYY-MM-DD)` — set a due date
- `@priority(high|medium|low|none)` — set priority

Example:
```markdown
- [ ] Buy groceries @project(Shopping) @due(2026-03-20) @priority(high)
```

### Linked Checklist Sync

When a checklist item is a wikilink to a task note (format: `- [ ] [[NoteName]]` or `- [x] [[NoteName]]`), the plugin keeps the checkbox in sync with the task note's `task_status`.

- If the linked task note is marked **Done**, the checklist item is automatically checked (`[x]`)
- If the linked task note is re-opened to **Open**, the checklist item is unchecked (`[ ]`)
- Conversely, checking or unchecking the item in the editor updates the linked task note's status

This lets you maintain a high-level overview note with a checklist that stays automatically up-to-date.

---

## Advanced Topics

### Priority Mapping

Todoist uses a reversed numeric priority scale. The plugin maps it to human-readable labels:

| Todoist Priority | Label in Obsidian | Meaning |
|---|---|---|
| Priority 4 | `high` | Urgent / P1 |
| Priority 3 | `medium` | High / P2 |
| Priority 2 | `low` | Medium / P3 |
| Priority 1 | `none` | Normal / P4 |

The numeric value is stored in `todoist_priority`; the label is stored in `todoist_priority_label`. Use either in templates or conditions.

### Sync Status Values

The `todoist_sync_status` frontmatter property tracks the lifecycle of each task note:

| Status | Meaning | Next Step |
|---|---|---|
| `synced` | Note matches Todoist; no pending changes | None |
| `dirty_local` | Local edits are pending | Will be pushed to Todoist on next sync |
| `queued_local_create` | New local note, not yet created in Todoist | Will be created on next sync |
| `local_only` | Note exists locally but is not connected to Todoist | Edit `todoist_sync: false` or manually set ID |
| `missing_remote` | Task was deleted from Todoist | Handled per **Deleted task mode** |
| `completed_remote` | Task was completed in Todoist | Handled per **Completed task mode** |
| `archived_remote` | Task was archived in Todoist | Handled per archive settings |
| `deleted_remote` | Task was deleted in Todoist (confirmed via API) | Handled per **Deleted task mode** |
| `stopped` | NoteTask deleted in Todoist (stop status used); prevents re-creation | Manual intervention required to relink |

### Conflict Resolution

When both local and remote have changed since the last sync:

**For task notes:**
- **local-wins** — Local changes are preserved; remote data is not applied (signature-based detection)
- **remote-wins** — Remote data overwrites local changes

**For NoteTask-linked notes:**
- **Always Obsidian-wins** — If note was modified more recently than last sync, push only; otherwise pull is allowed
- Uses `todoist_note_task_synced_at` to detect note-side changes

Set your preference in **Settings → Sync → Conflict resolution**.

### Change Detection

The plugin uses signature-based hashing to efficiently detect changes:

**FNV-1a Hashing:**
- Fast, collision-resistant hashing of all frontmatter properties
- Stored in `todoist_last_imported_signature` (remote state) and `todoist_last_synced_signature` (local state)
- No changes detected = no file write, preserving modification times

**Remote Detection:**
If `todoist_last_imported_signature` matches the current hash of remote data:
- Note is not re-imported (prevents unnecessary disk writes)
- Conflict detection still works via synced signature

**Local Detection:**
If `todoist_last_synced_signature` differs from current local frontmatter:
- Note is marked `dirty_local` and queued for push
- Local changes are sent to Todoist on next sync

**Benefit:**
- Offline edits are batched and sent together
- No wasted API calls or disk I/O
- Clear audit trail of what changed and when

---

## License

This plugin is licensed under the Zero-Clause BSD License. See the `LICENSE` file for details.
