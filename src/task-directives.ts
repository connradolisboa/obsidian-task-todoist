export interface ParsedTaskDirectives {
	title: string;
	projectName?: string;
	sectionName?: string;
	dueRaw?: string;
	recurrenceRaw?: string;
}

const DIRECTIVE_REGEX = /\b(proj|project|sec|section|due|recur|recurrence)::(?:"([^"]+)"|(\S+))/gi;

export function parseInlineTaskDirectives(rawTaskText: string): ParsedTaskDirectives {
	let projectName: string | undefined;
	let sectionName: string | undefined;
	let dueRaw: string | undefined;
	let recurrenceRaw: string | undefined;

	let cleaned = rawTaskText;
	let match: RegExpExecArray | null;
	while ((match = DIRECTIVE_REGEX.exec(rawTaskText)) !== null) {
		const directive = (match[1] ?? '').toLowerCase();
		const value = (match[2] ?? match[3] ?? '').trim();
		if (!value) {
			continue;
		}

		if (directive === 'proj' || directive === 'project') {
			projectName = value;
		} else if (directive === 'sec' || directive === 'section') {
			sectionName = value;
		} else if (directive === 'due') {
			dueRaw = normalizeCommonDueRaw(value);
		} else if (directive === 'recur' || directive === 'recurrence') {
			recurrenceRaw = value;
			if (!dueRaw) {
				dueRaw = inferDueDateForRecurrenceRule(value);
			}
		}
		cleaned = cleaned.replace(match[0], ' ');
	}

	const title = cleaned.replace(/\s+/g, ' ').trim();
	if (!dueRaw && !recurrenceRaw) {
		const natural = detectNaturalDueSuffix(title);
		if (natural.matched) {
			return {
				title: natural.title,
				projectName,
				sectionName,
				dueRaw: natural.dueRaw,
				recurrenceRaw: natural.recurrenceRaw,
			};
		}
	}

	return {
		title,
		projectName,
		sectionName,
		dueRaw,
		recurrenceRaw,
	};
}

