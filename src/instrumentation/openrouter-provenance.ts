/**
 * OpenRouter routing provenance — which provider actually served each call.
 *
 * OpenRouter picks the serving provider per request. Two sources say which one
 * it was:
 *
 * - the completion response itself (JSON or SSE): `provider`, `model`,
 *   `usage.cost`, `usage.is_byok`, token counts, finish reason — available
 *   immediately;
 * - the generation record at `GET /api/v1/generation?id=<gen-id>`, which adds
 *   the data region, latency and every fallback attempt — but is published
 *   late, measured on live anywhere from a few seconds to over a minute.
 *
 * For each governed `fetch` to OpenRouter made inside an activity, this module
 * reads the response, tries the generation record within a fixed budget, and
 * sends Core one completed hook span carrying `gen_ai.generation.id` plus the
 * `gen_ai.*` / `openbox.*` attributes below — from the record when it arrived
 * in time, otherwise from the response alone. Core classifies such a span as
 * `llm_provenance` and the dashboard's Provenance tab aggregates it. Attribute
 * names match the OpenRouter TypeScript SDK and the Python base SDK.
 *
 * The work runs after the model call has returned, off its critical path, and
 * is best-effort: nothing here ever throws into the caller. Lookups are tracked
 * per session; `client.evaluate` waits for the closing session's own lookups
 * before sending WorkflowCompleted/WorkflowFailed, because Core does not record
 * spans that arrive after the session closes. A lookup's own timers are
 * unref'd, so an abandoned lookup never keeps the process alive; an awaited
 * drain does, until it finishes or times out. Await
 * `drainOpenRouterProvenance()` before exiting a process that does not close
 * its sessions.
 */

import type { ClientLogger } from "../client/index.js";
import { HookType, Stage, type SpanRecord } from "../contracts/otel-spans.js";
import type { JsonValue } from "../contracts/results.js";
import type { OpenBoxRuntime } from "../runtime/openbox-runtime.js";
import { mintSpanId, nowEpochNs } from "./http-governance-shared.js";
import { runAsInternal } from "./recursion-guard.js";

const OPENROUTER_HOSTS = new Set(["openrouter.ai"]);
const GENERATION_PATH = "/api/v1/generation";
/** The record is written after the response: an immediate lookup 404s. */
const BACKOFF_MS = [500, 1_000, 2_000, 3_000, 4_000] as const;
const ATTEMPT_TIMEOUT_MS = 4_000;
/**
 * Hard cap on one lookup — retries, backoff and request timeouts included —
 * counted from the end of the model call, so a backlog only shortens it. When
 * it runs out the response-derived record is sent instead.
 */
export const LOOKUP_BUDGET_MS = 12_000;
/** A closing event waits this long for its session: the budget plus time to send the span. */
export const DRAIN_TIMEOUT_MS = LOOKUP_BUDGET_MS + 5_000;
const GENERATION_ID = /"id"\s*:\s*"(gen-[A-Za-z0-9_-]+)"/;

