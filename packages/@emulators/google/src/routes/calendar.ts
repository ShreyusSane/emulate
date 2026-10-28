import type { Context, RouteContext } from "@emulators/core";
import { buildCalendarDiscoveryDocument } from "../calendar-discovery.js";
import {
  buildFreeBusyResponse,
  createCalendarEventRecord,
  createCalendarRecord,
  deleteCalendarEventRecord,
  formatCalendarEventResource,
  formatCalendarResource,
  getCalendarById,
  getCalendarEventById,
  listCalendarEvents,
  listCalendarsForUser,
  updateCalendarEventRecord,
  type GoogleCalendarEventInput,
} from "../calendar-helpers.js";
import { CalendarTimeError, isValidTimeZone, resolveDateTime } from "../calendar-time.js";
import type { GoogleCalendar, GoogleCalendarEvent } from "../entities.js";
import { googleApiError } from "../helpers.js";
import {
  getRecord,
  getRecordArray,
  getString,
  parseCalendarEventInputFromBody,
  parseCalendarEventPatchFromBody,
  parseGoogleBody,
  requireGoogleAuth,
  requireGmailUser,
} from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

type EventFields = Omit<GoogleCalendarEventInput, "user_email" | "calendar_google_id">;

const EVENT_TYPES = new Set(["default", "outOfOffice", "focusTime", "workingLocation"]);

/**
 * Checks an event's times the way the Calendar API does and returns them as UTC
 * instants: a dateTime without an offset needs its boundary's timeZone, and the
 * event must end after it starts. Returns an error response instead when not.
 */
function resolveEventTimes(c: Context, fields: EventFields): EventFields | Response {
  const resolved = { ...fields };
  try {
    for (const boundary of ["start", "end"] as const) {
      const dateTime = resolved[`${boundary}_date_time`];
      const date = resolved[`${boundary}_date`];
      const zone = resolved[`${boundary}_time_zone`] ?? null;
      if (!dateTime && !date) {
        return googleApiError(c, 400, `Missing ${boundary} time.`, "required", "INVALID_ARGUMENT");
      }
      if (zone && !isValidTimeZone(zone)) {
        throw new CalendarTimeError(`Invalid time zone definition for ${boundary} time.`, "timeZoneInvalid");
      }
      if (dateTime) resolved[`${boundary}_date_time`] = resolveDateTime(dateTime, zone, boundary);
    }
  } catch (error) {
    if (error instanceof CalendarTimeError)
      return googleApiError(c, 400, error.message, error.reason, "INVALID_ARGUMENT");
    throw error;
  }

  const start = resolved.start_date_time ?? resolved.start_date ?? "";
  const end = resolved.end_date_time ?? resolved.end_date ?? "";
  if (Boolean(resolved.start_date_time) !== Boolean(resolved.end_date_time)) {
    return googleApiError(
      c,
      400,
      "Start and end times must either both be date or both be dateTime.",
      "invalid",
      "INVALID_ARGUMENT",
    );
  }
  if (Date.parse(end) <= Date.parse(start)) {
    return googleApiError(c, 400, "The specified time range is empty.", "timeRangeEmpty", "INVALID_ARGUMENT");
  }
  if (resolved.event_type && !EVENT_TYPES.has(resolved.event_type)) {
    return googleApiError(c, 400, `Invalid event type: ${resolved.event_type}.`, "invalid", "INVALID_ARGUMENT");
  }
  return resolved;
}

// Recurring events are not modelled; say so rather than store a rule the
// emulator would then ignore.
function rejectRecurrence(c: Context, body: Record<string, unknown>): Response | undefined {
  const recurrence = body.recurrence;
  if (Array.isArray(recurrence) && recurrence.length > 0) {
    return googleApiError(
      c,
      400,
      "Recurring events are not supported by this emulator.",
      "emulatorUnsupported",
      "INVALID_ARGUMENT",
    );
  }
  return undefined;
}

// The stored form of an event's fields, to merge a patch into.
function eventFields(event: GoogleCalendarEvent): EventFields {
  return {
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start_date_time: event.start_date_time,
    start_date: event.start_date,
    end_date_time: event.end_date_time,
    end_date: event.end_date,
    attendees: event.attendees,
    conference_entry_points: event.conference_entry_points,
    hangout_link: event.hangout_link,
    transparency: event.transparency,
    start_time_zone: event.start_time_zone,
    end_time_zone: event.end_time_zone,
    event_type: event.event_type,
    properties: event.properties,
  };
}

function formatCalendar(calendar: GoogleCalendar) {
  return {
    kind: "calendar#calendar",
    etag: `"${calendar.google_id}"`,
    id: calendar.google_id,
    summary: calendar.summary,
    description: calendar.description ?? undefined,
    timeZone: calendar.time_zone,
  };
}

