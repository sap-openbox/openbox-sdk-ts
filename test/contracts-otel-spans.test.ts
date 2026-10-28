import { describe, expect, it } from "vitest";

import {
  COMMON_SPAN_DEFAULTS,
  HookType,
  ROOT_FIELDS_BY_HOOK_TYPE,
  SEMANTIC_FIELDS_BY_HOOK_TYPE,
  Stage
} from "../src/contracts/otel-spans.js";

describe("Stage", () => {
  it("has exactly started/completed", () => {
    expect(Object.values(Stage).sort()).toStrictEqual(["completed", "started"]);
  });
});

describe("HookType", () => {
  it("has exactly the 6 operation categories", () => {
    expect(new Set(Object.values(HookType))).toStrictEqual(
      new Set(["http_request", "db_query", "file_operation", "function_call", "llm_call", "llm_provenance"])
    );
  });
});

describe("COMMON_SPAN_DEFAULTS", () => {
  it("defaults span_id/trace_id to all-zero hex of the correct length", () => {
    expect(COMMON_SPAN_DEFAULTS["span_id"]).toBe("0".repeat(16));
    expect(COMMON_SPAN_DEFAULTS["trace_id"]).toBe("0".repeat(32));
    expect(COMMON_SPAN_DEFAULTS["span_id"]).toMatch(/^[0-9a-f]{16}$/);
    expect(COMMON_SPAN_DEFAULTS["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("defaults the nullable identity/timestamp/semantic fields to null", () => {
    for (const field of [
      "parent_span_id",
      "start_time",
      "end_time",
      "duration_ns",
      "error",
      "hook_type",
      "semantic_type",
      "attribute_key_identifiers"
    ]) {
      expect(COMMON_SPAN_DEFAULTS[field]).toBeNull();
    }
  });

  it("defaults kind to INTERNAL and status to the UNSET shape", () => {
    expect(COMMON_SPAN_DEFAULTS["kind"]).toBe("INTERNAL");
    expect(COMMON_SPAN_DEFAULTS["status"]).toStrictEqual({ code: "UNSET", description: null });
  });

  it("defaults attributes/events to empty mutable containers", () => {
    expect(COMMON_SPAN_DEFAULTS["attributes"]).toStrictEqual({});
    expect(COMMON_SPAN_DEFAULTS["events"]).toStrictEqual([]);
  });
});

describe("ROOT_FIELDS_BY_HOOK_TYPE", () => {
  it("http family matches the Go struct HTTP + body/header fields", () => {
    expect(ROOT_FIELDS_BY_HOOK_TYPE[HookType.HTTP_REQUEST]).toStrictEqual([
      "http_method",
      "http_url",
      "http_status_code",
      "request_headers",
      "response_headers",
      "request_body",
      "response_body"
    ]);
  });

  it("db family matches the Go struct DB fields (server_address, not db_host)", () => {
    expect(ROOT_FIELDS_BY_HOOK_TYPE[HookType.DB_QUERY]).toStrictEqual([
      "db_system",
      "db_name",
      "db_operation",
      "db_statement",
      "server_address",
      "server_port",
      "rowcount"
    ]);
  });

  it("file family includes lines_count (Go struct field the SDK guide omits)", () => {
    expect(ROOT_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]).toStrictEqual([
      "file_path",
      "file_mode",
      "file_operation",
      "bytes_read",
      "bytes_written",
      "lines_count"
    ]);
  });

  it("function family uses the wire key `function`, not `func_name`", () => {
    expect(ROOT_FIELDS_BY_HOOK_TYPE[HookType.FUNCTION_CALL]).toStrictEqual([
      "function",
      "module",
      "args",
      "result"
    ]);
  });

  it("has no entry for llm_call (LLM calls are sent as HTTP spans)", () => {
    expect(ROOT_FIELDS_BY_HOOK_TYPE[HookType.LLM_CALL]).toBeUndefined();
  });
});

describe("SEMANTIC_FIELDS_BY_HOOK_TYPE", () => {
  it("covers the best-effort semantic fields per family", () => {
    expect(SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.HTTP_REQUEST]).toStrictEqual(["http_method", "http_url"]);
    expect(SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.DB_QUERY]).toStrictEqual(["db_system", "db_statement"]);
    expect(SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FILE_OPERATION]).toStrictEqual([
      "file_path",
      "file_operation"
    ]);
    expect(SEMANTIC_FIELDS_BY_HOOK_TYPE[HookType.FUNCTION_CALL]).toStrictEqual(["function", "module"]);
  });
});