export interface ProviderAttempt {
  provider: string | null;
  status: number | string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface RequestedRouting {
  model?: string;
  models?: string[];
  only?: string[];
  order?: string[];
  allowFallbacks?: boolean;
}

export interface RoutingProvenance {
  generationId: string;
  provider: string | null;
  model: string | null;
  dataRegion: string | null;
  totalCost: number | null;
  upstreamCost: number | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  isByok: boolean | null;
  attempts: ProviderAttempt[];
  requested: RequestedRouting;
  honored: boolean | null;
  modelHonored: boolean | null;
}

type GenerationOutcome = "found" | "late" | "rejected";

function provenanceEnabled(): boolean {
  const value = (process.env["OPENBOX_OPENROUTER_PROVENANCE"] ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

/** True for a call to OpenRouter that is not itself a generation lookup. */
export function isOpenRouterCall(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      OPENROUTER_HOSTS.has(parsed.hostname.toLowerCase()) &&
      !parsed.pathname.startsWith(GENERATION_PATH)
    );
  } catch {
    return false;
  }
}

/** The `gen-…` id of a completion, from a JSON body or an SSE stream. */
export function extractGenerationId(
  responseBody: string | null
): string | null {
  if (!responseBody) return null;
  try {
    const data: unknown = JSON.parse(responseBody);
    if (
      isRecord(data) &&
      typeof data["id"] === "string" &&
      data["id"].startsWith("gen-")
    )
      return data["id"];
  } catch {
    // SSE or partial body — fall through to the pattern.
  }
  return GENERATION_ID.exec(responseBody)?.[1] ?? null;
}

/** What the caller asked for: model, model fallbacks, provider routing. */
export function extractRequestedRouting(
  requestBody: string | null
): RequestedRouting {
  let data: unknown;
  try {
    data = JSON.parse(requestBody ?? "");
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const requested: RequestedRouting = {};
  if (typeof data["model"] === "string") requested.model = data["model"];
  if (Array.isArray(data["models"]))
    requested.models = data["models"].map(String);
  const provider = data["provider"];
  if (isRecord(provider)) {
    if (Array.isArray(provider["only"]))
      requested.only = provider["only"].map(String);
    if (Array.isArray(provider["order"]))
      requested.order = provider["order"].map(String);
    if (typeof provider["allow_fallbacks"] === "boolean")
      requested.allowFallbacks = provider["allow_fallbacks"];
  }
  return requested;
}

function sameProvider(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}

/** True/false against a `provider.only` allowlist; null when none was named. */
export function isRoutingHonored(
  provider: string | null,
  requested: RequestedRouting
): boolean | null {
  if (!requested.only || requested.only.length === 0 || provider === null)
    return null;
  return requested.only.some((allowed) => sameProvider(provider, allowed));
}

/** Did the model that ran match one the caller named? null for auto-routing. */
export function isModelHonored(
  model: string | null,
  requested: RequestedRouting
): boolean | null {
  const asked = requested.model;
  if (model === null || !asked || asked.startsWith("openrouter/auto"))
    return null;
  const base = (value: string) => value.toLowerCase().split(":", 1)[0] ?? "";
  // OpenRouter reports dated snapshots (`openai/gpt-4o-mini-2024-07-18`).
  return [asked, ...(requested.models ?? [])].some(
    (named) =>
      base(model) === base(named) || base(model).startsWith(`${base(named)}-`)
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten OpenRouter's generation record into the fields we attest. */
export function normalizeGenerationRecord(
  generationId: string,
  raw: unknown,
  requested: RequestedRouting
): RoutingProvenance {
  const root = isRecord(raw) ? raw : {};
  const record = isRecord(root["data"]) ? root["data"] : root;
  const attempts: ProviderAttempt[] = [];
  const responses = record["provider_responses"];
  if (Array.isArray(responses)) {
    for (const entry of responses) {
      if (!isRecord(entry)) continue;
      const status = entry["status"];
      attempts.push({
        provider:
          asString(entry["provider_name"]) ?? asString(entry["provider"]),
        status:
          typeof status === "number" || typeof status === "string"
            ? status
            : null,
        latencyMs: asNumber(entry["latency"]),
        error: asString(entry["error"])
      });
    }
  }
  const provider = asString(record["provider_name"]);
  const model = asString(record["model"]);
  return {
    generationId,
    provider,
    model,
    dataRegion: asString(record["data_region"]),
    totalCost: asNumber(record["total_cost"]),
    upstreamCost: asNumber(record["upstream_inference_cost"]),
    tokensPrompt: asNumber(record["tokens_prompt"]),
    tokensCompletion: asNumber(record["tokens_completion"]),
    latencyMs: asNumber(record["latency"]),
    finishReason: asString(record["finish_reason"]),
    isByok: typeof record["is_byok"] === "boolean" ? record["is_byok"] : null,
    attempts,
    requested,
    honored: isRoutingHonored(provider, requested),
    modelHonored: isModelHonored(model, requested)
  };
}

/** The JSON object(s) of a completion response: one body, or SSE chunks. */
function responseChunks(responseBody: string): Record<string, unknown>[] {
  try {
    const data: unknown = JSON.parse(responseBody);
    return isRecord(data) ? [data] : [];
  } catch {
    // SSE: one JSON object per `data:` line.
  }
  const chunks: Record<string, unknown>[] = [];
  for (const rawLine of responseBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const chunk: unknown = JSON.parse(line.slice(5).trim());
      if (isRecord(chunk)) chunks.push(chunk);
    } catch {
      // `[DONE]` and keep-alives.
    }
  }
  return chunks;
}

/**
 * What the completion response itself says about who served it. Same shape as
 * `normalizeGenerationRecord`; region, latency and the attempt trail are only
 * in the generation record, so they stay null here.
 */
export function recordFromResponse(
  generationId: string,
  responseBody: string | null,
  requested: RequestedRouting
): RoutingProvenance | null {
  const chunks = responseChunks(responseBody ?? "");
  if (chunks.length === 0) return null;
  let provider: string | null = null;
  let model: string | null = null;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> = {};
  for (const chunk of chunks) {
    provider = asString(chunk["provider"]) ?? provider;
    model = asString(chunk["model"]) ?? model;
    if (isRecord(chunk["usage"])) usage = chunk["usage"];
    const choices = chunk["choices"];
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (isRecord(choice) && asString(choice["finish_reason"]))
          finishReason = choice["finish_reason"] as string;
      }
    }
  }
  if (provider === null && model === null) return null;
  const costDetails = isRecord(usage["cost_details"])
    ? usage["cost_details"]
    : {};
  return {
    generationId,
    provider,
    model,
    dataRegion: null,
    totalCost: asNumber(usage["cost"]),
    upstreamCost: asNumber(costDetails["upstream_inference_cost"]),
    tokensPrompt: asNumber(usage["prompt_tokens"]),
    tokensCompletion: asNumber(usage["completion_tokens"]),
    latencyMs: null,
    finishReason,
    isByok: typeof usage["is_byok"] === "boolean" ? usage["is_byok"] : null,
    attempts: [],
    requested,
    honored: isRoutingHonored(provider, requested),
    modelHonored: isModelHonored(model, requested)
  };
}

/** Flat, stable span attributes. Nulls are dropped, never sent as null. */
export function provenanceAttributes(
  p: RoutingProvenance
): Record<string, JsonValue> {
  const attrs: Record<string, JsonValue> = {
    "gen_ai.generation.id": p.generationId
  };
  const put = (key: string, value: JsonValue | undefined) => {
    if (value !== null && value !== undefined) attrs[key] = value;
  };
  put("gen_ai.upstream.provider", p.provider);
  put("gen_ai.response.model", p.model);
  put("gen_ai.upstream.data_region", p.dataRegion);
  put("gen_ai.usage.total_cost", p.totalCost);
  put("gen_ai.usage.upstream_cost", p.upstreamCost);
  put("gen_ai.usage.tokens_prompt", p.tokensPrompt);
  put("gen_ai.usage.tokens_completion", p.tokensCompletion);
  put("gen_ai.upstream.latency_ms", p.latencyMs);
  put("gen_ai.response.finish_reason", p.finishReason);
  put("gen_ai.upstream.is_byok", p.isByok);
  if (p.attempts.length > 0) {
    attrs["gen_ai.routing.fallback_attempts"] = p.attempts.length;
    attrs["gen_ai.routing.providers_tried"] = p.attempts
      .map((a) => a.provider)
      .filter((name): name is string => name !== null);
    attrs["gen_ai.routing.attempts"] = p.attempts.map((a) => ({
      provider: a.provider,
      status: a.status,
      latency_ms: a.latencyMs,
      error: a.error
    }));
  }
  put("openbox.routing.requested_only", p.requested.only);
  put("openbox.routing.requested_order", p.requested.order);
  put("openbox.routing.allow_fallbacks", p.requested.allowFallbacks);
  put("openbox.routing.honored", p.honored);
  put("openbox.model.requested", p.requested.model);
  put("openbox.model.honored", p.modelHonored);
  return attrs;
}

/** An unref'd sleep: never keeps the process alive on its own. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** OpenRouter's generation record, retried on 404 until the deadline. */
export async function fetchGenerationRecord(
  generationId: string,
  authorization: string,
  baseUrl: string,
  deadline: number,
  fetchImpl: typeof fetch,
  logger: ClientLogger
): Promise<{ record: unknown; outcome: GenerationOutcome }> {
  const url = `${baseUrl}${GENERATION_PATH}?id=${encodeURIComponent(generationId)}`;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      const pause = BACKOFF_MS[attempt - 1] ?? 0;
      if (Date.now() + pause >= deadline) break;
      await sleep(pause);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.min(ATTEMPT_TIMEOUT_MS, remaining)
    );
    timer.unref?.();
    try {
      const response = await runAsInternal(() =>
        fetchImpl(url, {
          method: "GET",
          headers: { authorization },
          signal: controller.signal
        })
      );
      if (response.status === 404) continue; // not written yet
      if (response.status !== 200) {
        // 401/403 mean the key cannot read generation records; 5xx is
        // OpenRouter's side. Either way, say so rather than "late".
        logger.warn(
          `OpenRouter generation lookup for ${generationId} failed: HTTP ${response.status}`
        );
        return { record: null, outcome: "rejected" };
      }
      const record: unknown = await response.json();
      return { record, outcome: "found" };
    } catch {
      continue; // transient — the backoff is the retry
    } finally {
      clearTimeout(timer);
    }
  }
  return { record: null, outcome: "late" };
}

