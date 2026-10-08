import { unsupported } from "./full-schema.js";

// Linear's filter inputs, as far as the emulator implements them. These are
// Linear's own type and field names (see linear.graphql); a field left out here
// is rejected as unsupported rather than ignored.
export const FILTER_SDL = `
  scalar DateTimeOrDuration

  input StringComparator {
    eq: String
    neq: String
    in: [String!]
    nin: [String!]
    contains: String
    notContains: String
    containsIgnoreCase: String
    notContainsIgnoreCase: String
    startsWith: String
    notStartsWith: String
    startsWithIgnoreCase: String
    endsWith: String
    notEndsWith: String
    eqIgnoreCase: String
    neqIgnoreCase: String
  }

  input NullableStringComparator {
    eq: String
    neq: String
    in: [String!]
    nin: [String!]
    contains: String
    notContains: String
    containsIgnoreCase: String
    notContainsIgnoreCase: String
    startsWith: String
    notStartsWith: String
    startsWithIgnoreCase: String
    endsWith: String
    notEndsWith: String
    eqIgnoreCase: String
    neqIgnoreCase: String
    null: Boolean
  }

  input IDComparator { eq: ID neq: ID in: [ID!] nin: [ID!] }
  input IssueIDComparator { eq: ID neq: ID in: [ID!] nin: [ID!] }
  input NumberComparator { eq: Float neq: Float in: [Float!] nin: [Float!] lt: Float lte: Float gt: Float gte: Float }
  input NullableNumberComparator {
    eq: Float neq: Float in: [Float!] nin: [Float!] lt: Float lte: Float gt: Float gte: Float null: Boolean
  }
  input BooleanComparator { eq: Boolean neq: Boolean }
  input DateComparator {
    eq: DateTimeOrDuration neq: DateTimeOrDuration lt: DateTimeOrDuration lte: DateTimeOrDuration
    gt: DateTimeOrDuration gte: DateTimeOrDuration
  }
  input NullableDateComparator {
    eq: DateTimeOrDuration neq: DateTimeOrDuration lt: DateTimeOrDuration lte: DateTimeOrDuration
    gt: DateTimeOrDuration gte: DateTimeOrDuration null: Boolean
  }

  input TeamFilter {
    id: IDComparator
    key: StringComparator
    name: StringComparator
    private: BooleanComparator
    and: [TeamFilter!]
    or: [TeamFilter!]
  }

  input UserFilter {
    id: IDComparator
    email: StringComparator
    name: StringComparator
    displayName: StringComparator
    active: BooleanComparator
    admin: BooleanComparator
    isMe: BooleanComparator
    and: [UserFilter!]
    or: [UserFilter!]
  }

  input NullableUserFilter {
    id: IDComparator
    email: StringComparator
    name: StringComparator
    displayName: StringComparator
    active: BooleanComparator
    admin: BooleanComparator
    isMe: BooleanComparator
    null: Boolean
    and: [NullableUserFilter!]
    or: [NullableUserFilter!]
  }

  input WorkflowStateFilter {
    id: IDComparator
    name: StringComparator
    type: StringComparator
    team: TeamFilter
    and: [WorkflowStateFilter!]
    or: [WorkflowStateFilter!]
  }

  input NullableProjectFilter {
    id: IDComparator
    name: StringComparator
    null: Boolean
    and: [NullableProjectFilter!]
    or: [NullableProjectFilter!]
  }

  input NullableCycleFilter {
    id: IDComparator
    name: StringComparator
    number: NumberComparator
    null: Boolean
    and: [NullableCycleFilter!]
    or: [NullableCycleFilter!]
  }

  input CycleFilter {
    id: IDComparator
    name: StringComparator
    number: NumberComparator
    startsAt: DateComparator
    endsAt: DateComparator
    isActive: BooleanComparator
    team: TeamFilter
    and: [CycleFilter!]
    or: [CycleFilter!]
  }

  input NullableIssueFilter {
    id: IssueIDComparator
    number: NumberComparator
    title: StringComparator
    team: TeamFilter
    null: Boolean
    and: [NullableIssueFilter!]
    or: [NullableIssueFilter!]
  }

  input CommentFilter {
    id: IDComparator
    body: StringComparator
    createdAt: DateComparator
    issue: NullableIssueFilter
    user: UserFilter
    and: [CommentFilter!]
    or: [CommentFilter!]
  }

  input NullableTeamFilter {
    id: IDComparator
    key: StringComparator
    name: StringComparator
    null: Boolean
    and: [NullableTeamFilter!]
    or: [NullableTeamFilter!]
  }

  input IssueLabelFilter {
    id: IDComparator
    name: StringComparator
    team: NullableTeamFilter
    and: [IssueLabelFilter!]
    or: [IssueLabelFilter!]
  }

  input IssueLabelCollectionFilter {
    id: IDComparator
    name: StringComparator
    some: IssueLabelFilter
    every: IssueLabelFilter
    length: NumberComparator
    null: Boolean
    and: [IssueLabelCollectionFilter!]
    or: [IssueLabelCollectionFilter!]
  }

  input IssueFilter {
    id: IssueIDComparator
    number: NumberComparator
    title: StringComparator
    description: NullableStringComparator
    priority: NullableNumberComparator
    createdAt: DateComparator
    updatedAt: DateComparator
    startedAt: NullableDateComparator
    completedAt: NullableDateComparator
    canceledAt: NullableDateComparator
    team: TeamFilter
    state: WorkflowStateFilter
    assignee: NullableUserFilter
    creator: NullableUserFilter
    delegate: NullableUserFilter
    project: NullableProjectFilter
    cycle: NullableCycleFilter
    labels: IssueLabelCollectionFilter
    and: [IssueFilter!]
    or: [IssueFilter!]
  }
`;

