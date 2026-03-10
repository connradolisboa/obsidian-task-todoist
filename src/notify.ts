import { Notice } from 'obsidian';
import type { TaskTodoistSettings } from './settings';

export function notify(settings: TaskTodoistSettings, message: string, timeout?: number): void {
	if (settings.disableNotifications) return;
	new Notice(message, timeout);
}
