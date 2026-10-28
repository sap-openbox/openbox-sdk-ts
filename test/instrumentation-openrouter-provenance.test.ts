import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxClient } from "../src/client/index.js";
import { OpenBoxConfig } from "../src/config/index.js";
import { FakeAdapter, FakeCore } from "../src/conformance/index.js";
import { ContextStore } from "../src/context/index.js";
import { ActivityContext } from "../src/contracts/context.js";
import { installFetchHttpGovernancePatch } from "../src/instrumentation/fetch-http-governance-patch.js";
import {
  DRAIN_TIMEOUT_MS,
  LOOKUP_BUDGET_MS,
  drainOpenRouterProvenance,
  extractGenerationId,
  extractRequestedRouting,
  fetchGenerationRecord,
  isModelHonored,
  isRoutingHonored,
  normalizeGenerationRecord,
  pendingOpenRouterProvenanceCount,
  provenanceAttributes,
  recordFromResponse,
  scheduleOpenRouterProvenance
} from "../src/instrumentation/openrouter-provenance.js";
import { OpenBoxRuntime } from "../src/runtime/index.js";

const GEN_ID = "gen-1761-abcDEF_01";
const REQUEST_BODY = JSON.stringify({
  model: "openai/gpt-4o-mini",
  provider: { only: ["openai"], order: ["openai", "azure"], allow_fallbacks: false }
});
const RESPONSE_BODY = JSON.stringify({
  id: GEN_ID,
  provider: "OpenAI",
  model: "openai/gpt-4o-mini-2024-07-18",
  choices: [{ finish_reason: "stop", message: { content: "hi" } }],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    cost: 0.0001,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0.00008 }
  }
});
const GENERATION_RECORD = {
  data: {
    id: GEN_ID,
    provider_name: "OpenAI",
    model: "openai/gpt-4o-mini-2024-07-18",
    data_region: "global",
    total_cost: 0.0001,
    upstream_inference_cost: 0.00008,
    tokens_prompt: 12,
    tokens_completion: 3,
    latency: 640,
    finish_reason: "stop",
    is_byok: false,
    provider_responses: [
      { provider_name: "Azure", status: 429, latency: 90 },
      { provider_name: "OpenAI", status: 200, latency: 550 }
    ]
  }
};

const silentLogger = { warn() {}, error() {}, info() {} };

function recordingLogger() {
  const lines: string[] = [];
  const push = (message: string) => {
    lines.push(message);
  };
  return { lines, logger: { warn: push, error: push, info: push } };
}

describe("record shaping", () => {
  it("reads the generation id from JSON and from an SSE stream", () => {
    expect(extractGenerationId(RESPONSE_BODY)).toBe(GEN_ID);
    expect(extractGenerationId(`data: {"id":"${GEN_ID}","choices":[]}\n\ndata: [DONE]\n`)).toBe(GEN_ID);
    expect(extractGenerationId('{"id":"chatcmpl-1"}')).toBeNull();
    expect(extractGenerationId(null)).toBeNull();
  });

  it("reads the requested routing", () => {
    expect(extractRequestedRouting(REQUEST_BODY)).toEqual({
      model: "openai/gpt-4o-mini",
      only: ["openai"],
      order: ["openai", "azure"],
      allowFallbacks: false
    });
    expect(extractRequestedRouting("not json")).toEqual({});
  });

  it("checks routing and model promises", () => {
    const requested = extractRequestedRouting(REQUEST_BODY);
    expect(isRoutingHonored("OpenAI", requested)).toBe(true);
    expect(isRoutingHonored("Azure", requested)).toBe(false);
    expect(isRoutingHonored("OpenAI", {})).toBeNull();
    expect(isModelHonored("openai/gpt-4o-mini-2024-07-18", requested)).toBe(true);
    expect(isModelHonored("mistralai/mistral-large", requested)).toBe(false);
    expect(isModelHonored("openai/gpt-4o", { model: "openrouter/auto" })).toBeNull();
  });

  it("flattens the generation record into attributes", () => {
    const attrs = provenanceAttributes(
      normalizeGenerationRecord(GEN_ID, GENERATION_RECORD, extractRequestedRouting(REQUEST_BODY))
    );
    expect(attrs["gen_ai.generation.id"]).toBe(GEN_ID);
    expect(attrs["gen_ai.upstream.provider"]).toBe("OpenAI");
    expect(attrs["gen_ai.upstream.data_region"]).toBe("global");
    expect(attrs["gen_ai.routing.fallback_attempts"]).toBe(2);
    expect(attrs["gen_ai.routing.providers_tried"]).toEqual(["Azure", "OpenAI"]);
    expect(attrs["openbox.routing.honored"]).toBe(true);
    expect(attrs["openbox.model.honored"]).toBe(true);
  });

  it("builds a response-only record without record-only fields or nulls", () => {
    const attrs = provenanceAttributes(recordFromResponse(GEN_ID, RESPONSE_BODY, {})!);
    expect(attrs["gen_ai.upstream.provider"]).toBe("OpenAI");
    expect(attrs["gen_ai.usage.total_cost"]).toBe(0.0001);
    expect(attrs["gen_ai.usage.upstream_cost"]).toBe(0.00008);
    expect(attrs["gen_ai.response.finish_reason"]).toBe("stop");
    expect(attrs["gen_ai.upstream.is_byok"]).toBe(false);
    expect(attrs).not.toHaveProperty("gen_ai.upstream.data_region");
    expect(attrs).not.toHaveProperty("gen_ai.routing.attempts");
    expect(Object.values(attrs)).not.toContain(null);
  });

  it("reads provenance from an SSE stream", () => {
    const sse = [
      `data: {"id":"${GEN_ID}","provider":"OpenAI","model":"openai/gpt-4o-mini","choices":[]}`,
      `data: {"id":"${GEN_ID}","choices":[{"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}}`,
      "data: [DONE]"
    ].join("\n");
    const record = recordFromResponse(GEN_ID, sse, {})!;
    expect(record.provider).toBe("OpenAI");
    expect(record.finishReason).toBe("tool_calls");
    expect(record.tokensCompletion).toBe(2);
  });
});