// A filterable view of one record: each filter field maps to how it is tested.
export type FilterField =
  | { kind: "value"; value: unknown; aliases?: unknown[] } // compared with a comparator
  | { kind: "record"; view: FilterView | null } // a nested filter; null when the relation is empty
  | { kind: "collection"; views: FilterView[] }; // a collection filter
export type FilterView = Record<string, () => FilterField>;

export const value = (v: unknown, aliases?: unknown[]): FilterField => ({ kind: "value", value: v, aliases });
export const record = (view: FilterView | null): FilterField => ({ kind: "record", view });
export const collection = (views: FilterView[]): FilterField => ({ kind: "collection", views });

// Whether a record matches a Linear filter: every field given must match, and
// `and` / `or` lists combine with them (all of `and`, at least one of `or`).
export function matchesFilter(view: FilterView, filter: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (condition == null) continue;
    if (key === "and") {
      if (!(condition as Record<string, unknown>[]).every((sub) => matchesFilter(view, sub))) return false;
      continue;
    }
    if (key === "or") {
      const subs = condition as Record<string, unknown>[];
      if (subs.length > 0 && !subs.some((sub) => matchesFilter(view, sub))) return false;
      continue;
    }
    if (key === "null") continue; // handled by the parent relation
    const field = view[key];
    if (!field) throw unsupported(`filter field ${key}`);
    if (!fieldMatches(field(), condition as Record<string, unknown>)) return false;
  }
  return true;
}

function fieldMatches(field: FilterField, condition: Record<string, unknown>): boolean {
  if (field.kind === "value") {
    const values = [field.value, ...(field.aliases ?? [])];
    return comparatorMatches(values, condition);
  }
  if (field.kind === "record") {
    if (typeof condition.null === "boolean") {
      if (condition.null !== (field.view === null)) return false;
    }
    if (field.view === null) {
      return Object.keys(condition).every((key) => key === "null" || condition[key] == null);
    }
    return matchesFilter(field.view, condition);
  }
  return collectionMatches(field.views, condition);
}

