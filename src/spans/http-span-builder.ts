/**
 * `http_request` family span assembly for the fetch governance patch.
 *
 * Pure data-assembly module: given already-resolved identity (span/trace id),
 * timing, and captured request/response fields, produce a flat Core
 * `SpanData` dict for the `started` or `completed` stage. `toCoreSpanData`
 * (Phase 3, `spans/core-span.ts`) fills the remaining common/family defaults
 * and applies `attributes`/body truncation downstream — this module does NOT
 * duplicate that; it owns exactly the http-specific fields plus the one gap
 * `toCoreSpanData` leaves open: header redaction (see below).
 *
 * Header redaction default (Decision 16 / plan OQ6): request/response headers
 * are redacted HERE, unconditionally, for a fixed set of known credential
 * headers — never deferred to `PrivacyConfig.redactKeys` (which defaults to
 * EMPTY, see `config/index.ts` `defaultPrivacyConfig`). `toCoreSpanData` only
 * redacts the `attributes` sub-object and only truncates `request_body`/
 * `response_body`; it never touches `request_headers`/`response_headers`.
 * Redacting here — at span-construction time, before the span ever reaches
 * `toCoreSpanData`/signing — closes that gap without modifying the Phase 3
 * normalizer, and still reuses the Phase 2 `applyRedaction` helper exactly as
 * directed.
 */

import { HookType, SEMANTIC_FIELDS_BY_HOOK_TYPE, type SpanRecord } from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import { applyRedaction } from "../serialization/index.js";

/**
 * Known credential/auth header names, redacted by default regardless of user
 * config (case-insensitive — `applyRedaction` lowercases before comparing).
 * Mirrors `openbox-sdk-python` `instrumentation/http.py` `_SENSITIVE_HEADERS`.
 */
export const DEFAULT_SENSITIVE_HTTP_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-amz-security-token"
]);

/** Redact known credential headers; `null`/undefined headers pass through untouched. */
export function redactHttpHeaders(
  headers: Readonly<Record<string, string>> | null | undefined
): Record<string, string> | null {
  if (headers === null || headers === undefined) return null;
  const [redacted] = applyRedaction(headers, DEFAULT_SENSITIVE_HTTP_HEADERS);
  return redacted as Record<string, string>;
}

/**
 * OTel-native request attributes, matching the ones openbox-sdk-python sets on
 * its HTTP spans. Without them Core stores the span with empty attributes.
 */
function httpAttributes(method: string, url: string): Record<string, JsonValue> {
  return { "http.request.method": method, "url.full": url };
}

function deriveHttpError(
  explicit: string | null | undefined,
  statusCode: number | null | undefined
): string | null {
  if (explicit !== undefined) return explicit;
  return typeof statusCode === "number" && statusCode >= 400 ? `HTTP ${statusCode}` : null;
}

export interface HttpSpanIdentity {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string | null;
}

export interface BuildStartedHttpSpanInput extends HttpSpanIdentity {
  readonly method: string;
  readonly url: string;
  readonly startTimeNs: number;
  readonly requestHeaders?: Readonly<Record<string, string>> | null;
  readonly requestBody?: string | null;
}

/** Assemble the STARTED-stage `http_request` span (preflight — before the real fetch runs). */
export function buildStartedHttpSpan(input: BuildStartedHttpSpanInput): SpanRecord {
  return {
    stage: "started",
    hook_type: HookType.HTTP_REQUEST,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `HTTP ${input.method}`,
    kind: "CLIENT",
    start_time: input.startTimeNs,
    http_method: input.method,
    http_url: input.url,
    request_headers: redactHttpHeaders(input.requestHeaders),
    request_body: input.requestBody ?? null,
    attributes: httpAttributes(input.method, input.url),
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.HTTP_REQUEST]!]
  };
}

export interface BuildCompletedHttpSpanInput extends HttpSpanIdentity {
  readonly method: string;
  readonly url: string;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly durationNs: number;
  readonly statusCode?: number | null;
  readonly requestHeaders?: Readonly<Record<string, string>> | null;
  readonly requestBody?: string | null;
  readonly responseHeaders?: Readonly<Record<string, string>> | null;
  readonly responseBody?: string | null;
  /** Explicit error message (e.g. a thrown network error). `undefined` ⇒ derive from `statusCode`. */
  readonly error?: string | null;
}

/** Assemble the COMPLETED-stage `http_request` span (telemetry — after the real fetch settles or throws). */
export function buildCompletedHttpSpan(input: BuildCompletedHttpSpanInput): SpanRecord {
  return {
    stage: "completed",
    hook_type: HookType.HTTP_REQUEST,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `HTTP ${input.method}`,
    kind: "CLIENT",
    start_time: input.startTimeNs,
    end_time: input.endTimeNs,
    duration_ns: input.durationNs,
    http_method: input.method,
    http_url: input.url,
    http_status_code: input.statusCode ?? null,
    request_headers: redactHttpHeaders(input.requestHeaders),
    request_body: input.requestBody ?? null,
    response_headers: redactHttpHeaders(input.responseHeaders),
    response_body: input.responseBody ?? null,
    error: deriveHttpError(input.error, input.statusCode),
    attributes: httpAttributes(input.method, input.url),
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.HTTP_REQUEST]!]
  };
}
