// Calendar times as the Calendar API treats them. An event boundary is either a
// date (all-day) or a dateTime; a dateTime without a UTC offset is wall-clock
// time in the boundary's timeZone, which must then be given. Stored instants are
// UTC ISO strings, and responses show them in the event's (or calendar's) zone.

const OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

export class CalendarTimeError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// The zone's offset from UTC, in minutes, at an instant.
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000);
}

/**
 * The UTC instant of a boundary's dateTime, as an ISO string. A dateTime with an
 * offset stands on its own; one without needs the boundary's time zone.
 */
export function resolveDateTime(dateTime: string, timeZone: string | null, boundary: "start" | "end"): string {
  if (OFFSET_PATTERN.test(dateTime)) {
    const instant = Date.parse(dateTime);
    if (Number.isNaN(instant)) throw new CalendarTimeError(`Invalid ${boundary} time.`, "invalid");
    return new Date(instant).toISOString();
  }

  const match = LOCAL_PATTERN.exec(dateTime);
  if (!match) throw new CalendarTimeError(`Invalid ${boundary} time.`, "invalid");
  if (!timeZone) throw new CalendarTimeError(`Missing time zone definition for ${boundary} time.`, "missingTimeZone");
  if (!isValidTimeZone(timeZone)) {
    throw new CalendarTimeError(`Invalid time zone definition for ${boundary} time.`, "timeZoneInvalid");
  }

  const [, year, month, day, hour, minute, second = "0", millis = "0"] = match;
  const wall = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, +millis.padEnd(3, "0"));
  // The offset at the wall time read as UTC is right except near a transition;
  // a second pass with the offset at the first guess settles it.
  let instant = wall - offsetMinutes(wall, timeZone) * 60000;
  instant = wall - offsetMinutes(instant, timeZone) * 60000;
  return new Date(instant).toISOString();
}

/** An instant shown in a zone, as the Calendar API writes it: 2026-10-28T10:00:00-04:00. */
export function formatInTimeZone(isoInstant: string, timeZone: string): string {
  const instant = Date.parse(isoInstant);
  if (Number.isNaN(instant)) return isoInstant;
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const offset = offsetMinutes(instant, zone);
  const local = new Date(Math.floor(instant / 1000) * 1000 + offset * 60000).toISOString().slice(0, 19);
  if (offset === 0) return `${local}Z`;
  const sign = offset > 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