export function detectNaturalDueSuffix(rawTitle: string): {
	title: string;
	dueRaw?: string;
	recurrenceRaw?: string;
	matched: boolean;
} {
	const normalized = rawTitle.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return { title: '', matched: false };
	}
	const now = new Date();

	const recurrenceMatch = normalized.match(/^(.*\S)\s+(every\s+.+)$/i);
	if (recurrenceMatch) {
		const title = (recurrenceMatch[1] ?? '').trim();
		const recurrenceRaw = (recurrenceMatch[2] ?? '').trim().toLowerCase();
		const dueRaw = inferDueDateForRecurrenceRule(recurrenceRaw, now);
		if (title && recurrenceRaw) {
			return {
				title,
				dueRaw,
				recurrenceRaw,
				matched: true,
			};
		}
	}

	const inDaysMatch = normalized.match(/^(.*\S)\s+in\s+(\d{1,3})\s+days?\.?$/i);
	if (inDaysMatch) {
		const title = (inDaysMatch[1] ?? '').trim();
		const days = Number((inDaysMatch[2] ?? '').trim());
		if (title && Number.isFinite(days) && days > 0) {
			return {
				title,
				dueRaw: addDaysAsIso(now, days),
				matched: true,
			};
		}
	}

	const inWeeksMatch = normalized.match(/^(.*\S)\s+in\s+(\d{1,3})\s+weeks?\.?$/i);
	if (inWeeksMatch) {
		const title = (inWeeksMatch[1] ?? '').trim();
		const weeks = Number((inWeeksMatch[2] ?? '').trim());
		if (title && Number.isFinite(weeks) && weeks > 0) {
			return {
				title,
				dueRaw: addDaysAsIso(now, weeks * 7),
				matched: true,
			};
		}
	}

	const thisNextWeekdayMatch = normalized.match(
		/^(.*\S)\s+(this|next)\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?$/i,
	);
	if (thisNextWeekdayMatch) {
		const title = (thisNextWeekdayMatch[1] ?? '').trim();
		const kind = ((thisNextWeekdayMatch[2] ?? '').trim().toLowerCase()) as 'this' | 'next';
		const weekdayToken = (thisNextWeekdayMatch[3] ?? '').trim().toLowerCase();
		const weekday = toWeekdayIndex(weekdayToken);
		if (title && weekday !== null) {
			return {
				title,
				dueRaw: resolveThisNextWeekdayAsIso(now, kind, weekday),
				matched: true,
			};
		}
	}

	const bareWeekdayMatch = normalized.match(
		/^(.*\S)\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?$/i,
	);
	if (bareWeekdayMatch) {
		const title = (bareWeekdayMatch[1] ?? '').trim();
		const weekdayToken = (bareWeekdayMatch[2] ?? '').trim().toLowerCase();
		const weekday = toWeekdayIndex(weekdayToken);
		if (title && weekday !== null) {
			return {
				title,
				dueRaw: resolveThisNextWeekdayAsIso(now, 'this', weekday),
				matched: true,
			};
		}
	}

	const dueMatch = normalized.match(
		/^(.*\S)\s+((?:today|tomorrow|tonight|next\s+(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)))$/i,
	);
	if (dueMatch) {
		const title = (dueMatch[1] ?? '').trim();
		const dueRaw = normalizeCommonDueRaw((dueMatch[2] ?? '').trim().toLowerCase(), now);
		if (title && dueRaw) {
			return {
				title,
				dueRaw,
				matched: true,
			};
		}
	}

	const monthRegex = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

	const dayMonthMatch = normalized.match(new RegExp(`^(.*\\S)\\s+(\\d{1,2})\\s+(${monthRegex})\\.?$`, 'i'));
	if (dayMonthMatch) {
		const title = (dayMonthMatch[1] ?? '').trim();
		const day = Number((dayMonthMatch[2] ?? '').trim());
		const monthToken = (dayMonthMatch[3] ?? '').trim().toLowerCase();
		const month = toMonthIndex(monthToken);
		const iso = month === null ? null : resolveMonthDayAsIso(now, month, day);
		if (title && iso) {
			return {
				title,
				dueRaw: iso,
				matched: true,
			};
		}
	}

	const monthDayMatch = normalized.match(
		new RegExp(`^(.*\\S)\\s+(${monthRegex})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\.?$`, 'i'),
	);
	if (monthDayMatch) {
		const title = (monthDayMatch[1] ?? '').trim();
		const monthToken = (monthDayMatch[2] ?? '').trim().toLowerCase();
		const day = Number((monthDayMatch[3] ?? '').trim());
		const month = toMonthIndex(monthToken);
		const iso = month === null ? null : resolveMonthDayAsIso(now, month, day);
		if (title && iso) {
			return {
				title,
				dueRaw: iso,
				matched: true,
			};
		}
	}

	return { title: normalized, matched: false };
}

