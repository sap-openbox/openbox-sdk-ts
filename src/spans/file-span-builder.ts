/**
 * `file_operation` family span assembly for the `fs.promises` (async) and
 * `node:fs` sync governance wrappers. Pure data-assembly — see
 * `http-span-builder.ts` for the module pattern this mirrors.
 *
 * No body/content field exists on the file family matrix
 * (`ROOT_FIELDS_BY_HOOK_TYPE.file_operation` — see `contracts/otel-spans.ts`):
 * only path/mode/operation and byte/line COUNTS. There is therefore nothing
 * here to redact or truncate — file spans never carry raw file content.
 *
 * File identity is mirrored in BOTH the flat Core root fields (`file_path`/
 * `file_mode`/`file_operation`) AND the OTel-native `attributes` sub-object
 * (`file.path`/`file.mode`/`file.operation`). Core and sibling SDKs read the
 * root fields; downstream OTel-style consumers read `attributes`. File and
 * http spans populate `attributes` at build time (function spans leave it for
 * `toCoreSpanData` to default to `{}`) because neither has an OTel span source
 * to hydrate it from later.
 */

import type { JsonValue } from "../contracts/results.js";
import { HookType, SEMANTIC_FIELDS_BY_HOOK_TYPE, type SpanRecord } from "../contracts/otel-spans.js";

export type FileOperationKind = "read" | "write";

/** `r` for reads, `w` for (destructive) writes — mirrors the root `file_mode` field. */
function fileMode(operation: FileOperationKind): "r" | "w" {
  return operation === "read" ? "r" : "w";
}

/** OTel-native attribute bag mirroring the flat file root fields. Never carries content. */
function fileAttributes(filePath: string, operation: FileOperationKind): Record<string, JsonValue> {
  return {
    "file.path": filePath,
    "file.mode": fileMode(operation),
    "file.operation": operation
  };
}

export interface FileSpanIdentity {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string | null;
}

export interface BuildStartedFileSpanInput extends FileSpanIdentity {
  readonly filePath: string;
  readonly operation: FileOperationKind;
  readonly startTimeNs: number;
}

/** Assemble the STARTED-stage `file_operation` span (preflight — before the fs call runs). */
export function buildStartedFileSpan(input: BuildStartedFileSpanInput): SpanRecord {
  return {
    stage: "started",
    hook_type: HookType.FILE_OPERATION,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `file.${input.operation}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    file_path: input.filePath,
    file_mode: fileMode(input.operation),
    file_operation: input.operation,
    attributes: fileAttributes(input.filePath, input.operation),
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]!]
  };
}

export interface BuildCompletedFileSpanInput extends FileSpanIdentity {
  readonly filePath: string;
  readonly operation: FileOperationKind;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly durationNs: number;
  readonly bytesRead?: number | null;
  readonly bytesWritten?: number | null;
  readonly error?: string | null;
}

/** Assemble the COMPLETED-stage `file_operation` span (telemetry — after the fs call settles or throws). */
export function buildCompletedFileSpan(input: BuildCompletedFileSpanInput): SpanRecord {
  return {
    stage: "completed",
    hook_type: HookType.FILE_OPERATION,
    span_id: input.spanId,
    trace_id: input.traceId,
    parent_span_id: input.parentSpanId ?? null,
    name: `file.${input.operation}`,
    kind: "INTERNAL",
    start_time: input.startTimeNs,
    end_time: input.endTimeNs,
    duration_ns: input.durationNs,
    file_path: input.filePath,
    file_mode: fileMode(input.operation),
    file_operation: input.operation,
    bytes_read: input.bytesRead ?? null,
    bytes_written: input.bytesWritten ?? null,
    error: input.error ?? null,
    attributes: fileAttributes(input.filePath, input.operation),
    attribute_key_identifiers: [...SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]!]
  };
}
