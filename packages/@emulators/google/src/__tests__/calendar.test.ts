import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("alice-token", { login: "alice@acme.test", id: 1, scopes: [] });
  tokenMap.set("bob-token", { login: "bob@acme.test", id: 2, scopes: [] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  googlePlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  seedFromConfig(store, base, {
    users: [
      { email: "alice@acme.test", name: "Alice Chen" },
      { email: "bob@acme.test", name: "Bob Ortiz" },
    ],
    calendars: [
      { id: "primary", user_email: "alice@acme.test", summary: "Alice", time_zone: "America/New_York", primary: true },
      { id: "primary", user_email: "bob@acme.test", summary: "Bob", time_zone: "Europe/London", primary: true },
    ],
    calendar_events: [
      {
        id: "evt_standup",
        user_email: "alice@acme.test",
        summary: "Standup",
        start_date_time: "2026-10-28T09:00:00",
        end_date_time: "2026-10-28T09:15:00",
      },
      {
        id: "evt_bob_review",
        user_email: "bob@acme.test",
        summary: "Design review",
        start_date_time: "2026-10-28T15:00:00Z",
        end_date_time: "2026-10-28T16:00:00Z",
      },
      {
        id: "evt_bob_declined",
        user_email: "bob@acme.test",
        summary: "Optional sync",
        organizer: "carol@acme.test",
        start_date_time: "2026-10-28T17:00:00Z",
        end_date_time: "2026-10-28T18:00:00Z",
        attendees: [{ email: "bob@acme.test", response_status: "declined" }],
      },
    ],
  });
  return app;
}

const as = (token: string, extra?: Record<string, string>) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  ...extra,
});

