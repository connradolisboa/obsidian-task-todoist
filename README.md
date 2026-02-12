# Task Todoist Sync for Obsidian

Sync Todoist tasks with task notes in Obsidian, with two-way status updates and Bases-friendly frontmatter.

## What it does

- Imports Todoist tasks into a dedicated tasks folder as Markdown notes.
- Pushes local task note updates back to Todoist.
- Supports inline checklist conversion to task notes.
- Keeps linked checklist checkboxes in sync with task note status.
- Supports due dates and recurring rules.
- Stores Todoist API token in Obsidian secret storage.

## Frontmatter model

Task notes use these core fields:

- `task_title`
- `task_status` (`open` | `done`)
- `task_done` (boolean, useful for editable Bases checkbox column)
- `todoist_sync` (boolean)
- `todoist_sync_status`
- `todoist_id`
- `todoist_project_name`
- `todoist_section_name`
- `todoist_due` (date value)
- `todoist_due_string` (natural-language due rule, including recurrence)
- `todoist_is_recurring` (boolean)
- `parent_task` (optional wiki-link to parent task)

## First run (recommended order)

1. Build and install plugin files into your vault plugin folder.
2. Open **Settings -> Community plugins -> Task Todoist Sync**.
3. Set **Token secret name** (default: `todoist-api`).
4. Set your Todoist API token in **Todoist API token**.
5. Use **Test connection** and confirm success.
6. Configure:
- Tasks folder path
- Archive behavior
- Import scope/rules
- Auto-sync interval (optional)
7. Run **Sync todoist now** once.

## Creating tasks

### Create task modal

Use the command **Create task note** and fill:

- Title
- Description
- Optional project and section
- Optional due date
- Optional recurrence (example: `every weekday`)
- Sync toggle

### Inline conversion

You can write a normal unchecked checklist item and convert it to a task note.

Supported inline directives:

- `proj::Work` or `project::Work`
- `sec::Urgent` or `section::Urgent`
- `due::2026-02-12` or `due::today`
- `recur::"every weekday"` or `recurrence::"every weekday"`

Example:

```md
- [ ] Review draft proj::Personal due::tomorrow
- [ ] Daily standup recur::"every weekday"
```

## Sync behavior notes

- Local edits in task notes are marked `todoist_sync_status: dirty_local` and pushed on next sync.
- Editing `task_done` in Bases is supported and syncs to Todoist.
- Clearing `todoist_due` locally is synced (remote due is cleared).
- Recurring tasks are represented by `todoist_is_recurring` and `todoist_due_string`.

## Bases

A sample `Tasks.base` is included in repo root and uses:

- `task_title`
- `task_done`
- `task_status`
- `todoist_due`
- `todoist_project_name`
- `todoist_sync_status`

## Development

Install dependencies:

```bash
npm install
```

Watch mode:

```bash
npm run dev
```

Typecheck + production build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Package release artifacts into `release/`:

```bash
npm run package
```

## Manual install in a vault

Copy these files into:

`<Vault>/.obsidian/plugins/obsidian-task-todoist/`

- `main.js`
- `manifest.json`
- `styles.css`

For convenience you can copy from `release/` after `npm run package`.
