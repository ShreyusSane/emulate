import type { Context } from "@emulators/core";
import type { GoogleCalendarEventInput } from "./calendar-helpers.js";
import type { GoogleDriveItemInput } from "./drive-helpers.js";
import type { GoogleMessageInput } from "./helpers.js";
import { getAuthenticatedEmail, googleApiError, matchesRequestedUser } from "./helpers.js";

export function requireGoogleAuth(c: Context): string | Response {
  const authEmail = getAuthenticatedEmail(c);
  if (!authEmail) {
    return googleApiError(c, 401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
  }

  return authEmail;
}

export function requireGmailUser(c: Context): string | Response {
  const authEmail = requireGoogleAuth(c);
  if (authEmail instanceof Response) {
    return authEmail;
  }

  if (!matchesRequestedUser(c.req.param("userId") ?? "", authEmail)) {
    return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
  }

  return authEmail;
}

export async function parseGoogleBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (!rawText) return {};

  let parsed: Record<string, unknown>;

  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(rawText);
      parsed = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    parsed = Object.fromEntries(new URLSearchParams(rawText));
  } else {
    parsed = {
      raw: Buffer.from(rawText, "utf8").toString("base64url"),
    };
  }

  const nestedBody = parsed.requestBody;
  if (nestedBody && typeof nestedBody === "object" && !Array.isArray(nestedBody)) {
    return nestedBody as Record<string, unknown>;
  }

  return parsed;
}

export function getStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  return [];
}

export function getString(body: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "string") return value;
  }

  return undefined;
}

export function getRecord(body: Record<string, unknown>, ...fields: string[]): Record<string, unknown> | undefined {
  for (const field of fields) {
    const value = body[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }

  return undefined;
}

export function getRecordArray(body: Record<string, unknown>, ...fields: string[]): Record<string, unknown>[] {
  for (const field of fields) {
    const value = body[field];
    if (!Array.isArray(value)) continue;

    return value.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
  }

  return [];
}

export function parseMessageInputFromBody(
  body: Record<string, unknown>,
  defaults?: { from?: string },
): Omit<GoogleMessageInput, "user_email"> {
  return {
    raw: getString(body, "raw"),
    thread_id: getString(body, "threadId", "thread_id"),
    from: getString(body, "from") ?? defaults?.from,
    to: getString(body, "to"),
    cc: getString(body, "cc") ?? null,
    bcc: getString(body, "bcc") ?? null,
    reply_to: getString(body, "replyTo", "reply_to") ?? null,
    subject: getString(body, "subject"),
    snippet: getString(body, "snippet"),
    body_text: getString(body, "body_text", "text") ?? null,
    body_html: getString(body, "body_html", "html") ?? null,
    date: getString(body, "date"),
    internal_date: getString(body, "internalDate", "internal_date"),
    message_id: getString(body, "messageId", "message_id"),
    references: getString(body, "references") ?? null,
    in_reply_to: getString(body, "inReplyTo", "in_reply_to") ?? null,
  };
}

export function parseCalendarEventInputFromBody(
  body: Record<string, unknown>,
): Omit<GoogleCalendarEventInput, "user_email" | "calendar_google_id"> {
  const start = getRecord(body, "start");
  const end = getRecord(body, "end");
  const conferenceData = getRecord(body, "conferenceData");
  const conferenceEntryPoints = getRecordArray(conferenceData ?? {}, "entryPoints")
    .map((entry) => ({
      entry_point_type: getString(entry, "entryPointType") ?? "video",
      uri: getString(entry, "uri") ?? "",
      label: getString(entry, "label") ?? null,
    }))
    .filter((entry) => entry.uri.length > 0);

  return {
    status: getString(body, "status") ?? "confirmed",
    summary: getString(body, "summary"),
    description: getString(body, "description") ?? null,
    location: getString(body, "location") ?? null,
    start_date_time: getString(start ?? {}, "dateTime") ?? null,
    start_date: getString(start ?? {}, "date") ?? null,
    end_date_time: getString(end ?? {}, "dateTime") ?? null,
    end_date: getString(end ?? {}, "date") ?? null,
    attendees: getRecordArray(body, "attendees")
      .map((entry) => ({
        email: getString(entry, "email") ?? "",
        display_name: getString(entry, "displayName") ?? null,
        response_status: getString(entry, "responseStatus") ?? null,
        organizer: entry.organizer === true,
        self: entry.self === true,
      }))
      .filter((attendee) => attendee.email.length > 0),
    conference_entry_points: conferenceEntryPoints,
    hangout_link:
      getString(body, "hangoutLink") ??
      conferenceEntryPoints.find((entry) => entry.entry_point_type === "video")?.uri ??
      null,
    transparency: getString(body, "transparency") ?? null,
    start_time_zone: getString(start ?? {}, "timeZone") ?? null,
    end_time_zone: getString(end ?? {}, "timeZone") ?? null,
    event_type: getString(body, "eventType") ?? "default",
    properties: pickCalendarEventProperties(body),
  };
}

// Event fields the emulator keeps as sent and returns unchanged.
export const CALENDAR_EVENT_PROPERTY_FIELDS = [
  "colorId",
  "visibility",
  "reminders",
  "guestsCanModify",
  "guestsCanInviteOthers",
  "guestsCanSeeOtherGuests",
  "anyoneCanAddSelf",
  "extendedProperties",
  "source",
  "outOfOfficeProperties",
  "focusTimeProperties",
  "workingLocationProperties",
] as const;

function pickCalendarEventProperties(body: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of CALENDAR_EVENT_PROPERTY_FIELDS) {
    if (body[field] !== undefined) properties[field] = body[field];
  }
  return properties;
}