async function call(app: Hono, method: string, path: string, body?: unknown, token = "alice-token") {
  const res = await app.request(`${base}${path}`, {
    method,
    headers: as(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

describe("Google Calendar fidelity", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("reads a dateTime without an offset in its timeZone, across a DST change", async () => {
    const before = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      summary: "Before the change",
      start: { dateTime: "2026-10-28T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-28T11:00:00", timeZone: "America/New_York" },
    });
    expect(before.status).toBe(200);
    expect(before.body.start).toEqual({ dateTime: "2026-10-28T10:00:00-04:00", timeZone: "America/New_York" });

    const after = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      summary: "After the change",
      start: { dateTime: "2026-11-02T10:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-02T11:00:00", timeZone: "America/New_York" },
    });
    expect(after.body.start.dateTime).toBe("2026-11-02T10:00:00-05:00");

    const busy = await call(app, "POST", "/calendar/v3/freeBusy", {
      // After the seeded 09:00 standup (13:00Z).
      timeMin: "2026-10-28T13:30:00Z",
      timeMax: "2026-11-03T00:00:00Z",
      items: [{ id: "primary" }],
    });
    expect(busy.body.calendars.primary.busy).toEqual([
      { start: "2026-10-28T14:00:00.000Z", end: "2026-10-28T15:00:00.000Z" },
      { start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T16:00:00.000Z" },
    ]);
  });

  it("shows events in the calendar's zone, and seeds offsetless times in it", async () => {
    const res = await call(app, "GET", "/calendar/v3/calendars/primary/events/evt_standup");
    expect(res.status).toBe(200);
    expect(res.body.start).toEqual({ dateTime: "2026-10-28T09:00:00-04:00" });
    expect(res.body.organizer).toEqual({ email: "alice@acme.test", displayName: "Alice Chen", self: true });

    const inLondon = await call(app, "GET", "/calendar/v3/calendars/primary/events/evt_standup?timeZone=Europe/London");
    expect(inLondon.body.start.dateTime).toBe("2026-10-28T13:00:00Z");
  });

  it("rejects times the Calendar API rejects", async () => {
    const noZone = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      start: { dateTime: "2026-10-28T10:00:00" },
      end: { dateTime: "2026-10-28T11:00:00" },
    });
    expect(noZone.status).toBe(400);
    expect(noZone.body.error.message).toBe("Missing time zone definition for start time.");

    const backwards = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      start: { dateTime: "2026-10-28T11:00:00Z" },
      end: { dateTime: "2026-10-28T10:00:00Z" },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.errors[0].reason).toBe("timeRangeEmpty");

    const badZone = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      start: { dateTime: "2026-10-28T10:00:00", timeZone: "Mars/Olympus" },
      end: { dateTime: "2026-10-28T11:00:00", timeZone: "Mars/Olympus" },
    });
    expect(badZone.status).toBe(400);

    const recurring = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      start: { dateTime: "2026-10-28T10:00:00Z" },
      end: { dateTime: "2026-10-28T11:00:00Z" },
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    });
    expect(recurring.status).toBe(400);
    expect(recurring.body.error.errors[0].reason).toBe("emulatorUnsupported");
  });

  it("patches only the fields named, and update replaces the event", async () => {
    const created = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      summary: "1:1",
      description: "Weekly catch-up",
      start: { dateTime: "2026-10-29T14:00:00Z" },
      end: { dateTime: "2026-10-29T14:30:00Z" },
      attendees: [{ email: "bob@acme.test" }],
      visibility: "private",
    });
    const id = created.body.id as string;
    expect(created.body.attendees).toEqual([{ email: "bob@acme.test", responseStatus: "needsAction" }]);

    const patched = await call(app, "PATCH", `/calendar/v3/calendars/primary/events/${id}`, {
      summary: "1:1 (moved)",
      start: { dateTime: "2026-10-29T11:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-29T11:30:00", timeZone: "America/New_York" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      summary: "1:1 (moved)",
      description: "Weekly catch-up",
      visibility: "private",
      start: { dateTime: "2026-10-29T11:00:00-04:00", timeZone: "America/New_York" },
    });
    expect(patched.body.attendees).toHaveLength(1);

    const replaced = await call(app, "PUT", `/calendar/v3/calendars/primary/events/${id}`, {
      summary: "1:1",
      start: { dateTime: "2026-10-29T15:00:00Z" },
      end: { dateTime: "2026-10-29T15:30:00Z" },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.description).toBeUndefined();
    expect(replaced.body.attendees).toBeUndefined();
    expect(replaced.body.visibility).toBeUndefined();

    const empty = await call(app, "PATCH", `/calendar/v3/calendars/primary/events/${id}`, {
      end: { dateTime: "2026-10-29T15:00:00Z" },
    });
    expect(empty.status).toBe(400);

    const missing = await call(app, "GET", "/calendar/v3/calendars/primary/events/evt_nope");
    expect(missing.status).toBe(404);
  });

  it("answers free/busy for a coworker's calendar, leaving out what they declined", async () => {
    const res = await call(app, "POST", "/calendar/v3/freeBusy", {
      timeMin: "2026-10-28T00:00:00Z",
      timeMax: "2026-10-29T00:00:00Z",
      items: [{ id: "bob@acme.test" }, { id: "nobody@acme.test" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.calendars["bob@acme.test"]).toEqual({
      busy: [{ start: "2026-10-28T15:00:00.000Z", end: "2026-10-28T16:00:00.000Z" }],
    });
    expect(res.body.calendars["nobody@acme.test"]).toEqual({
      busy: [],
      errors: [{ domain: "global", reason: "notFound" }],
    });
  });

  it("keeps event types and their properties, and filters by type", async () => {
    const ooo = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      summary: "Out of office",
      eventType: "outOfOffice",
      start: { dateTime: "2026-10-30T00:00:00Z" },
      end: { dateTime: "2026-10-31T00:00:00Z" },
      outOfOfficeProperties: { autoDeclineMode: "declineAllConflictingInvitations", declineMessage: "Away" },
      transparency: "opaque",
    });
    expect(ooo.status).toBe(200);
    expect(ooo.body.outOfOfficeProperties.declineMessage).toBe("Away");

    const listed = await call(
      app,
      "GET",
      "/calendar/v3/calendars/primary/events?eventTypes=outOfOffice&singleEvents=true&orderBy=startTime",
    );
    expect(listed.body.items.map((event: { id: string }) => event.id)).toEqual([ooo.body.id]);
    expect(listed.body.timeZone).toBe("America/New_York");

    const bad = await call(app, "POST", "/calendar/v3/calendars/primary/events", {
      eventType: "birthdayParty",
      start: { dateTime: "2026-10-30T00:00:00Z" },
      end: { dateTime: "2026-10-31T00:00:00Z" },
    });
    expect(bad.status).toBe(400);
  });

  it("creates a secondary calendar that appears in the calendar list", async () => {
    const created = await call(app, "POST", "/calendar/v3/calendars", { summary: "Team offsite" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      kind: "calendar#calendar",
      summary: "Team offsite",
      timeZone: "America/New_York",
    });

    const fetched = await call(app, "GET", `/calendar/v3/calendars/${created.body.id}`);
    expect(fetched.body.id).toBe(created.body.id);

    const list = await call(app, "GET", "/calendar/v3/users/me/calendarList");
    expect(list.body.items.map((calendar: { summary: string }) => calendar.summary)).toContain("Team offsite");

    const forBob = await call(app, "GET", `/calendar/v3/calendars/${created.body.id}`, undefined, "bob-token");
    expect(forBob.status).toBe(404);
  });
});