describe("generation lookup", () => {
  const lookup = (status: number, seen: string[] = []) =>
    (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(input instanceof Request ? input.url : input.toString());
      return new Response(JSON.stringify(status === 200 ? GENERATION_RECORD : { error: "x" }), { status });
    }) as typeof fetch;

  it("returns the record when found", async () => {
    const result = await fetchGenerationRecord(GEN_ID, "Bearer k", "https://openrouter.ai", Date.now() + 5_000, lookup(200), silentLogger);
    expect(result.outcome).toBe("found");
    expect(result.record).toEqual(GENERATION_RECORD);
  });

  it("logs a rejected lookup with its HTTP status instead of calling it late", async () => {
    const { lines, logger } = recordingLogger();
    const result = await fetchGenerationRecord(GEN_ID, "Bearer k", "https://openrouter.ai", Date.now() + 5_000, lookup(401), logger);
    expect(result).toEqual({ record: null, outcome: "rejected" });
    expect(lines.join("\n")).toContain("HTTP 401");
  });

  it("stays inside its budget", async () => {
    const seen: string[] = [];
    const started = Date.now();
    const result = await fetchGenerationRecord(GEN_ID, "Bearer k", "https://openrouter.ai", started + 1_000, lookup(404, seen), silentLogger);
    expect(result.outcome).toBe("late");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen).toHaveLength(2); // at 0 s and 0.5 s; the 1 s pause would pass the deadline
  });

  it("makes no request once the budget is spent", async () => {
    const seen: string[] = [];
    const result = await fetchGenerationRecord(GEN_ID, "Bearer k", "https://openrouter.ai", Date.now() - 1, lookup(200, seen), silentLogger);
    expect(result.outcome).toBe("late");
    expect(seen).toEqual([]);
  });

  it("drains for longer than a lookup can take", () => {
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThan(LOOKUP_BUDGET_MS);
  });
});

