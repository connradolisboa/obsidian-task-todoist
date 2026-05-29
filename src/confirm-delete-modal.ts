import { App, Modal, Setting } from 'obsidian';

/**
 * Shown the first time a user selects the destructive `delete` mode for deleted
 * Todoist tasks. Requires an explicit "I understand" acknowledgement before the
 * setting is committed, so notes are never silently deleted from the vault.
 */
export class ConfirmDeleteModeModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly onResult: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Enable delete mode?' });
		contentEl.createEl('p', {
			text:
				'With this mode, any task note whose Todoist task is detected as deleted will be ' +
				'permanently removed from your vault — including its body and any personal notes. ' +
				'This cannot be undone from within Obsidian.',
		});
		contentEl.createEl('p', {
			text:
				'A safety cap (Max deletes per sync) limits how many notes a single sync may delete, ' +
				'protecting you from a transient Todoist outage that returns an empty task list.',
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.confirmed = false;
						this.close();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('I understand — enable delete')
					.setWarning()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onResult(this.confirmed);
	}
}
