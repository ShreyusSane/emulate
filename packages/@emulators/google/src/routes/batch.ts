import type { Context, RouteContext } from "@emulators/core";
import { generateUid, googleApiError } from "../helpers.js";

// Google's batch endpoint: one multipart/mixed POST carrying several API calls,
// each part an `application/http` request. Every call is dispatched to this app
// as its own request, and the answers come back as parts in the same order,
// each with the Content-ID of its request prefixed by "response-".
// https://developers.google.com/gmail/api/guides/batch

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

// Gmail's own limit on calls in one batch request.
const MAX_CALLS = 100;

interface BatchCall {
  contentId: string | undefined;
  method: string;
  path: string;
  headers: Headers;
  body: string | undefined;
}

// Splits a message into its header block and body at the first blank line.
function splitHead(text: string): [string, string] {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return [text, ""];
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

function parseHeaders(block: string): Headers {
  const headers = new Headers();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function parseBatch(body: string, boundary: string): BatchCall[] {
  const delimiter = `--${boundary}`;
  const end = body.indexOf(`${delimiter}--`);
  const parts = (end === -1 ? body : body.slice(0, end)).split(delimiter).slice(1);
  return parts.map((part) => {
    const [partHead, http] = splitHead(part.replace(/^\r?\n/, ""));
    const contentId = parseHeaders(partHead).get("content-id") ?? undefined;
    const [requestHead, requestBody] = splitHead(http);
    const [requestLine, ...headerLines] = requestHead.split(/\r?\n/);
    const [method = "", path = ""] = requestLine.trim().split(/\s+/);
    const content = requestBody.replace(/\r?\n$/, "");
    return {
      contentId,
      method: method.toUpperCase(),
      path,
      headers: parseHeaders(headerLines.join("\n")),
      body: content.length > 0 ? content : undefined,
    };
  });
}

// "<abc+1>" becomes "<response-abc+1>".
function responseId(contentId: string | undefined): string | undefined {
  if (!contentId) return undefined;
  const bare = contentId.replace(/^<|>$/g, "");
  return `<response-${bare}>`;
}

export function batchRoutes({ app }: RouteContext): void {
  const handler = async (c: Context) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (!contentType.toLowerCase().startsWith("multipart/mixed") || !boundary) {
      return googleApiError(c, 400, "Batch requests must be multipart/mixed.", "badRequest", "INVALID_ARGUMENT");
    }

    const calls = parseBatch(await c.req.text(), boundary);
    if (calls.length > MAX_CALLS) {
      return googleApiError(
        c,
        400,
        `Too many requests in batch; the limit is ${MAX_CALLS}.`,
        "badRequest",
        "INVALID_ARGUMENT",
      );
    }

    const origin = new URL(c.req.url).origin;
    const outerAuth = c.req.header("Authorization");
    const parts: string[] = [];
    for (const call of calls) {
      let status: number;
      let responseHeaders: Headers;
      let responseBody: string;
      if (!call.method || !call.path.startsWith("/") || call.path.startsWith("/batch")) {
        status = 400;
        responseHeaders = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
        responseBody = JSON.stringify({
          error: { code: 400, message: "Invalid batch part.", status: "INVALID_ARGUMENT" },
        });
      } else {
        // A part without its own credentials uses the batch request's.
        if (!call.headers.has("Authorization") && outerAuth) call.headers.set("Authorization", outerAuth);
        call.headers.delete("Host");
        call.headers.delete("Content-Length");
        const init: RequestInit = { method: call.method, headers: call.headers };
        if (call.body !== undefined && call.method !== "GET" && call.method !== "HEAD") init.body = call.body;
        const response = await app.fetch(new Request(`${origin}${call.path}`, init));
        status = response.status;
        responseHeaders = response.headers;
        responseBody = await response.text();
      }

      const lines = ["Content-Type: application/http"];
      const id = responseId(call.contentId);
      if (id) lines.push(`Content-ID: ${id}`);
      lines.push("", `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ""}`.trimEnd());
      const type = responseHeaders.get("Content-Type");
      if (type) lines.push(`Content-Type: ${type}`);
      lines.push(`Content-Length: ${Buffer.byteLength(responseBody)}`, "", responseBody);
      parts.push(lines.join("\r\n"));
    }

    const responseBoundary = `batch_${generateUid()}`;
    const payload =
      parts.map((part) => `--${responseBoundary}\r\n${part}\r\n`).join("") + `--${responseBoundary}--\r\n`;
    return c.body(payload, 200, { "Content-Type": `multipart/mixed; boundary=${responseBoundary}` });
  };

  // The global endpoint and the per-API one (googleapis' discovery documents name
  // either, depending on their age); calls in a batch may target any API here.
  app.post("/batch", handler);
  app.post("/batch/:api/:version", handler);
}
