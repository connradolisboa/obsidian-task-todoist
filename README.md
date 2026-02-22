# Obsidian Task Todoist

This is a plugin for [Obsidian](https://obsidian.md/) that provides two-way synchronization between Obsidian task notes and [Todoist](https://todoist.com/).

It allows you to manage your Todoist tasks as notes in your Obsidian vault, leveraging the power of both platforms.

## Features

*   **Two-way Sync:** Keep your tasks updated in both Obsidian and Todoist.
*   **Flexible Task Import:** Use filters to import tasks from specific projects, with certain labels, or assigned to you.
*   **Customizable Task Notes:** Use templates to define the structure of your task notes, including frontmatter and content.
*   **Offline Support:** Create and update tasks in Obsidian while offline, and sync them with Todoist when you're back online.
*   **Convert Checklist Items:** Quickly convert checklist items from any note into a synced task note.
*   **Project and Section Notes:** Automatically create notes for your Todoist projects and sections.
*   **Highly Customizable:** A comprehensive settings panel allows you to tailor the plugin to your workflow.

## Getting Started

1.  **Install the Plugin:** This plugin is not yet in the community plugins browser. To install it, you need to manually add it to your vault's `.obsidian/plugins` directory.
2.  **Get Your Todoist API Token:**
    *   Go to your Todoist account's [Integrations](https://todoist.com/app/settings/integrations) page.
    *   In the "API token" section, you'll find your personal API token. Copy it.
3.  **Configure the Plugin:**
    *   Open Obsidian's settings and go to the "Task Todoist" tab.
    *   Paste your API token into the "Todoist API token" field.
    *   Click "Test connection" to ensure the token is correct.
    *   Configure the rest of the settings to your liking. Pay special attention to the "Task folder path" to define where your task notes will be stored.

## How to Use

### Syncing Tasks

You can sync your tasks in several ways:

*   **Manual Sync:** Run the "Sync todoist now" command from the command palette or click the "Sync now" button in the settings.
*   **Scheduled Sync:** Enable "Enable scheduled sync" in the settings to have the plugin sync automatically in the background.

### Creating Tasks

#### From Obsidian

*   **Create a Task Note:** Use the "Create task note" command to open a modal where you can define the task's title, description, and other properties. If you have "Todoist Sync" enabled in the modal, the task will be created in Todoist on the next sync.
*   **Convert a Checklist Item:** In any note, if you have an unchecked checklist item (`- [ ] Your task`), you can click the `↗` button that appears next to it (if enabled in settings) or use the "Convert checklist item to task note" command to turn it into a synced task note.

#### From Todoist

Create a task in Todoist as you normally would. If it matches the import rules you've configured in the plugin's settings, it will be imported as a new task note on the next sync.

### Task Notes

Each task is a separate note in your vault. The note's frontmatter contains all the metadata related to the task, such as the due date, priority, and Todoist-specific information. The body of the note is for your personal notes and is not synced to Todoist's description.

### Settings Overview

The plugin offers a wide range of settings to customize your experience:

*   **General:** Configure your Todoist API token, the folder for your task notes, and other basic settings.
*   **Import:** Define the rules for which tasks to import from Todoist. You can filter by project, label, and assignee.
*   **Sync:** Control sync-related settings, such as the automatic sync interval, conflict resolution, and how to handle archived tasks.
*   **Notes:** Customize the templates for your task notes, project notes, and section notes.
*   **Properties:** Change the names of the frontmatter properties used in your task notes.

## Architecture

The plugin is built with a clear separation of concerns, making it robust and maintainable.

*   `main.ts`: The main plugin entry point, responsible for initialization, command registration, and orchestrating the sync process.
*   `todoist-client.ts`: A dedicated client for all communication with the Todoist Sync API.
*   `sync-service.ts`: The core of the plugin, containing the logic for the two-way sync.
*   `task-note-repository.ts`: An abstraction layer for interacting with the task notes in the Obsidian vault.
*   `settings-tab.ts`: The UI for the plugin's settings panel.

This architecture ensures that the different parts of the plugin are decoupled and can be developed and tested independently.

## Contributing

This project is open to contributions. If you find a bug or have a feature request, please open an issue on the GitHub repository.

## License

This plugin is licensed under the MIT License. See the `LICENSE` file for more details.