function collectionMatches(views: FilterView[], condition: Record<string, unknown>): boolean {
  for (const [key, sub] of Object.entries(condition)) {
    if (sub == null) continue;
    const clause = sub as Record<string, unknown>;
    switch (key) {
      case "some":
        if (!views.some((view) => matchesFilter(view, clause))) return false;
        break;
      case "every":
        if (!views.every((view) => matchesFilter(view, clause))) return false;
        break;
      case "length":
        if (!comparatorMatches([views.length], clause)) return false;
        break;
      case "null":
        if ((sub as boolean) !== (views.length === 0)) return false;
        break;
      case "and":
        if (!(sub as Record<string, unknown>[]).every((item) => collectionMatches(views, item))) return false;
        break;
      case "or": {
        const items = sub as Record<string, unknown>[];
        if (items.length > 0 && !items.some((item) => collectionMatches(views, item))) return false;
        break;
      }
      default:
        // A member field on the collection itself, such as labels: { name: { eq } },
        // matches when some member matches.
        if (!views.some((view) => matchesFilter(view, { [key]: sub }))) return false;
    }
  }
  return true;
}

// A comparator holds when the record's value satisfies every given operator.
// Aliases are other values the same field answers to (an issue's id also
// matches its identifier); a positive operator holds if any of them satisfies
// it, a negative one only if none violates it.
function comparatorMatches(values: unknown[], comparator: Record<string, unknown>): boolean {
  const primary = values[0];
  for (const [op, operand] of Object.entries(comparator)) {
    if (operand === undefined || operand === null) continue;
    const present = values.filter((v) => v !== null && v !== undefined);
    switch (op) {
      case "null":
        if (operand !== (primary === null || primary === undefined)) return false;
        break;
      case "eq":
        if (!present.some((v) => compare(v, operand) === 0)) return false;
        break;
      case "neq":
        if (present.some((v) => compare(v, operand) === 0)) return false;
        break;
      case "in":
        if (!present.some((v) => (operand as unknown[]).some((o) => compare(v, o) === 0))) return false;
        break;
      case "nin":
        if (present.some((v) => (operand as unknown[]).some((o) => compare(v, o) === 0))) return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (primary === null || primary === undefined) return false;
        const order = compare(primary, operand);
        if (op === "lt" && !(order < 0)) return false;
        if (op === "lte" && !(order <= 0)) return false;
        if (op === "gt" && !(order > 0)) return false;
        if (op === "gte" && !(order >= 0)) return false;
        break;
      }
      default:
        if (!stringOperatorMatches(op, present.map(String), String(operand))) return false;
    }
  }
  return true;
}

function stringOperatorMatches(op: string, values: string[], operand: string): boolean {
  const lower = operand.toLowerCase();
  switch (op) {
    case "contains":
      return values.some((v) => v.includes(operand));
    case "notContains":
      return !values.some((v) => v.includes(operand));
    case "containsIgnoreCase":
      return values.some((v) => v.toLowerCase().includes(lower));
    case "notContainsIgnoreCase":
      return !values.some((v) => v.toLowerCase().includes(lower));
    case "startsWith":
      return values.some((v) => v.startsWith(operand));
    case "notStartsWith":
      return !values.some((v) => v.startsWith(operand));
    case "startsWithIgnoreCase":
      return values.some((v) => v.toLowerCase().startsWith(lower));
    case "endsWith":
      return values.some((v) => v.endsWith(operand));
    case "notEndsWith":
      return !values.some((v) => v.endsWith(operand));
    case "eqIgnoreCase":
      return values.some((v) => v.toLowerCase() === lower);
    case "neqIgnoreCase":
      return !values.some((v) => v.toLowerCase() === lower);
    default:
      throw unsupported(`comparator ${op}`);
  }
}

// Numbers compare as numbers and booleans as booleans; dates are ISO strings, so
// they compare as strings once both sides are full timestamps. A relative
// duration (DateTimeOrDuration such as "-P2W") is not supported.
function compare(actual: unknown, operand: unknown): number {
  if (typeof actual === "number" || typeof operand === "number") return Number(actual) - Number(operand);
  if (typeof actual === "boolean" || typeof operand === "boolean") return actual === operand ? 0 : 1;
  const a = String(actual);
  let b = String(operand);
  if (/^-?P/.test(b)) throw unsupported(`relative date ${b}`);
  if (ISO_TIMESTAMP.test(a) && !Number.isNaN(Date.parse(b))) b = new Date(b).toISOString();
  return a < b ? -1 : a > b ? 1 : 0;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