// Pending lookups per session (`${workflowId}\0${runId}`).
const pending = new Map<string, Set<Promise<void>>>();

function sessionKey(
  workflowId: string | null | undefined,
  runId: string | null | undefined
): string {
  return `${workflowId ?? ""}\u0000${runId ?? ""}`;
}

export interface ScheduleOpenRouterProvenanceOptions {
  /**
   * Base runtime: the session comes from its bound activity and the span is
   * sent with `runtime.completed`. Framework SDKs with their own hook pipeline
   * pass `session` and `send` instead.
   */
  readonly runtime?: OpenBoxRuntime;
  /** The activity's session, when not using `runtime`. */
  readonly session?: { readonly workflowId: string | null; readonly runId: string | null };
  /** Sends the completed provenance span, when not using `runtime`. */
  readonly send?: (span: SpanRecord) => Promise<unknown>;
  readonly logger: ClientLogger;
  /** The un-patched fetch, so the lookup is never itself governed. */
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly authorization: string | null;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly traceId: string;
  readonly parentSpanId: string;
}

/**
 * Start collecting provenance for one completed OpenRouter call. No-op unless
 * the call went to OpenRouter inside a bound activity and the response carried
 * a generation id. Returns immediately; must be called inside the caller's
 * activity scope so the span is attributed to that activity.
 */
