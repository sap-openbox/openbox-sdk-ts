import { describe, expect, it } from "vitest";

import { HookType } from "../src/contracts/otel-spans.js";
import {
  DEFAULT_SENSITIVE_HTTP_HEADERS,
  buildCompletedHttpSpan,
  buildStartedHttpSpan,
  redactHttpHeaders
} from "../src/spans/http-span-builder.js";
import { toCoreSpanData } from "../src/spans/core-span.js";

const IDENTITY = { spanId: "a".repeat(16), traceId: "b".repeat(32) };

describe("buildStartedHttpSpan", () => {
  it("populates the http_request family wire keys for the started stage", () => {
    const span = buildStartedHttpSpan({
      ...IDENTITY,
      method: "POST",
      url: "https://example.com/charge",
      startTimeNs: 1_000,
      requestHeaders: { "content-type": "application/json" },
      requestBody: '{"amount":10}'
    });
    expect(span["stage"]).toBe("started");
    expect(span["hook_type"]).toBe(HookType.HTTP_REQUEST);
    expect(span["span_id"]).toBe(IDENTITY.spanId);
    expect(span["trace_id"]).toBe(IDENTITY.traceId);
    expect(span["http_method"]).toBe("POST");
    expect(span["http_url"]).toBe("https://example.com/charge");
    expect(span["start_time"]).toBe(1_000);
    expect(span["request_body"]).toBe('{"amount":10}');
    expect(span["request_headers"]).toStrictEqual({ "content-type": "application/json" });
    // Started stage never sets end_time/duration_ns itself — toCoreSpanData fills the explicit nulls.
    expect(span).not.toHaveProperty("end_time");
    expect(span).not.toHaveProperty("duration_ns");
  });

  it("normalizes cleanly through toCoreSpanData (flat, correct family keys, explicit started nulls)", () => {
    const span = buildStartedHttpSpan({ ...IDENTITY, method: "GET", url: "https://x.test", startTimeNs: 5 });
    const { wireSpan } = toCoreSpanData(span);
    expect(wireSpan["end_time"]).toBeNull();
    expect(wireSpan["duration_ns"]).toBeNull();
    expect(wireSpan["http_status_code"]).toBeNull();
    expect(wireSpan["response_body"]).toBeNull();
  });

  it("sets attribute_key_identifiers to the http semantic field list", () => {
    const span = buildStartedHttpSpan({ ...IDENTITY, method: "GET", url: "https://x.test", startTimeNs: 1 });
    expect(span["attribute_key_identifiers"]).toStrictEqual(["http_method", "http_url"]);
  });

  it("carries the request method and full URL as OTel attributes, as the Python SDK does", () => {
    const span = buildStartedHttpSpan({ ...IDENTITY, method: "POST", url: "https://x.test/v1", startTimeNs: 1 });
    expect(span["attributes"]).toStrictEqual({ "http.request.method": "POST", "url.full": "https://x.test/v1" });
    expect(toCoreSpanData(span).wireSpan["attributes"]).toStrictEqual({
      "http.request.method": "POST",
      "url.full": "https://x.test/v1"
    });
  });

  it("null request fields when absent (never a forced empty object/string)", () => {
    const span = buildStartedHttpSpan({ ...IDENTITY, method: "GET", url: "https://x.test", startTimeNs: 1 });
    expect(span["request_headers"]).toBeNull();
    expect(span["request_body"]).toBeNull();
  });
});

describe("buildCompletedHttpSpan", () => {
  it("populates the http_request family wire keys for the completed stage", () => {
    const span = buildCompletedHttpSpan({
      ...IDENTITY,
      method: "GET",
      url: "https://example.com/x",
      startTimeNs: 1_000,
      endTimeNs: 1_500,
      durationNs: 500,
      statusCode: 200,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok"
    });
    expect(span["attributes"]).toStrictEqual({ "http.request.method": "GET", "url.full": "https://example.com/x" });
    expect(span["stage"]).toBe("completed");
    expect(span["end_time"]).toBe(1_500);
    expect(span["duration_ns"]).toBe(500);
    expect(span["http_status_code"]).toBe(200);
    expect(span["response_body"]).toBe("ok");
    expect(span["error"]).toBeNull();
  });

  it("derives error from a >=400 status code when no explicit error is given", () => {
    const span = buildCompletedHttpSpan({
      ...IDENTITY,
      method: "GET",
      url: "https://example.com/x",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      statusCode: 404
    });
    expect(span["error"]).toBe("HTTP 404");
  });

  it("prefers an explicit error over the derived-from-status-code one", () => {
    const span = buildCompletedHttpSpan({
      ...IDENTITY,
      method: "GET",
      url: "https://example.com/x",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      statusCode: 500,
      error: "socket hang up"
    });
    expect(span["error"]).toBe("socket hang up");
  });

  it("a network failure (no status code) carries the explicit error and a null status", () => {
    const span = buildCompletedHttpSpan({
      ...IDENTITY,
      method: "GET",
      url: "https://example.com/x",
      startTimeNs: 0,
      endTimeNs: 1,
      durationNs: 1,
      error: "ECONNREFUSED"
    });
    expect(span["error"]).toBe("ECONNREFUSED");
    expect(span["http_status_code"]).toBeNull();
  });
});

describe("redactHttpHeaders — default credential redaction (Decision 16)", () => {
  it("redacts every known sensitive header case-insensitively, regardless of user config", () => {
    const redacted = redactHttpHeaders({
      Authorization: "Bearer secret-token",
      "X-API-Key": "abc123",
      Cookie: "session=xyz",
      "content-type": "application/json"
    });
    expect(redacted?.["Authorization"]).toBe("[REDACTED]");
    expect(redacted?.["X-API-Key"]).toBe("[REDACTED]");
    expect(redacted?.["Cookie"]).toBe("[REDACTED]");
    expect(redacted?.["content-type"]).toBe("application/json"); // untouched
  });

  it("passes null/undefined through untouched", () => {
    expect(redactHttpHeaders(null)).toBeNull();
    expect(redactHttpHeaders(undefined)).toBeNull();
  });

  it("the default sensitive set covers the documented credential/auth headers", () => {
    for (const name of [
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "api-key",
      "x-auth-token",
      "x-amz-security-token"
    ]) {
      expect(DEFAULT_SENSITIVE_HTTP_HEADERS.has(name)).toBe(true);
    }
  });

  it("this default redaction applies even when the caller's PrivacyConfig.redactKeys is empty", () => {
    // http-span-builder never reads PrivacyConfig at all — this default is unconditional.
    const span = buildStartedHttpSpan({
      ...IDENTITY,
      method: "GET",
      url: "https://x.test",
      startTimeNs: 1,
      requestHeaders: { authorization: "Bearer secret" }
    });
    expect((span["request_headers"] as Record<string, string>)["authorization"]).toBe("[REDACTED]");
  });
});
