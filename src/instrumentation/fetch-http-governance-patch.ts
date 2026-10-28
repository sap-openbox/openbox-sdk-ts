/**
 * Global `fetch` governance patch — Tier A1 (Mastra parity).
 *
 * Preflight blocking here is a CUSTOM WRAPPER, never OTel (OTel cannot block
 * any Node driver — see plan Decision 15): wrap the real global, resolve the
 * bound `ActivityContext`, build the `http_request` span, `await
 * runtime.preflight(...)` BEFORE calling the original fetch, `runtime.completed(...)`
 * in `finally`. A preflight BLOCK/HALT throws out of `runtime.preflight` (see
 * `runtime/hook-evaluator.ts`), so the real network call below is provably
 * never reached.
 *
 * Recursion guard (both layers — see `recursion-guard.ts`):
 *  1. `isInternalCall()` — the SDK's own governance HTTP calls (client/index.ts,
 *     wrapped in `runAsInternal`) bypass unconditionally, checked FIRST.
 *  2. `isSameOrigin(url, apiUrl)` — exact-origin defense-in-depth backstop.
 * Deliberately absent: any "no active span/context ⇒ skip" shortcut. A
 * request with no bound `ActivityContext` still goes through the full
 * preflight/completed call (which itself skips per Decision 14 — see
 * `HookEvaluator`) and is additionally counted + diagnosed via
 * `getSpanlessGovernedRequestCount()`/a logger warning, so a detached
 * background fetch is never silently invisible.
 */

import type { ClientLogger } from "../client/index.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { buildCompletedHttpSpan, buildStartedHttpSpan } from "../spans/http-span-builder.js";
import {
  headersRecordFromFetchHeaders,
  isTextContentType,
  mintSpanId,
  mintTraceId,
  nowEpochNs
} from "./http-governance-shared.js";
import { scheduleOpenRouterProvenance } from "./openrouter-provenance.js";
import { isInternalCall, isSameOrigin } from "./recursion-guard.js";

/** Exported for direct unit testing of the best-effort failure path — not part of the package's public surface (this module is never re-exported from the package root). */
export interface Clonable {
  readonly headers: Headers;
  clone(): { text(): Promise<string> };
}

/** Best-effort text body capture via `.clone()` — never consumes the body the caller/wrapper still needs. */
export async function captureBodyText(clonable: Clonable): Promise<string | null> {
  if (!isTextContentType(clonable.headers.get("content-type"))) return null;
  try {
    const text = await clonable.clone().text();
    return text || null;
  } catch {
    return null; // best-effort — a body-read failure must never break governance
  }
}

export interface FetchHttpGovernancePatchOptions {
  readonly runtime: OpenBoxRuntime;
  readonly logger?: ClientLogger;
}

export interface FetchHttpGovernancePatchHandle {
  /** Restore the true original `globalThis.fetch`. Idempotent. */
  restore(): void;
  /** Governed (non-internal, non-api-origin) requests observed with no bound ActivityContext. */
  getSpanlessGovernedRequestCount(): number;
}

/**
 * Install the governed global `fetch` patch. Performs exactly one install and
 * returns a restore handle; fail-loud prototype assertions and idempotency
 * across repeated `initOpenBoxInstrumentation()` calls are the caller's job
 * (`src/instrumentation/index.ts`).
 */
export function installFetchHttpGovernancePatch(
  options: FetchHttpGovernancePatchOptions
): FetchHttpGovernancePatchHandle {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    // Fail-loud detection point — the strict-vs-diagnostic POLICY decision
    // belongs to the caller (src/instrumentation/index.ts); this function
    // only detects and reports the unpatchable condition. Node >=24.10.0
    // (this package's engines floor) always has a global `fetch`, so this is
    // a defensive check, not an expected runtime condition.
    throw new Error("global fetch is not available — cannot install HTTP governance");
  }
  const { runtime } = options;
  const logger = options.logger ?? console;
  let spanlessCount = 0;
  let restored = false;

  async function openBoxGovernedFetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> {
    // Unconditional bypass FIRST, before any URL parsing — the SDK's own
    // evaluate/approval/auth-validate calls run on this path constantly.
    if (isInternalCall()) return originalFetch(input, init);

    const request = new Request(input, init);
    const url = request.url;

    // Exact-origin defense-in-depth backstop (never startsWith/includes).
    if (isSameOrigin(url, runtime.config.apiUrl)) {
      return originalFetch(request);
    }

    if (runtime.contextStore.currentActivityContext() === null) {
      spanlessCount += 1;
      logger.warn(
        `OpenBox: outbound fetch to ${url} has no bound ActivityContext — hook governance for this ` +
          "request is skipped, not blocked (Decision 14). If this is unexpected, verify the call " +
          "happens inside an activityScope()."
      );
    }

    const spanId = mintSpanId();
    const traceId = mintTraceId();
    const startTimeNs = nowEpochNs();
    const requestHeaders = headersRecordFromFetchHeaders(request.headers);
    const requestBody = await captureBodyText(request);

    // BLOCK/HALT throws here — `originalFetch` below is provably never reached.
    await runtime.preflight({
      spans: [
        buildStartedHttpSpan({
          spanId,
          traceId,
          method: request.method,
          url,
          startTimeNs,
          requestHeaders,
          requestBody
        })
      ]
    });

    let response: Response;
    try {
      response = await originalFetch(request);
    } catch (error) {
      const endTimeNs = nowEpochNs();
      const message = error instanceof Error ? error.message : String(error);
      // `completed()` never throws (see HookEvaluator) — safe with no extra try/catch.
      await runtime.completed({
        spans: [
          buildCompletedHttpSpan({
            spanId,
            traceId,
            method: request.method,
            url,
            startTimeNs,
            endTimeNs,
            durationNs: endTimeNs - startTimeNs,
            requestHeaders,
            requestBody,
            error: message
          })
        ]
      });
      throw error;
    }

    const endTimeNs = nowEpochNs();
    const responseHeaders = headersRecordFromFetchHeaders(response.headers);
    const responseBody = await captureBodyText(response);

    // Telemetry only — the response is already final; this can never undo it.
    await runtime.completed({
      spans: [
        buildCompletedHttpSpan({
          spanId,
          traceId,
          method: request.method,
          url,
          startTimeNs,
          endTimeNs,
          durationNs: endTimeNs - startTimeNs,
          statusCode: response.status,
          requestHeaders,
          requestBody,
          responseHeaders,
          responseBody
        })
      ]
    });

    // Routing provenance for OpenRouter calls: runs after the answer, off its
    // critical path, inside this activity's scope. No-op for any other host.
    scheduleOpenRouterProvenance({
      runtime,
      logger,
      fetchImpl: originalFetch,
      url,
      authorization: request.headers.get("authorization"),
      requestBody,
      responseBody,
      traceId,
      parentSpanId: spanId
    });

    return response;
  }

  globalThis.fetch = openBoxGovernedFetch;

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      globalThis.fetch = originalFetch;
    },
    getSpanlessGovernedRequestCount(): number {
      return spanlessCount;
    }
  };
}