export function inferDueDateForRecurrenceRule(recurrenceRaw: string, from = new Date()): string | undefined {
	const normalized = recurrenceRaw.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	const everyPrefixMatch = normalized.match(/^every\s+(.+)$/i);
	const body = (everyPrefixMatch?.[1] ?? normalized).trim();

	const weekday = toWeekdayIndex(body);
	if (weekday !== null) {
		return resolveThisNextWeekdayAsIso(from, 'this', weekday);
	}

	const monthRegex = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
	const dayMonthMatch = body.match(new RegExp(`^(\\d{1,2})\\s+(${monthRegex})$`, 'i'));
	if (dayMonthMatch) {
		const day = Number((dayMonthMatch[1] ?? '').trim());
		const monthToken = (dayMonthMatch[2] ?? '').trim().toLowerCase();
		const month = toMonthIndex(monthToken);
		return month === null ? undefined : (resolveMonthDayAsIso(from, month, day) ?? undefined);
	}

	const monthDayMatch = body.match(new RegExp(`^(${monthRegex})\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, 'i'));
	if (monthDayMatch) {
		const monthToken = (monthDayMatch[1] ?? '').trim().toLowerCase();
		const day = Number((monthDayMatch[2] ?? '').trim());
		const month = toMonthIndex(monthToken);
		return month === null ? undefined : (resolveMonthDayAsIso(from, month, day) ?? undefined);
	}

	return undefined;
}

function normalizeCommonDueRaw(raw: string, from = new Date()): string {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) {
		return '';
	}
	if (normalized === 'today') {
		return toIsoDate(new Date(from.getFullYear(), from.getMonth(), from.getDate()));
	}
	if (normalized === 'tomorrow' || normalized === 'tonight') {
		return addDaysAsIso(from, 1);
	}
	return normalized;
}

function addDaysAsIso(from: Date, days: number): string {
	const next = new Date(from.getFullYear(), from.getMonth(), from.getDate());
	next.setDate(next.getDate() + days);
	return toIsoDate(next);
}

function toWeekdayIndex(token: string): number | null {
	const normalized = token.toLowerCase();
	if (normalized.startsWith('sun')) return 0;
	if (normalized.startsWith('mon')) return 1;
	if (normalized.startsWith('tue')) return 2;
	if (normalized.startsWith('wed')) return 3;
	if (normalized.startsWith('thu')) return 4;
	if (normalized.startsWith('fri')) return 5;
	if (normalized.startsWith('sat')) return 6;
	return null;
}

function resolveThisNextWeekdayAsIso(from: Date, kind: 'this' | 'next', weekday: number): string {
	const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
	const currentWeekday = today.getDay();
	const baseDiff = (weekday - currentWeekday + 7) % 7;
	const daysToAdd = kind === 'next' ? baseDiff + 7 : baseDiff;
	today.setDate(today.getDate() + daysToAdd);
	return toIsoDate(today);
}

function toMonthIndex(token: string): number | null {
	const m = token.toLowerCase();
	if (m.startsWith('jan')) return 0;
	if (m.startsWith('feb')) return 1;
	if (m.startsWith('mar')) return 2;
	if (m.startsWith('apr')) return 3;
	if (m === 'may') return 4;
	if (m.startsWith('jun')) return 5;
	if (m.startsWith('jul')) return 6;
	if (m.startsWith('aug')) return 7;
	if (m.startsWith('sep')) return 8;
	if (m.startsWith('oct')) return 9;
	if (m.startsWith('nov')) return 10;
	if (m.startsWith('dec')) return 11;
	return null;
}

function resolveMonthDayAsIso(from: Date, month: number, day: number): string | null {
	if (day < 1 || day > 31) {
		return null;
	}
	const currentYear = from.getFullYear();
	const today = new Date(currentYear, from.getMonth(), from.getDate());
	const candidateThisYear = new Date(currentYear, month, day);
	if (candidateThisYear.getMonth() !== month || candidateThisYear.getDate() !== day) {
		return null;
	}
	if (candidateThisYear >= today) {
		return toIsoDate(candidateThisYear);
	}
	const candidateNextYear = new Date(currentYear + 1, month, day);
	if (candidateNextYear.getMonth() !== month || candidateNextYear.getDate() !== day) {
		return null;
	}
	return toIsoDate(candidateNextYear);
}

function toIsoDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

export function formatDueForDisplay(dueRaw: string): string {
	const trimmed = dueRaw.trim();
	if (!trimmed) {
		return '';
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		const parsed = new Date(`${trimmed}T00:00:00`);
		if (!Number.isNaN(parsed.getTime())) {
			const relative = relativeDayLabel(parsed, new Date());
			if (relative) {
				return relative;
			}
			return new Intl.DateTimeFormat(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
			}).format(parsed);
		}
	}

	return trimmed;
}

function relativeDayLabel(target: Date, now: Date): string | null {
	const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
	const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const diffMs = targetMidnight.getTime() - nowMidnight.getTime();
	const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
	if (diffDays === 0) {
		return 'today';
	}
	if (diffDays === 1) {
		return 'tomorrow';
	}
	if (diffDays === -1) {
		return 'yesterday';
	}
	return null;
}