/**
 * The parsed fields of an event body that the body names, for events.patch:
 * fields it leaves out stay as they are. start and end are replaced whole,
 * as are attendees, and each named property replaces the stored one.
 */
export function parseCalendarEventPatchFromBody(
  body: Record<string, unknown>,
): Partial<Omit<GoogleCalendarEventInput, "user_email" | "calendar_google_id">> {
  const full = parseCalendarEventInputFromBody(body);
  const patch: Partial<Omit<GoogleCalendarEventInput, "user_email" | "calendar_google_id">> = {};
  const has = (key: string) => body[key] !== undefined;
  if (has("summary")) patch.summary = full.summary;
  if (has("description")) patch.description = full.description;
  if (has("location")) patch.location = full.location;
  if (has("status")) patch.status = full.status;
  if (has("transparency")) patch.transparency = full.transparency;
  if (has("eventType")) patch.event_type = full.event_type;
  if (has("attendees")) patch.attendees = full.attendees;
  if (has("conferenceData")) {
    patch.conference_entry_points = full.conference_entry_points;
    patch.hangout_link = full.hangout_link;
  }
  if (has("start")) {
    patch.start_date_time = full.start_date_time;
    patch.start_date = full.start_date;
    patch.start_time_zone = full.start_time_zone;
  }
  if (has("end")) {
    patch.end_date_time = full.end_date_time;
    patch.end_date = full.end_date;
    patch.end_time_zone = full.end_time_zone;
  }
  if (Object.keys(full.properties ?? {}).length > 0) patch.properties = full.properties;
  return patch;
}

export function parseDriveItemInputFromBody(
  body: Record<string, unknown>,
  defaults?: { mimeType?: string },
): Omit<GoogleDriveItemInput, "user_email" | "size" | "data"> {
  const parentIds = getStringArray(body, "parents");

  return {
    name: getString(body, "name")?.trim() || "Untitled",
    mime_type: getString(body, "mimeType") ?? defaults?.mimeType ?? "application/octet-stream",
    parent_google_ids: parentIds.length > 0 ? parentIds : ["root"],
  };
}
