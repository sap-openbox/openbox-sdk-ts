/**
 * Span contracts — `Stage`, `HookType`, and the flat Core `SpanData` field
 * matrices (common defaults + per-family root-field lists).
 *
 * Pure, import-safe module: no crypto, network, or OTel imports. Real Node
 * instrumentation (turning an actual OTel span into a flat wire dict) is a
 * later phase — this module only owns the STATIC shape tables that
 * `spans/core-span.ts` normalizes against.
 *
 * Field matrix is driven from the Core Go struct
 * (`openbox-core/internal/content/governance.go` `SpanData`, ~line 265-320),
 * not the SDK integration guide — the guide under-reports several root fields
 * (`request_headers`/`response_headers`/`semantic_type`/
 * `attribute_key_identifiers`/`lines_count`) that the Go struct and
 * governance/guardrails inspect.
 */

import type { JsonValue } from "./results.js";

/** Hook evaluation stage. */
export const Stage = {
  STARTED: "started",
  COMPLETED: "completed"
} as const;

export type Stage = (typeof Stage)[keyof typeof Stage];

/** Operation category of a hook span (Core root field `hook_type`). */
export const HookType = {
  HTTP_REQUEST: "http_request",
  DB_QUERY: "db_query",
  FILE_OPERATION: "file_operation",
  FUNCTION_CALL: "function_call",
  // Reserved; disabled until provider hooks are implemented.
  LLM_CALL: "llm_call",
  /** OpenRouter routing provenance — who served a model call (instrumentation/openrouter-provenance.ts). */
  LLM_PROVENANCE: "llm_provenance"
} as const;

export type HookType = (typeof HookType)[keyof typeof HookType];

/** A flat Core `SpanData` wire/in-memory dict (never nested `otel`/`openbox`/`data`). */
export type SpanRecord = Record<string, JsonValue>;

/**
 * Common root fields ALWAYS present on a normalized span — null-valued when
 * absent, never omitted. Mutable defaults (`attributes`/`status`/`events`) are
 * cloned per-span by `toCoreSpanData`, never shared by reference.
 *
 * `hook_type`/`semantic_type`/`attribute_key_identifiers` are guaranteed
 * present (null default) even though they are not computed here — Core
 * computes `semantic_type`; the SDK never sets it, it only guarantees the key
 * is never silently missing from the wire matrix.
 */
export const COMMON_SPAN_DEFAULTS: Readonly<Record<string, JsonValue>> = Object.freeze({
  span_id: "0".repeat(16),
  trace_id: "0".repeat(32),
  parent_span_id: null,
  name: "span",
  kind: "INTERNAL",
  start_time: null,
  end_time: null,
  duration_ns: null,
  attributes: {},
  status: Object.freeze({ code: "UNSET", description: null }),
  events: [],
  error: null,
  hook_type: null,
  semantic_type: null,
  attribute_key_identifiers: null
});

/**
 * Family-specific root fields that must exist (null-valued when unavailable)
 * so every hook span of a given family has the same flat key contract in
 * memory and on the wire. Keyed by `HookType` value; no entry for `llm_call`
 * (LLM calls are sent as HTTP spans per the integration guide).
 */
export const ROOT_FIELDS_BY_HOOK_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [HookType.HTTP_REQUEST]: [
    "http_method",
    "http_url",
    "http_status_code",
    "request_headers",
    "response_headers",
    "request_body",
    "response_body"
  ],
  [HookType.DB_QUERY]: [
    "db_system",
    "db_name",
    "db_operation",
    "db_statement",
    "server_address",
    "server_port",
    "rowcount"
  ],
  [HookType.FILE_OPERATION]: [
    "file_path",
    "file_mode",
    "file_operation",
    "bytes_read",
    "bytes_written",
    "lines_count"
  ],
  [HookType.FUNCTION_CALL]: ["function", "module", "args", "result"]
});

/**
 * Best-effort semantic fields per family — absence is an INFO diagnostic
 * (`SPAN_ATTR_MISSING`), never a rejection.
 */
export const SEMANTIC_FIELDS_BY_HOOK_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [HookType.HTTP_REQUEST]: ["http_method", "http_url"],
  [HookType.DB_QUERY]: ["db_system", "db_statement"],
  [HookType.FILE_OPERATION]: ["file_path", "file_operation"],
  [HookType.FUNCTION_CALL]: ["function", "module"]
});