export function calendarRoutes({ app, store, baseUrl }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/discovery/v1/apis/calendar/v3/rest", (c) => {
    return c.json(buildCalendarDiscoveryDocument(baseUrl));
  });

  app.get("/calendar/v3/users/:userId/calendarList", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    return c.json({
      kind: "calendar#calendarList",
      items: listCalendarsForUser(gs, authEmail).map((calendar) => formatCalendarResource(calendar)),
    });
  });

  app.post("/calendar/v3/calendars", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const summary = getString(body, "summary")?.trim();
    if (!summary) {
      return googleApiError(c, 400, "Missing summary.", "required", "INVALID_ARGUMENT");
    }
    const timeZone = getString(body, "timeZone") ?? getCalendarById(gs, authEmail, "primary")?.time_zone ?? "UTC";
    if (!isValidTimeZone(timeZone)) {
      return googleApiError(c, 400, "Invalid time zone.", "timeZoneInvalid", "INVALID_ARGUMENT");
    }

    const calendar = createCalendarRecord(gs, {
      user_email: authEmail,
      summary,
      description: getString(body, "description") ?? null,
      time_zone: timeZone,
    });
    return c.json(formatCalendar(calendar));
  });

  app.get("/calendar/v3/calendars/:calendarId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const calendar = getCalendarById(gs, authEmail, c.req.param("calendarId"));
    if (!calendar) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    return c.json(formatCalendar(calendar));
  });

  app.get("/calendar/v3/calendars/:calendarId/events", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const calendar = getCalendarById(gs, authEmail, c.req.param("calendarId"));
    if (!calendar) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    const timeZone = url.searchParams.get("timeZone");
    if (timeZone && !isValidTimeZone(timeZone)) {
      return googleApiError(c, 400, "Invalid time zone.", "timeZoneInvalid", "INVALID_ARGUMENT");
    }
    const response = listCalendarEvents(gs, authEmail, calendar.google_id, {
      timeMin: url.searchParams.get("timeMin"),
      timeMax: url.searchParams.get("timeMax"),
      maxResults: url.searchParams.get("maxResults"),
      pageToken: url.searchParams.get("pageToken"),
      q: url.searchParams.get("q"),
      orderBy: url.searchParams.get("orderBy"),
      eventTypes: url.searchParams.getAll("eventTypes"),
    });

    return c.json({
      kind: "calendar#events",
      summary: calendar.summary,
      timeZone: timeZone ?? calendar.time_zone,
      items: response.items.map((event) => formatCalendarEventResource(gs, event, { timeZone })),
      nextPageToken: response.nextPageToken,
    });
  });

  app.get("/calendar/v3/calendars/:calendarId/events/:eventId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const event = getCalendarEventById(gs, authEmail, c.req.param("calendarId"), c.req.param("eventId"));
    if (!event) {
      return googleApiError(c, 404, "Not Found", "notFound", "NOT_FOUND");
    }
    const timeZone = new URL(c.req.url).searchParams.get("timeZone");
    return c.json(formatCalendarEventResource(gs, event, { timeZone }));
  });

  app.post("/calendar/v3/calendars/:calendarId/events", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const calendar = getCalendarById(gs, authEmail, c.req.param("calendarId"));
    if (!calendar) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const unsupported = rejectRecurrence(c, requestBody);
    if (unsupported) return unsupported;
    const eventInput = resolveEventTimes(c, parseCalendarEventInputFromBody(requestBody));
    if (eventInput instanceof Response) return eventInput;

    const event = createCalendarEventRecord(gs, {
      user_email: authEmail,
      calendar_google_id: calendar.google_id,
      ...eventInput,
    });

    return c.json(formatCalendarEventResource(gs, event));
  });

  // events.patch changes only the fields the body names; events.update replaces
  // the event with the body.
  const changeEvent = (mode: "patch" | "update") => async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const event = getCalendarEventById(gs, authEmail, c.req.param("calendarId") ?? "", c.req.param("eventId") ?? "");
    if (!event) {
      return googleApiError(c, 404, "Not Found", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const unsupported = rejectRecurrence(c, body);
    if (unsupported) return unsupported;

    const current = eventFields(event);
    let merged: EventFields;
    if (mode === "patch") {
      const patch = parseCalendarEventPatchFromBody(body);
      merged = { ...current, ...patch, properties: { ...current.properties, ...(patch.properties ?? {}) } };
    } else {
      merged = {
        ...parseCalendarEventInputFromBody(body),
        event_type: getString(body, "eventType") ?? current.event_type,
      };
    }
    const resolved = resolveEventTimes(c, merged);
    if (resolved instanceof Response) return resolved;

    const updated = updateCalendarEventRecord(gs, event, {
      status: resolved.status ?? event.status,
      summary: resolved.summary ?? event.summary,
      description: resolved.description ?? null,
      location: resolved.location ?? null,
      start_date_time: resolved.start_date_time ?? null,
      start_date: resolved.start_date ?? null,
      end_date_time: resolved.end_date_time ?? null,
      end_date: resolved.end_date ?? null,
      start_time_zone: resolved.start_time_zone ?? null,
      end_time_zone: resolved.end_time_zone ?? resolved.start_time_zone ?? null,
      attendees: resolved.attendees ?? [],
      conference_entry_points: resolved.conference_entry_points ?? [],
      hangout_link: resolved.hangout_link ?? null,
      transparency: resolved.transparency ?? null,
      event_type: resolved.event_type ?? event.event_type,
      properties: resolved.properties ?? {},
    });
    return c.json(formatCalendarEventResource(gs, updated));
  };
  app.patch("/calendar/v3/calendars/:calendarId/events/:eventId", changeEvent("patch"));
  app.put("/calendar/v3/calendars/:calendarId/events/:eventId", changeEvent("update"));

  app.delete("/calendar/v3/calendars/:calendarId/events/:eventId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const event = getCalendarEventById(gs, authEmail, c.req.param("calendarId"), c.req.param("eventId"));
    if (!event) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    deleteCalendarEventRecord(gs, event);
    return c.body(null, 204);
  });

  app.post("/calendar/v3/freeBusy", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const timeMin = typeof requestBody.timeMin === "string" ? requestBody.timeMin : undefined;
    const timeMax = typeof requestBody.timeMax === "string" ? requestBody.timeMax : undefined;
    const items = getRecordArray(requestBody, "items")
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
      }))
      .filter((entry) => entry.id.length > 0);

    if (!timeMin || !timeMax) {
      return googleApiError(c, 400, "timeMin and timeMax are required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    return c.json(
      buildFreeBusyResponse(gs, authEmail, {
        timeMin,
        timeMax,
        items,
      }),
    );
  });
}
