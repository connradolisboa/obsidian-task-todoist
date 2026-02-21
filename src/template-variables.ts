function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * Resolves date-based template variables in a string.
 * Supported tokens:
 *   {{YYYY}}       4-digit year      (e.g. 2026)
 *   {{YY}}         2-digit year      (e.g. 26)
 *   {{MM}}         2-digit month     (e.g. 02)
 *   {{M}}          month, no pad     (e.g. 2)
 *   {{DD}}         2-digit day       (e.g. 07)
 *   {{D}}          day, no pad       (e.g. 7)
 *   {{YYYY-MM}}    year-month        (e.g. 2026-02)
 *   {{YYYY-MM-DD}} full date         (e.g. 2026-02-07)
 */
export function resolveTemplateVars(template: string, date: Date = new Date()): string {
	const yyyy = String(date.getFullYear());
	const yy = yyyy.slice(-2);
	const mm = pad2(date.getMonth() + 1);
	const m = String(date.getMonth() + 1);
	const dd = pad2(date.getDate());
	const d = String(date.getDate());

	return template
		.replace(/\{\{YYYY-MM-DD\}\}/g, `${yyyy}-${mm}-${dd}`)
		.replace(/\{\{YYYY-MM\}\}/g, `${yyyy}-${mm}`)
		.replace(/\{\{YYYY\}\}/g, yyyy)
		.replace(/\{\{YY\}\}/g, yy)
		.replace(/\{\{MM\}\}/g, mm)
		.replace(/\{\{M\}\}/g, m)
		.replace(/\{\{DD\}\}/g, dd)
		.replace(/\{\{D\}\}/g, d);
}
