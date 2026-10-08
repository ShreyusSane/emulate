import { readFileSync } from "node:fs";
import {
  GraphQLError,
  buildSchema,
  defaultFieldResolver,
  getNamedType,
  getNullableType,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  valueFromASTUntyped,
  type GraphQLArgument,
  type GraphQLFieldResolver,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLTypeResolver,
} from "graphql";

// Linear's published GraphQL schema (linear/linear, packages/sdk/src/schema.graphql
// at @linear/sdk@88.3.0, MIT). Requests are validated against it, so clients that
// send Linear's real documents, such as @linear/sdk, are accepted or rejected the
// way Linear would.
//
// The emulator implements a subset of it, described by its own schema
// (`supported`). For each field the full schema asks for:
//   - a field in the subset resolves as before
//   - an argument or input field outside the subset is an error, so a filter or
//     update the emulator cannot honour is never silently ignored
//   - a top-level query or mutation outside the subset is an error
//   - any other field outside the subset resolves to an empty value of its type
//     (null, [], an empty connection), the way a field with no data would
function readLinearSdl(): string {
  // Next to the bundle in dist/, one directory up from src/routes/ in the source.
  for (const candidate of ["./linear.graphql", "../linear.graphql"]) {
    try {
      return readFileSync(new URL(candidate, import.meta.url), "utf8");
    } catch {
      // Try the next location.
    }
  }
  throw new Error("Linear GraphQL schema (linear.graphql) not found");
}

export function buildLinearSchema(): GraphQLSchema {
  return buildSchema(readLinearSdl(), { assumeValidSDL: true });
}

export function unsupported(message: string): GraphQLError {
  return new GraphQLError(`Not supported by the Linear emulator: ${message}`, {
    extensions: { code: "EMULATOR_UNSUPPORTED" },
  });
}

export function createFieldResolver(supported: GraphQLSchema): GraphQLFieldResolver<unknown, unknown> {
  return (source, args, context, info) => {
    const parentName = info.parentType.name;
    const supportedParent = supported.getType(parentName);
    const supportedField = isObjectType(supportedParent) ? supportedParent.getFields()[info.fieldName] : undefined;
    const isRoot = info.parentType === info.schema.getQueryType() || info.parentType === info.schema.getMutationType();

    if (!supportedField) {
      if (isRoot) throw unsupported(`${parentName}.${info.fieldName}`);
      return emptyValue(info.returnType, source);
    }

    const fullArgs = info.parentType.getFields()[info.fieldName].args;
    for (const [name, value] of Object.entries(args)) {
      const fullArg = fullArgs.find((arg) => arg.name === name);
      if (fullArg && isDefaultValue(fullArg, value)) continue;
      // Linear's boolean arguments switch extra behaviour on (includeArchived,
      // includeSubTeams, ...); false asks for the default, which is what the
      // emulator does.
      if (fullArg && value === false && getNamedType(fullArg.type).name === "Boolean") continue;
      const supportedArg = supportedField.args.find((arg) => arg.name === name);
      const path = `${parentName}.${info.fieldName}(${name})`;
      if (!supportedArg) throw unsupported(`argument ${path}`);
      checkInput(supportedArg.type, value, path);
    }

    // A field the emulator stores as null can be non-null in Linear's schema.
    const orEmpty = (resolved: unknown) => (resolved == null ? emptyValue(info.returnType, source) : resolved);
    const value = defaultFieldResolver(source, args, context, info);
    return value instanceof Promise ? value.then(orEmpty) : orEmpty(value);
  };
}

// Abstract types appear only in fields outside the subset; values that reach one
// name their type.
export const typeResolver: GraphQLTypeResolver<unknown, unknown> = (value) => {
  const typename = (value as { __typename?: unknown } | null)?.__typename;
  return typeof typename === "string" ? typename : undefined;
};

// graphql 17 keeps an SDL default as a literal (`default`), older versions as
// `defaultValue`. Arguments left out arrive with their default.
function isDefaultValue(arg: GraphQLArgument, value: unknown): boolean {
  const literal = arg.default?.literal;
  const fallback = literal ? valueFromASTUntyped(literal) : (arg.default?.value ?? arg.defaultValue);
  return fallback !== undefined && JSON.stringify(fallback) === JSON.stringify(value);
}

function checkInput(type: GraphQLInputType, value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  const nullable = getNullableType(type);
  if (isListType(nullable)) {
    if (Array.isArray(value)) value.forEach((item, i) => checkInput(nullable.ofType, item, `${path}[${i}]`));
    return;
  }
  if (!isInputObjectType(nullable) || typeof value !== "object") return;
  const fields = nullable.getFields();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    const field = fields[key];
    if (!field) throw unsupported(`input field ${path}.${key}`);
    checkInput(field.type, item, `${path}.${key}`);
  }
}

const EMPTY_PAGE_INFO = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

function emptyValue(type: GraphQLOutputType, source: unknown): unknown {
  if (!isNonNullType(type)) return null;
  const inner = type.ofType;
  if (isListType(inner)) return [];
  if (isEnumType(inner)) return inner.getValues()[0]?.value ?? null;
  if (isScalarType(inner)) {
    switch (inner.name) {
      case "String":
      case "ID":
        return "";
      case "Int":
      case "Float":
        return 0;
      case "Boolean":
        return false;
      case "DateTime":
        return (source as { createdAt?: unknown } | null)?.createdAt ?? new Date(0).toISOString();
      case "TimelessDate":
        return "1970-01-01";
      default:
        return {};
    }
  }
  const named = getNamedType(inner);
  if (named.name === "PageInfo") return EMPTY_PAGE_INFO;
  if (named.name.endsWith("Connection")) return { nodes: [], edges: [], pageInfo: EMPTY_PAGE_INFO };
  // Any other object: its own fields resolve to their empty values.
  return {};
}
