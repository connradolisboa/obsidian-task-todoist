# Obsidian Task Todoist

A powerful two-way sync plugin for [Obsidian](https://obsidian.md/) that bridges your [Todoist](https://todoist.com/) tasks and your Obsidian vault. Each Todoist task becomes a dedicated markdown note with rich YAML frontmatter, giving you the best of both worlds: Todoist's task management and Obsidian's note-taking and linking capabilities.

---

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
- [How Syncing Works](#how-syncing-works)
- [Task Notes](#task-notes)
- [Frontmatter Properties](#frontmatter-properties)
- [Template Variables](#template-variables)
- [Commands](#commands)
- [Settings Reference](#settings-reference)
  - [General](#general-tab)
  - [Import](#import-tab)
  - [Sync](#sync-tab)
  - [Notes](#notes-tab)
  - [Properties](#properties-tab)
- [Project and Section Notes](#project-and-section-notes)
- [Archive Handling](#archive-handling)
- [Checklist Conversion](#checklist-conversion)
- [Linked Checklist Sync](#linked-checklist-sync)
- [Priority Mapping](#priority-mapping)
- [Sync Status Values](#sync-status-values)

---

## Features

- **Two-way sync** — Changes in Obsidian sync to Todoist; new/updated Todoist tasks sync back as notes
- **Conflict resolution** — Choose whether local edits or remote data wins when both sides change
- **Flexible import filters** — Import by project, label, assignee, or any combination
- **Custom task note templates** — Full control over note structure with variable substitution
- **Project & section subfolders** — Organize task notes into a folder hierarchy mirroring Todoist
- **Project & section notes** — Auto-create dedicated notes for each Todoist project and section
- **Archive handling** — Multiple strategies for completed and deleted tasks
- **Checklist conversion** — Turn any unchecked checklist item into a synced task note
- **Linked checklist sync** — Checklist items linked to task notes stay in sync with task status
- **Offline support** — Create and edit tasks while offline; they sync when connectivity returns
- **Fully customizable frontmatter** — Rename every property to fit your own naming conventions
- **Scheduled auto-sync** — Background sync at a configurable interval

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
5. Configure import rules, sync interval, and any other settings to match your workflow
6. Run **Sync Todoist Now** from the command palette to import your first batch of tasks

---

## How Syncing Works

The sync engine performs a full reconciliation between Todoist and your vault on every sync run. Here is the order of operations:

1. **Repair signatures** — Fix any malformed frontmatter signature lines from prior runs
2. **Backfill vault IDs** — Add stable UUIDs to existing notes that don't have one yet
3. **Process pending local creates** — Send new task notes (status: `queued_local_create`) to Todoist
4. **Process pending local updates** — Send modified task notes (status: `dirty_local`) to Todoist
5. **Fetch remote state** — Pull the latest tasks, projects, and sections from the Todoist API
6. **Filter importable tasks** — Apply your import rules to determine which remote tasks should exist as notes
7. **Include ancestors** — Any parent tasks of importable tasks are also included, even if they don't match rules
8. **Upsert task notes** — Create new notes or update existing ones with the latest remote data
9. **Apply wikilinks** — Update project, section, and parent task wikilinks in frontmatter
10. **Handle missing tasks** — Archive or mark tasks that were deleted or completed in Todoist
11. **Archive/unarchive projects and sections** — Move metadata notes when projects/sections change state
12. **Sync linked checklists** — Update checklist item check states to match linked task note statuses

### Change Detection

The plugin uses **signature-based hashing** (FNV-1a) to avoid unnecessary writes:

- **Remote signature** (`todoist_last_imported_signature`) — A hash of all remote task data as of the last import. If this matches the current remote data, the note is not overwritten.
- **Synced signature** (`todoist_last_synced_signature`) — A hash of the local task data as of the last successful push to Todoist. If local frontmatter has changed since then, the task is marked `dirty_local` and queued for an update.

### Conflict Resolution

When both local and remote have changed since the last sync, the plugin uses your configured **conflict resolution** strategy:

| Mode | Behavior |
|---|---|
| `local-wins` (default) | Local changes are preserved; remote data is not applied |
| `remote-wins` | Remote data overwrites local changes |

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
todoist_section_id: "section_id"
todoist_section_name: "Shopping"
todoist_priority: 2
todoist_priority_label: low
todoist_due: "2026-02-25"
todoist_due_string: "every Monday"
todoist_is_recurring: true
todoist_deadline: null
todoist_description: "Milk, eggs, bread"
todoist_url: "https://app.todoist.com/app/task/123456789"
todoist_project_link: "[[Projects/Personal|Personal]]"
todoist_section_link: "[[Projects/Personal/Shopping|Shopping]]"
todoist_labels:
  - grocery
todoist_parent_id: null
todoist_has_children: false
todoist_child_task_count: 0
todoist_child_tasks: []
todoist_last_imported_at: "2026-02-22T14:35:00Z"
---

Your personal notes go here. This body is never synced to Todoist.
```

### Custom Templates

You can fully control the note structure with a template (configured in **Settings → Notes**). Templates support all [template variables](#template-variables). Example:

```markdown
---
title: "{{title}}"
status: Open
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

## Frontmatter Properties

All property names are customizable via **Settings → Properties**. The defaults are:

### Core Task Properties

| Property | Default Key | Description |
|---|---|---|
| Task title | `task_title` | The task's title |
| Task status | `task_status` | `Open` or `Done` |
| Task done | `task_done` | Boolean (for Obsidian Bases compatibility) |
| Created | `created` | Creation date (`YYYY-MM-DD`) |
| Modified | `modified` | Last modified timestamp (`YYYY-MM-DDTHH:MM`) |
| Tags | `tags` | Array of tags |
| Links | `links` | Array of links |
| Parent task | `parent_task` | Wikilink to parent task note |
| Local updated at | `local_updated_at` | ISO timestamp of last local change |

### Todoist Sync Properties

| Property | Default Key | Description |
|---|---|---|
| Todoist sync | `todoist_sync` | Whether note participates in sync |
| Sync status | `todoist_sync_status` | Internal sync state (see [Sync Status Values](#sync-status-values)) |
| Todoist ID | `todoist_id` | Remote task ID |
| Project ID | `todoist_project_id` | Todoist project ID |
| Project name | `todoist_project_name` | Human-readable project name |
| Section ID | `todoist_section_id` | Todoist section ID |
| Section name | `todoist_section_name` | Human-readable section name |
| Priority | `todoist_priority` | Priority number 1–4 |
| Priority label | `todoist_priority_label` | Human-readable: `none`, `low`, `medium`, `high` |
| Due date | `todoist_due` | ISO due date (`YYYY-MM-DD`) |
| Due string | `todoist_due_string` | Natural language recurrence (e.g., `"every Monday"`) |
| Is recurring | `todoist_is_recurring` | Boolean |
| Deadline | `todoist_deadline` | Hard deadline date (`YYYY-MM-DD`) |
| Description | `todoist_description` | Task description (synced to/from Todoist) |
| URL | `todoist_url` | Link to the task in Todoist |
| Labels | `todoist_labels` | Array of Todoist labels |
| Parent ID | `todoist_parent_id` | Todoist ID of parent task |
| Has children | `todoist_has_children` | Boolean |
| Child task count | `todoist_child_task_count` | Number of subtasks |
| Child tasks | `todoist_child_tasks` | Wikilinks to child task notes |
| Project link | `todoist_project_link` | Wikilink to project note |
| Section link | `todoist_section_link` | Wikilink to section note |
| Last imported signature | `todoist_last_imported_signature` | Hash for remote change detection |
| Last synced signature | `todoist_last_synced_signature` | Hash for local change detection |
| Last imported at | `todoist_last_imported_at` | ISO timestamp of last import |

### Vault Identity & Idempotency

| Property | Default Key | Description |
|---|---|---|
| Vault ID | `vault_id` | Write-once stable UUID for the note |
| Pending ID | `todoist_pending_id` | Temporary ID during local create dispatch |

---

## Template Variables

Template variables work in task note templates, project note templates, section note templates, folder path settings, and the default tag setting.

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

### Project Template Variables

| Variable | Description |
|---|---|
| `{{project_name}}` | Project name |
| `{{project_id}}` | Project ID |
| `{{parent_project_link}}` | Wikilink to parent project (if applicable) |
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

### Convert Checklist Item to Task Note
**ID:** `convert-checklist-item-to-task-note`

Converts the unchecked checklist item on the current line (or the line the cursor is on) into a task note. The original checklist line is replaced with a wikilink to the new note. See [Checklist Conversion](#checklist-conversion) for details.

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
| **Create task note** | Button to open the Create Task Note modal directly from settings. |

### Import Tab

| Setting | Description |
|---|---|
| **Enable auto import** | Toggle whether tasks are imported from Todoist during sync. |
| **Project scope** | `all-projects` — import from all projects; `allow-list-by-name` — only from listed projects. |
| **Allowed project names** | Comma-separated list of project names to import (when scope is `allow-list-by-name`). |
| **Required Todoist label** | Only import tasks that carry this specific label. Leave blank to import all. |
| **Assigned to me only** | Only import tasks assigned to your Todoist account. |
| **Excluded project names** | Comma-separated list of projects to always skip. |
| **Excluded section names** | Comma-separated list of sections to always skip. |

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
| **Archive mode** | How completed/deleted tasks are handled. See [Archive Handling](#archive-handling). |
| **Archive folder path** | Destination folder for archived task notes. |
| **Project archive folder** | Destination folder for archived project notes. |
| **Section archive folder** | Destination folder for archived section notes. |

### Notes Tab

| Setting | Description |
|---|---|
| **Task note template** | Full-file template for new task notes. Supports all [task template variables](#task-template-variables). |
| **Auto-open new note** | Automatically open newly created task notes in the editor. |
| **Create project notes** | Toggle auto-creation of notes for each Todoist project. |
| **Project notes folder** | Folder for project notes. Supports date variables. |
| **Project note template** | Template for project notes. Supports [project template variables](#project-template-variables). |
| **Create section notes** | Toggle auto-creation of section notes (requires project subfolders). |
| **Section notes folder** | Folder for section notes. Supports date variables. |
| **Section note template** | Template for section notes. Supports [section template variables](#section-template-variables). |
| **Area projects** | Comma-separated names of projects that use the area note template instead. |
| **Area project note template** | Template used for designated "area" projects (e.g., "Work", "Personal"). |

### Properties Tab

Every frontmatter property key the plugin writes can be renamed here. This is useful if you use Obsidian Bases or have existing conventions that conflict with the defaults.

Each property shows:
- A text field to set the key name
- A **Reset to defaults** button to restore all names at once

The categories of configurable properties are:
- **Core task properties** — title, status, done, created, modified, tags, links, parent task
- **Todoist sync properties** — all `todoist_*` fields
- **Project & section** — project link, section link
- **Vault identity** — vault ID, pending ID

---

## Project and Section Notes

When **Create project notes** is enabled, the plugin automatically maintains a note for each Todoist project. These notes serve as reference hubs and can be linked from task notes via the `todoist_project_link` frontmatter property.

When **Use project subfolders** and **Create section notes** are both enabled, dedicated notes are also created for each section.

### Area Projects

Some projects in Todoist represent areas of responsibility (e.g., "Work", "Personal", "Health") rather than time-bounded projects. You can list these in the **Area projects** setting; they will use a separate **Area project note template** so you can format them differently from regular project notes.

---

## Archive Handling

When a task is completed or deleted in Todoist, you can choose from four archive modes:

| Mode | Behavior |
|---|---|
| `none` | Leave the note in place; update `todoist_sync_status` to reflect its remote state |
| `move-to-archive-folder` | Move the note to the configured **Archive folder path** |
| `mark-local-done` | Set `task_status` to `Done` in frontmatter; leave the note in place |
| `delete-file` | Move the note to Obsidian's trash (recoverable via **Settings → Files & Links → Deleted files**) |

Project and section notes have their own separate archive folder settings.

When a project or section is **unarchived** in Todoist, the plugin moves the corresponding note back out of the archive folder.

---

## Checklist Conversion

Any unchecked checklist item in any note can be converted into a full task note.

**How to trigger:**
- Click the `↗` button that appears next to the item (requires **Show convert button** enabled in settings)
- Place the cursor on the checklist line and run the **Convert Checklist Item to Task Note** command

**What happens:**
1. A new task note is created in the task folder using your task note template
2. The original checklist line is replaced with a wikilink: `- [ ] [[TaskTitle|TaskTitle]]`
3. If **Todoist Sync** is enabled, the task is queued for creation in Todoist on the next sync

**Inline task directives** in the checklist item text can pre-populate task metadata:
- `@project(ProjectName)` — assign to a project
- `@section(SectionName)` — assign to a section
- `@due(YYYY-MM-DD)` — set a due date
- `@priority(high|medium|low)` — set priority

---

## Linked Checklist Sync

When a checklist item is a wikilink to a task note (format: `- [ ] [[NoteName]]` or `- [x] [[NoteName]]`), the plugin keeps the checkbox in sync with the task note's `task_status`.

- If the linked task note is marked **Done**, the checklist item is automatically checked (`[x]`)
- If the linked task note is re-opened to **Open**, the checklist item is unchecked (`[ ]`)
- Conversely, checking or unchecking the item in the editor updates the linked task note's status

This lets you maintain a high-level overview note with a checklist that stays automatically up-to-date.

---

## Priority Mapping

Todoist uses a reversed numeric priority scale. The plugin maps it to human-readable labels:

| Todoist Priority | Label in Obsidian |
|---|---|
| Priority 4 (Urgent / P1) | `high` |
| Priority 3 (High / P2) | `medium` |
| Priority 2 (Medium / P3) | `low` |
| Priority 1 (Normal / P4) | `none` |

The numeric value is stored in `todoist_priority`; the label is stored in `todoist_priority_label`.

---

## Sync Status Values

The `todoist_sync_status` frontmatter property tracks the lifecycle of each task note:

| Status | Meaning |
|---|---|
| `synced` | Note matches Todoist; no pending changes |
| `dirty_local` | Local edits are pending, will be pushed to Todoist on next sync |
| `queued_local_create` | New local note, not yet created in Todoist |
| `local_only` | Note exists locally but is not connected to Todoist |
| `missing_remote` | Task was deleted from Todoist |
| `completed_remote` | Task was completed in Todoist |
| `archived_remote` | Task was archived in Todoist |

---

## License

This plugin is licensed under the Zero-Clause BSD License. See the `LICENSE` file for details.
