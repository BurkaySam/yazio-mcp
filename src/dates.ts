// YAZIO stores timestamps as local user time without a zone
// ("YYYY-MM-DD HH:MM:SS") and expects plain "YYYY-MM-DD" date parameters.
// Workers run in UTC, so "today" and "now" are computed in a configured zone.

export const DEFAULT_TIMEZONE = "Europe/Berlin";

const DAYTIME_DEFAULT_TIMES: Record<string, string> = {
	breakfast: "08:00:00",
	lunch: "12:30:00",
	dinner: "19:00:00",
	snack: "15:30:00",
};

function localParts(now: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "00";
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		time: `${get("hour")}:${get("minute")}:${get("second")}`,
	};
}

export function today(timeZone: string, now = new Date()): string {
	return localParts(now, timeZone).date;
}

/**
 * Builds the API timestamp for a new entry: today uses the current local
 * time, other days use the meal's typical time.
 */
export function toApiDateTime(
	date: string,
	daytime: string,
	timeZone: string,
	now = new Date(),
): string {
	const local = localParts(now, timeZone);
	if (date === local.date) return `${date} ${local.time}`;
	return `${date} ${DAYTIME_DEFAULT_TIMES[daytime] ?? "12:00:00"}`;
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}
