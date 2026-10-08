import { LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { getLinearStore, linearPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4301";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  linearPlugin.register(app as any, store, webhooks, base, tokenMap);
  linearPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ email: "bob@example.com", name: "Bob" }],
    labels: [{ name: "customer" }],
    cycles: [{ team: "ENG", name: "Sprint 7", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-15T00:00:00Z" }],
    issues: [
      {
        team: "ENG",
        title: "Refund webhook loops",
        assignee: "bob@example.com",
        labels: ["customer"],
        cycle: "Sprint 7",
      },
      { team: "ENG", title: "Apple Pay at checkout", state: "In Progress" },
    ],
    comments: [{ issue: "ENG-2", body: "Seen again for Globex." }],
  });
  return { app, store };
}

async function gql(app: Hono, query: string, variables?: Record<string, unknown>) {
  const res = await app.request(`${base}/graphql`, {
    method: "POST",
    headers: { Authorization: "Bearer lin_test_admin", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("Linear emulator against Linear's schema", () => {
  let app: Hono;
  let store: Store;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    ({ app, store } = createTestApp());
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(`${base}/graphql`)) {
        return app.request(url, { method: init?.method, headers: init?.headers, body: init?.body });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("answers the SDK's generated list queries", async () => {
    const client = new LinearClient({ apiKey: "lin_test_admin", apiUrl: `${base}/graphql` });
    const team = (await client.teams()).nodes[0];

    const issues = await client.issues({
      filter: { team: { id: { eq: team.id } }, labels: { name: { eq: "customer" } } },
    });
    expect(issues.nodes.map((issue) => issue.title)).toEqual(["Refund webhook loops"]);
    expect((await issues.nodes[0].assignee)?.email).toBe("bob@example.com");

    const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
    expect(states.nodes.map((state) => state.name)).toContain("In Progress");

    const cycles = await client.cycles({ filter: { team: { id: { eq: team.id } } } });
    expect(cycles.nodes.map((cycle) => cycle.name)).toContain("Sprint 7");

    const apple = getLinearStore(store).issues.findOneBy("identifier", "ENG-2")!;
    const comments = await client.comments({ filter: { issue: { id: { eq: apple.linear_id } } } });
    expect(comments.nodes.map((comment) => comment.body)).toEqual(["Seen again for Globex."]);

    const labels = await client.issueLabels();
    expect(labels.nodes.map((label) => label.name)).toContain("customer");
  });

  it("combines filter fields with all of `and` and one of `or`", async () => {
    const { body } = await gql(app, `query($filter: IssueFilter) { issues(filter: $filter) { nodes { title } } }`, {
      filter: {
        team: { key: { eq: "ENG" } },
        or: [{ title: { containsIgnoreCase: "refund" } }, { title: { containsIgnoreCase: "apple" } }],
        and: [{ assignee: { null: true } }],
      },
    });
    expect(body.errors).toBeUndefined();
    expect(body.data.issues.nodes.map((issue: { title: string }) => issue.title)).toEqual(["Apple Pay at checkout"]);
  });

  it("matches nested and collection filters", async () => {
    const run = async (filter: Record<string, unknown>) => {
      const { body } = await gql(app, `query($f: IssueFilter) { issues(filter: $f) { nodes { title } } }`, {
        f: filter,
      });
      expect(body.errors).toBeUndefined();
      return body.data.issues.nodes.map((issue: { title: string }) => issue.title);
    };
    expect(await run({ state: { type: { eq: "started" } } })).toEqual(["Apple Pay at checkout"]);
    expect(await run({ assignee: { email: { eq: "bob@example.com" } } })).toEqual(["Refund webhook loops"]);
    expect(await run({ cycle: { name: { eq: "Sprint 7" } } })).toEqual(["Refund webhook loops"]);
    expect(await run({ labels: { every: { name: { neq: "customer" } } }, title: { contains: "Refund" } })).toEqual([]);
    expect(await run({ labels: { length: { eq: 0 } }, team: { key: { eq: "ENG" } } })).toContain(
      "Apple Pay at checkout",
    );
  });

  it("leaves archived issues out of lists unless includeArchived is set", async () => {
    const refund = getLinearStore(store).issues.findOneBy("identifier", "ENG-2")!;
    const archived = await gql(app, `mutation($id: String!) { issueArchive(id: $id) { success } }`, {
      id: refund.linear_id,
    });
    expect(archived.body.errors).toBeUndefined();

    const titles = async (includeArchived?: boolean) => {
      const { body } = await gql(
        app,
        `query($a: Boolean) { issues(includeArchived: $a) { nodes { title } } }`,
        includeArchived === undefined ? {} : { a: includeArchived },
      );
      return body.data.issues.nodes.map((issue: { title: string }) => issue.title);
    };
    expect(await titles()).not.toContain("Refund webhook loops");
    expect(await titles(false)).not.toContain("Refund webhook loops");
    expect(await titles(true)).toContain("Refund webhook loops");
  });

  it("gives fields it does not model the empty value of their type", async () => {
    const { body } = await gql(
      app,
      `{ issues(first: 1) { nodes { identifier slaBreachesAt trashed children { nodes { id } } } } }`,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data.issues.nodes[0]).toEqual({
      identifier: "ENG-1",
      slaBreachesAt: null,
      trashed: null,
      children: { nodes: [] },
    });
  });

  it("rejects queries, filter fields and arguments it does not implement", async () => {
    const notifications = await gql(app, `{ notifications { nodes { id } } }`);
    expect(notifications.status).toBe(400);
    expect(notifications.body.errors[0].message).toBe("Not supported by the Linear emulator: Query.notifications");
    expect(notifications.body.errors[0].extensions.code).toBe("EMULATOR_UNSUPPORTED");

    const estimate = await gql(app, `{ issues(filter: { estimate: { eq: 3 } }) { nodes { id } } }`);
    expect(estimate.body.errors[0].message).toBe(
      "Not supported by the Linear emulator: input field Query.issues(filter).estimate",
    );

    const sort = await gql(app, `{ issues(sort: [{ priority: { order: Ascending } }]) { nodes { id } } }`);
    expect(sort.body.errors[0].message).toBe("Not supported by the Linear emulator: argument Query.issues(sort)");
  });

  it("rejects documents Linear would reject", async () => {
    const { status, body } = await gql(app, `{ issues { nodes { notAField } } }`);
    expect(status).toBe(400);
    expect(body.errors[0].message).toContain('Cannot query field "notAField" on type "Issue"');
  });
});