describe("through the governed fetch", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function setUp(generationStatus: number, onLookup?: () => Promise<void>) {
    const lookups: string[] = [];
    globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/api/v1/generation")) {
        lookups.push(url);
        if (onLookup) await onLookup();
        return new Response(JSON.stringify(GENERATION_RECORD), { status: generationStatus });
      }
      return new Response(RESPONSE_BODY, { status: 200, headers: { "content-type": "application/json" } });
    };
    const fakeCore = new FakeCore();
    const config = OpenBoxConfig.resolve({ apiUrl: "https://core.test", apiKey: "obx_test_prov" });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, { fetchImpl: fakeCore.fetchImpl, logger: silentLogger });
    const contextStore = new ContextStore();
    const runtime = new OpenBoxRuntime(config, { client, adapter: new FakeAdapter(), contextStore, logger: silentLogger });
    const handle = installFetchHttpGovernancePatch({ runtime, logger: silentLogger });
    return { fakeCore, client, contextStore, handle, lookups };
  }

  const ctx = (runId: string) =>
    new ActivityContext({ workflowId: "wf-1", runId, activityId: "act-1", activityType: "llm_call" });
  const callModel = () =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-or-test", "content-type": "application/json" },
      body: REQUEST_BODY
    });
  const provenanceSpans = (fakeCore: FakeCore) =>
    fakeCore.evaluateRequests
      .flatMap((r) => ((r.bodyJson as { spans?: Record<string, unknown>[] }).spans ?? []))
      .filter((span) => span["hook_type"] === "llm_provenance");

  it("sends an llm_provenance span for the activity and drains before the closing event", async () => {
    const { fakeCore, client, contextStore, handle, lookups } = setUp(200);
    await contextStore.activityScope(ctx("run-1"), async () => {
      await (await callModel()).text();
    });

    await client.evaluate({ event_type: "WorkflowCompleted", workflow_id: "wf-1", run_id: "run-1" });

    expect(lookups).toHaveLength(1);
    const [span] = provenanceSpans(fakeCore);
    expect(span?.["name"]).toBe("served by OpenAI (openai/gpt-4o-mini-2024-07-18)");
    expect((span?.["attributes"] as Record<string, unknown>)["gen_ai.upstream.data_region"]).toBe("global");
    // The span reached Core before the closing event.
    const types = fakeCore.evaluateRequests.map((r) => (r.bodyJson as { event_type?: string }).event_type);
    expect(types.at(-1)).toBe("WorkflowCompleted");
    expect(pendingOpenRouterProvenanceCount()).toBe(0);
    handle.restore();
  });

  it("falls back to the response's own provenance when the lookup is rejected", async () => {
    const { fakeCore, contextStore, handle } = setUp(403);
    await contextStore.activityScope(ctx("run-2"), async () => {
      await (await callModel()).text();
    });
    await drainOpenRouterProvenance({ workflowId: "wf-1", runId: "run-2" });
    const [span] = provenanceSpans(fakeCore);
    const attrs = span?.["attributes"] as Record<string, unknown>;
    expect(attrs["gen_ai.upstream.provider"]).toBe("OpenAI");
    expect(attrs).not.toHaveProperty("gen_ai.upstream.data_region");
    handle.restore();
  });

  it("closing one session does not wait for another session's lookup", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, contextStore, handle } = setUp(200, () => blocked);
    await contextStore.activityScope(ctx("run-slow"), async () => {
      await (await callModel()).text();
    });
    const started = Date.now();
    await client.evaluate({ event_type: "WorkflowCompleted", workflow_id: "wf-1", run_id: "run-other" });
    expect(Date.now() - started).toBeLessThan(500);
    release();
    await drainOpenRouterProvenance();
    expect(pendingOpenRouterProvenanceCount()).toBe(0);
    handle.restore();
  });

  it("does nothing for other hosts or outside an activity", async () => {
    const { fakeCore, contextStore, handle } = setUp(200);
    await (await callModel()).text(); // no bound activity
    await contextStore.activityScope(ctx("run-3"), async () => {
      await (await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" })).text();
    });
    await drainOpenRouterProvenance();
    expect(provenanceSpans(fakeCore)).toEqual([]);
    handle.restore();
  });

  it("is off when OPENBOX_OPENROUTER_PROVENANCE=false", async () => {
    process.env["OPENBOX_OPENROUTER_PROVENANCE"] = "false";
    try {
      const { fakeCore, contextStore, handle } = setUp(200);
      await contextStore.activityScope(ctx("run-4"), async () => {
        await (await callModel()).text();
      });
      await drainOpenRouterProvenance();
      expect(provenanceSpans(fakeCore)).toEqual([]);
      handle.restore();
    } finally {
      delete process.env["OPENBOX_OPENROUTER_PROVENANCE"];
    }
  });
});

describe("with a framework SDK's own hook pipeline (session + send)", () => {
  it("sends the span through the caller and is drained by session", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async () => new Response(JSON.stringify(GENERATION_RECORD), { status: 200 })) as typeof fetch;
    scheduleOpenRouterProvenance({
      session: { workflowId: "wf-fw", runId: "run-fw" },
      send: async (span) => {
        sent.push(span);
      },
      logger: silentLogger,
      fetchImpl,
      url: "https://openrouter.ai/api/v1/chat/completions",
      authorization: "Bearer sk-or-test",
      requestBody: REQUEST_BODY,
      responseBody: RESPONSE_BODY,
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16)
    });
    await drainOpenRouterProvenance({ workflowId: "wf-fw", runId: "run-fw" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.["hook_type"]).toBe("llm_provenance");
    expect(sent[0]?.["stage"]).toBe("completed");
    expect(sent[0]?.["parent_span_id"]).toBe("b".repeat(16));
    expect(pendingOpenRouterProvenanceCount({ workflowId: "wf-fw", runId: "run-fw" })).toBe(0);
  });
});