export function scheduleOpenRouterProvenance(
  options: ScheduleOpenRouterProvenanceOptions
): void {
  if (!provenanceEnabled() || !isOpenRouterCall(options.url)) return;
  let session: { workflowId: string | null; runId: string | null };
  let send: (span: SpanRecord) => Promise<unknown>;
  if (options.runtime !== undefined) {
    const runtime = options.runtime;
    const context = runtime.contextStore.currentActivityContext();
    if (context === null || !context.activityId || !context.activityType) return;
    session = { workflowId: context.workflowId, runId: context.runId };
    send = (span) => runtime.completed({ spans: [span] });
  } else if (options.session !== undefined && options.send !== undefined) {
    session = options.session;
    send = options.send;
  } else {
    return;
  }
  const generationId = extractGenerationId(options.responseBody);
  if (generationId === null || !options.authorization) return;

  const requested = extractRequestedRouting(options.requestBody);
  const fromResponse = recordFromResponse(
    generationId,
    options.responseBody,
    requested
  );
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const key = sessionKey(session.workflowId, session.runId);
  const baseUrl = new URL(options.url).origin;
  const authorization = options.authorization;

  const task = (async () => {
    try {
      const { record, outcome } = await fetchGenerationRecord(
        generationId,
        authorization,
        baseUrl,
        deadline,
        options.fetchImpl,
        options.logger
      );
      let provenance: RoutingProvenance;
      if (record !== null) {
        provenance = normalizeGenerationRecord(generationId, record, requested);
      } else if (fromResponse !== null) {
        if (outcome === "late") {
          options.logger.info(
            `generation record for ${generationId} not published in time — sending the response's own provenance`
          );
        }
        provenance = fromResponse;
      } else {
        options.logger.warn(
          `routing provenance unavailable for ${generationId} — no generation record (${outcome}) and none in the response`
        );
        return;
      }
      await send(provenanceSpan(provenance, options));
    } catch (error) {
      options.logger.warn(
        `routing provenance failed for ${generationId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  })();

  let group = pending.get(key);
  if (group === undefined) {
    group = new Set();
    pending.set(key, group);
  }
  group.add(task);
  void task.finally(() => {
    const current = pending.get(key);
    current?.delete(task);
    if (current !== undefined && current.size === 0) pending.delete(key);
  });
}

function provenanceSpan(
  p: RoutingProvenance,
  options: ScheduleOpenRouterProvenanceOptions
): SpanRecord {
  let name = `served by ${p.provider ?? "an unreported provider"}`;
  if (p.model) name += ` (${p.model})`;
  const endTimeNs = nowEpochNs();
  const durationNs =
    p.latencyMs !== null ? Math.round(p.latencyMs * 1_000_000) : null;
  return {
    span_id: mintSpanId(),
    trace_id: options.traceId,
    parent_span_id: options.parentSpanId,
    name,
    kind: "CLIENT",
    start_time: durationNs !== null ? endTimeNs - durationNs : endTimeNs,
    end_time: endTimeNs,
    duration_ns: durationNs,
    attributes: provenanceAttributes(p),
    status: { code: "OK", description: null },
    hook_type: HookType.LLM_PROVENANCE,
    stage: Stage.COMPLETED
  };
}

/**
 * Wait (bounded) for outstanding provenance lookups. With a workflow/run id,
 * only that session's — what a session's closing event needs. Without them,
 * every pending lookup, e.g. before process exit.
 */
export async function drainOpenRouterProvenance(
  session?: { workflowId?: string | null; runId?: string | null },
  timeoutMs: number = DRAIN_TIMEOUT_MS
): Promise<void> {
  const tasks =
    session === undefined
      ? [...pending.values()].flatMap((group) => [...group])
      : [...(pending.get(sessionKey(session.workflowId, session.runId)) ?? [])];
  if (tasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    // Deliberately NOT unref'd: someone is awaiting this drain, and the
    // lookups' own timers are unref'd, so without a ref'd timer here Node
    // would see nothing pending and exit mid-run. Bounded by `timeoutMs`.
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(tasks), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: number of lookups pending, per session or overall. */
export function pendingOpenRouterProvenanceCount(session?: {
  workflowId?: string | null;
  runId?: string | null;
}): number {
  if (session === undefined)
    return [...pending.values()].reduce((sum, group) => sum + group.size, 0);
  return pending.get(sessionKey(session.workflowId, session.runId))?.size ?? 0;
}
