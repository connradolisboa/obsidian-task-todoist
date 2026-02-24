/**
 * Converts a Todoist natural-language due.string and the current due date into
 * the iCal RRULE-like format expected by the TaskNotes Obsidian plugin:
 *   DTSTART:YYYYMMDD;FREQ=DAILY;INTERVAL=1
 *
 * Returns null for patterns that cannot be parsed (property should be omitted).
 */

const DAY_ABBREVIATIONS: Record<string, string> = {
	monday: 'MO',
	tuesday: 'TU',
	wednesday: 'WE',
	thursday: 'TH',
	friday: 'FR',
	saturday: 'SA',
	sunday: 'SU',
};

/**
 * Converts a Todoist `due.date` (YYYY-MM-DD) to the DTSTART token (YYYYMMDD).
 */
function dtstart(dueDate: string): string {
	return dueDate.replace(/-/g, '');
}

/**
 * Parse a Todoist due.string like "every day", "every 2 weeks", "every monday"
 * into an iCal RRULE partial string like "FREQ=DAILY;INTERVAL=1".
 * Returns null if the pattern is not recognised.
 */
function parseDueStringToRRule(s: string): string | null {
	// Normalise: lowercase, collapse whitespace, strip trailing punctuation
	const norm = s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,;]+$/, '');

	// "every day"
	if (norm === 'every day') return 'FREQ=DAILY;INTERVAL=1';

	// "every weekday"
	if (norm === 'every weekday') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';

	// "every week"
	if (norm === 'every week') return 'FREQ=WEEKLY;INTERVAL=1';

	// "every month"
	if (norm === 'every month') return 'FREQ=MONTHLY;INTERVAL=1';

	// "every year"
	if (norm === 'every year') return 'FREQ=YEARLY;INTERVAL=1';

	// "every N days"
	let m = norm.match(/^every (\d+) days?$/);
	if (m) return `FREQ=DAILY;INTERVAL=${m[1]}`;

	// "every N weeks"
	m = norm.match(/^every (\d+) weeks?$/);
	if (m) return `FREQ=WEEKLY;INTERVAL=${m[1]}`;

	// "every N months"
	m = norm.match(/^every (\d+) months?$/);
	if (m) return `FREQ=MONTHLY;INTERVAL=${m[1]}`;

	// "every N years"
	m = norm.match(/^every (\d+) years?$/);
	if (m) return `FREQ=YEARLY;INTERVAL=${m[1]}`;

	// "every Nth" — e.g. "every 15th", "every 1st", "every 22nd"
	m = norm.match(/^every (\d+)(?:st|nd|rd|th)$/);
	if (m) return `FREQ=MONTHLY;BYMONTHDAY=${m[1]}`;

	// "every monday" (single weekday)
	m = norm.match(/^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
	if (m) {
		const dayName = m[1] ?? '';
		const byday = DAY_ABBREVIATIONS[dayName];
		return `FREQ=WEEKLY;BYDAY=${byday}`;
	}

	// "every monday, wednesday" or "every monday and wednesday" (multiple weekdays)
	// Accepts comma-separated or "and"-separated lists of weekday names
	const weekdayListPattern = /^every ((?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*,\s*|\s+and\s+))*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))$/;
	m = norm.match(weekdayListPattern);
	if (m) {
		const captured = m[1] ?? '';
		const dayNames = captured.split(/\s*,\s*|\s+and\s+/).map((d) => d.trim());
		const bydays = dayNames.map((d) => DAY_ABBREVIATIONS[d]).filter(Boolean);
		if (bydays.length === dayNames.length) {
			return `FREQ=WEEKLY;BYDAY=${bydays.join(',')}`;
		}
	}

	return null;
}

/**
 * Build the full recurrence string for TaskNotes frontmatter.
 *
 * @param dueString - Todoist `due.string` natural language value (e.g. "every day")
 * @param dueDate   - Todoist `due.date` in YYYY-MM-DD format (used as DTSTART)
 * @returns Full recurrence string or null if the pattern is not supported
 */
export function buildRecurrenceString(dueString: string, dueDate: string): string | null {
	if (!dueString || !dueDate) return null;
	const rrule = parseDueStringToRRule(dueString);
	if (!rrule) return null;
	return `DTSTART:${dtstart(dueDate)};${rrule}`;
}
