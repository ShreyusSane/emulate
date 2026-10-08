# @emulators/linear

Stateful Linear GraphQL API emulator for local development and CI.

Part of [emulate](https://github.com/vercel-labs/emulate), local drop-in replacement services for CI and no-network sandboxes.

## Install

```sh
npm install @emulators/linear
```

Most users should run it through the main CLI:

```sh
npx emulate --service linear
```

## Supported Surface

- `POST /graphql`, validated against Linear's published schema (`src/linear.graphql`, from `@linear/sdk` 88.3.0), so the documents `@linear/sdk` generates are accepted as Linear accepts them.
- Queries for viewer, organization, users, teams, workflow states, issues, comments, labels, projects, cycles, webhooks, and agent sessions.
- Issue selections include numeric `priority` and the derived `priorityLabel`.
- Mutations for issues, comments, labels, webhooks, and basic agent sessions and activities.
- OAuth authorize, token, refresh, revoke, PKCE, client credentials, and app actor tokens.
- Personal API key and OAuth bearer token auth.
- Linear-shaped webhook delivery with `Linear-Delivery`, `Linear-Event`, and `Linear-Signature` headers.
- Local inspector at `/`.

OAuth app `actor` config is authoritative. Apps configured with `actor: user` use authorization code flows. Apps configured with `actor: app` use the app install flow and can request client credentials tokens.

This is not a complete Linear clone. It implements a subset of the schema:

- A field outside the subset resolves to the empty value of its type: `null`, an empty list, or an empty connection.
- A top-level query or mutation, argument, or filter field outside the subset is an error with `extensions.code` `EMULATOR_UNSUPPORTED`, so a request the emulator cannot honour is never answered as if it were.
- Filters take Linear's shapes, for example `{ team: { key: { eq: "ENG" } }, labels: { some: { name: { eq: "Bug" } } } }`, on issues, users, teams, workflow states, cycles, labels, and comments. Fields combine with all of `and` and at least one of `or`.
- Issue lists leave out archived issues unless `includeArchived: true`.
