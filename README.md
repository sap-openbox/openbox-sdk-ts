# @openbox-ai/openbox-sdk-ts

The OpenBox TypeScript **base SDK** — a contract-driven governance client for
Node/TS agent frameworks. It signs and sends governance events to OpenBox
Core, enforces verdicts (`allow` / `constrain` / `require_approval` / `block`
/ `halt`), and gives framework SDKs (Mastra, and future adapters) a shared,
hardened foundation instead of each reimplementing signing, validation, and
instrumentation. It plays the same role for the TypeScript SDK family that
`openbox-sdk-python` plays for Python.

## Status

Contract-driven, not framework-driven: behavior is reproduced from the
canonical OpenBox Core wire contract and the hardened Python base SDK, then
verified against ported golden fixtures **and** a real Core-parity gate — a Go
harness that unmarshals TS-emitted payloads into Core's own `SpanData` struct
and independently verifies Ed25519 signatures. See
[`docs/source-of-truth.md`](docs/source-of-truth.md) and
[`docs/contract-conflict-ledger.md`](docs/contract-conflict-ledger.md) for the
full source hierarchy and every documented conflict + resolution.

This is a `0.1.x` release: the wire contract, signing, config, client,
runtime, and Tier A1 Node instrumentation (fetch/fs/functions) are
implemented and tested. Database instrumentation (Tier A2/B) has
[documented coverage gaps](docs/instrumentation-coverage.md) — most notably,
`redis` blocking covers `client.sendCommand([...])` only; normal typed usage
(`.get()`, `.set()`, ...) is neither blocked nor observed. Read the
limitations before relying on this for defense-in-depth blocking.

## What it owns

Contracts, layered config, identity/signing, an HTTP client, an always-strict
validation gate, a runtime/context composition root, span builders and wire
projection, hook evaluation, Node instrumentation, and a conformance kit for
testing adapters built on top of it. A framework SDK consumes this package and
keeps only its own lifecycle mapping (a thin adapter) — see
[`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md).

## Install

```bash
npm install @openbox-ai/openbox-sdk-ts
```

Requires Node.js `>=24.10.0`. See [`docs/installation.md`](docs/installation.md)
for optional peer drivers (`pg`, `redis`, `mysql2`, `mongodb`) and the
import-light root guarantee.

## Quick start

### Config → runtime → evaluate

`OpenBoxRuntime` is the recommended entry point: it owns the low-level
`OpenBoxClient`, the always-strict validation gate, and your
`FrameworkAdapter`, and it enforces the verdict for you (throws on
BLOCK/HALT, drives approval on REQUIRE_APPROVAL). See
[why the client alone isn't enough](docs/framework-adapter-guide.md#fail-closed-on-auth-must-be-enforced-at-the-adapter-wrapper-layer)
before wiring `OpenBoxClient` directly in your own code.

```ts
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { Verdict, workflowStarted } from "@openbox-ai/openbox-sdk-ts";

const config = OpenBoxConfig.resolve({
  apiUrl: "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY! // "obx_live_..." or "obx_test_..."
});

const runtime = new OpenBoxRuntime(config);

// Throws GovernanceBlockedError/GovernanceHaltError on BLOCK/HALT; awaits the
// adapter's approval flow on REQUIRE_APPROVAL. Reaching the next line means
// governance let the workflow proceed.
const result = await runtime.evaluateLifecycle(
  workflowStarted({ workflowId: "wf-1", runId: "run-1", workflowType: "order-fulfillment" })
);
console.log(result.verdict); // e.g. Verdict.ALLOW

runtime.close();
```

Building a framework adapter rather than calling the SDK directly? Read
[`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md) first —
it covers implementing `FrameworkAdapter`, driving hooks via
`ContextStore.activityScope`, and a fail-closed pitfall that is easy to
reintroduce at the wrapper layer.

### Okta AI Agent identity (`okta_ai_agent`)

An agent whose OpenBox identity is verified against an Okta AI Agent credential
signs every request with an RS256 assertion. That assertion binds seven values
OpenBox Core already owns, so the runtime does **not** configure them — it fetches
them from Core after authenticating with its API key:

```dotenv
OPENBOX_API_URL=https://core.example.com
OPENBOX_API_KEY=obx_live_...
OPENBOX_OKTA_AGENT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
```

That is the complete configuration. The private key is the only value Core can
never supply — **OpenBox never receives, stores, or returns it.** Everything else
(agent id, organization id, deployment id, assertion audience, external Okta agent
id, credential `kid`, algorithm) comes from `GET /api/v2/auth/bootstrap` on first
use and is cached in memory for the lifetime of the client.

Before the first governed request the SDK derives its private key's RFC 7638
public-key thumbprint and compares it with the one Core reports for the agent's
selected credential. A mismatch fails immediately with actionable guidance rather
than sending an assertion that could only be rejected:

> The configured private key does not match the selected Okta credential for this
> OpenBox agent. Export the private key associated with the selected credential,
> or rotate the agent credential.

**Authority metadata.** The bootstrap document must carry Core's IAM-aware
`authority` object (active assignment, provider generation, identity, credential,
projection version). A Core deployment that predates it fails closed, with guidance
to upgrade Core or supply the complete explicit configuration below — even though the
document's `bootstrap_version` is still `1`.

**Credential rotation.** Long-running agents can refresh explicitly:

```ts
const document = await runtime.client.refreshIdentityMetadata();
console.log(document.okta.credentialKid, document.authority.generationNumber);
```

The refresh drops the current identity *first*, then bootstraps again and re-runs the
authority and thumbprint checks. A credential that rotated to a key this process does
not hold therefore fails loudly **and leaves no stale signer behind**: later requests
bootstrap again and stay blocked until one succeeds. An older in-flight bootstrap can
never overwrite a newer refresh. The SDK never refreshes automatically after an auth
failure: rotation may have selected a new public key while the process still holds
the old private key, and a silent retry would hide that rather than fix it.

**Requirements.** The key must be a PKCS8 PEM RSA key of at least 2048 bits, and
its public half must already be registered in Okta for the selected credential.

**Explicit configuration** (every metadata field set locally) remains supported for
compatibility. The two styles cannot be mixed: a configuration carrying only *some*
metadata fields is rejected, naming the offending fields, rather than quietly
merging stale local values over what Core would have supplied. If Core answers
`404`, the SDK reports that the deployment predates bootstrap and asks you to
upgrade Core or supply the complete explicit configuration — it never downgrades to
an unsigned request or to a different identity method.

### Keycloak workload identity (`keycloak_workload`, IAM v3)

With IAM v3 the OpenBox API key still identifies the agent, and a short-lived
Keycloak workload token proves the agent's active service account. The runtime
needs exactly one additional secret — the service account's RSA private key:

```dotenv
OPENBOX_API_URL=https://core.example.com
OPENBOX_API_KEY=obx_live_...
OPENBOX_AGENT_IDENTITY_METHOD=keycloak_workload   # recommended: a missing key is then an error
OPENBOX_WORKLOAD_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
```

```ts
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

const config = OpenBoxConfig.resolve({ identityMethod: "keycloak_workload", onApiError: "fail_closed" });
const client = OpenBoxClient.fromConfig(config); // or: new OpenBoxRuntime(config)
await client.validateApiKey();
```

Everything else — token endpoint, issuer, audience, client id, key id, service
account, activation version, identity source (`openbox`, `okta`, or `entra`) — comes
from `GET /api/v3/auth/bootstrap`; there is no local setting for any of it. On first
use (and on every renewal) the client fetches that document, validates it strictly,
signs a one-minute RS256 `private_key_jwt`, exchanges it at Keycloak's token endpoint
(`client_credentials`; no API key, proof header, or secret ever reaches Keycloak),
and sends every request to `/api/v3/*` with `Authorization: Bearer <API key>` plus
`X-OpenBox-Workload-Token: <token>`.

- **Fixed to v3.** Selecting workload mode fixes the client to v3 before its first
  request. A bootstrap `404`, a `409 workload_identity_unavailable`, a Keycloak
  rejection, or any outage throws `OpenBoxWorkloadAuthError` (an `OpenBoxAuthError`
  with `stage`, `httpStatus`, `reasonCode`) — never a v1/v2 or API-key-only request,
  and never a fail-open ALLOW, under any `onApiError`. A v3 non-retryable `4xx`
  (malformed payload, missing route) — or a redirect, which no v3 request ever
  follows, so the workload token never reaches another host — is a contract error
  that throws; network
  failures and `5xx`/`408`/`429` after successful authentication keep `onApiError`.
- **Renewal.** Tokens are cached per client for at most 300 s and renewed 30 s before
  that; each renewal re-fetches bootstrap, so a new activation is picked up without a
  restart. A refresh-due token is never used, even when renewal fails. Concurrent
  operations share one acquisition. A runtime `401`/`403` discards the token and the
  next operation bootstraps again; the rejected operation is not replayed.
- **Metadata and refresh.** `client.workloadIdentityMetadata()` returns the
  immutable, non-secret document behind the current usable token (or `null`);
  `await client.refreshWorkloadIdentity()` invalidates immediately and re-acquires.
  A different private key needs a new client after the managed transition.
- **Select the method explicitly.** Without `identityMethod: "keycloak_workload"`,
  a missing key means legacy API-key-only mode; with it, a missing key fails locally.
  A blank env var (empty or whitespace-only) counts as unset, so an empty
  `OPENBOX_<PREFIX>_WORKLOAD_PRIVATE_KEY=` falls through to
  `OPENBOX_WORKLOAD_PRIVATE_KEY` instead of shadowing it.
- **Okta-sourced agents** moved to workload authentication may keep their key in
  `OPENBOX_OKTA_AGENT_PRIVATE_KEY` as a migration alias, but only with an explicit
  `identityMethod: "keycloak_workload"` (and only once the same public key is
  registered for the active service account). An Okta key alone keeps Okta v2 mode;
  both keys together, DID fields, or leftover Okta metadata are rejected locally.
- **Candidate proof.** After a workload transition is prepared through the existing
  management flow, prove the candidate key (it is never the active key, never stored,
  and never activates anything):

  ```ts
  await runtime.client.proveWorkloadIdentityTransition({ transitionId, candidatePrivateKey });
  ```

The key must be a PKCS8 PEM RSA key of at least 2048 bits. See
[`docs/source-of-truth.md`](docs/source-of-truth.md#iam-v3-workload-contract-summary)
for the wire contract and the intentional differences from the Python SDK.

### Shutdown

`runtime.close()` closes the runtime's client — including a client injected via
`new OpenBoxRuntime(config, { client })` — dropping cached tokens, identity metadata,
and key references, aborting in-flight workload acquisition, and rejecting later
sends. Consumers sharing one client must coordinate shutdown. `client.close()` is
idempotent and synchronous; it cannot zeroize strings your own configuration still
holds.

### Opt-in Node instrumentation

`initOpenBoxInstrumentation` installs governance patches for `fetch`,
`node:http`/`node:https` (preflight-blockable, same as fetch — covers
axios/got/node-fetch@2/superagent and other `node:http`-based clients that Node's
undici `fetch` bypasses), `fs.promises` (async, preflight-blockable), sync `fs`
(`readFileSync`/`writeFileSync`/`mkdirSync`, completed-hook telemetry only — see
the coverage doc), `traced()`-wrapped functions, and (opt-in per driver) `pg`,
`redis`, `mysql2`, `mongodb`. `instrumentation.httpEnabled` toggles fetch +
node:http + node:https together, and `instrumentation.fileEnabled` toggles both
the async and sync file hooks together. Nothing is patched on import — only
inside this call, and only for drivers you name:

```ts
import { initOpenBoxInstrumentation } from "@openbox-ai/openbox-sdk-ts/instrumentation";

const instrumentation = initOpenBoxInstrumentation({
  runtime,
  databases: ["pg"] // explicit opt-in — never auto-detected
});

// later, on shutdown — await flush() first so the last sync-fs completed-hook
// telemetry (which the sync wrapper fires after returning) is not dropped.
await instrumentation.flush();
instrumentation.shutdown();
```

See [`docs/instrumentation-coverage.md`](docs/instrumentation-coverage.md) for
exactly what each target blocks vs. passes through unblocked (the `redis` and
`mongodb` gaps in particular).

### OpenRouter routing provenance

With the instrumentation installed, a governed `fetch` to `openrouter.ai` made
inside an activity also reports which upstream provider served it. After the
response arrives, the SDK sends Core an `llm_provenance` span carrying
`gen_ai.generation.id`, the upstream provider and served model, cost and token
usage, finish reason, and whether the requested model and `provider.only`
routing were honoured (`gen_ai.*`, `openbox.routing.*`, `openbox.model.*`). The
dashboard's Provenance tab, shown for agents whose workflow engine is OpenRouter,
aggregates these spans. Attribute names match the Python base SDK.

- The lookup runs after the answer, off its critical path, and reuses the call's
  own `Authorization` header — no extra key is needed.
- OpenRouter's generation record (data region, latency, fallback attempts) is
  published late, so it is tried within a 12-second budget (`LOOKUP_BUDGET_MS`);
  when it is not ready, the provenance in the completion response itself is
  sent. A lookup rejected by OpenRouter (401/403/5xx) is logged with its status.
- `OpenBoxClient.evaluate` waits for the closing session's own pending lookups
  before `WorkflowCompleted` / `WorkflowFailed`, because Core does not record
  spans that arrive after the session closes. A lookup never keeps the process
  alive on its own; await `drainOpenRouterProvenance()` (from
  `@openbox-ai/openbox-sdk-ts/instrumentation`) before exiting a process that
  does not close its sessions.
- Framework SDKs with their own hook pipeline can call
  `scheduleOpenRouterProvenance({ session, send, ... })` instead of relying on
  the built-in `fetch` patch.
- Set `OPENBOX_OPENROUTER_PROVENANCE=false` to turn it off.

## Public exports

The package root is intentionally **import-light**: it re-exports only pure
contracts and errors (no crypto, network, or OpenTelemetry), so
`import "@openbox-ai/openbox-sdk-ts"` has zero side effects. Everything else is a
subpath, added as real consumers need it.

| Import | Contents |
|---|---|
| `@openbox-ai/openbox-sdk-ts` | `SDK_VERSION`; `Verdict` + verdict helpers; `EvaluationResult`/`ApprovalResult`/`GuardrailsResult`; `EventEnvelope`/`EventType` + event factories (`workflowStarted`, `activityStarted`, `hook`, `handoff`, ...); span field matrices + diagnostics; `ActivityContext`; the full error hierarchy (incl. `OpenBoxWorkloadAuthError`); identity configuration types (`AgentIdentityMethod`, ...); strict gate helpers (`prepareLifecyclePayload`, `prepareHookPayload`, ...) |
| `@openbox-ai/openbox-sdk-ts/adapters` | `FrameworkAdapter` interface + the default `CoreAdapter` |
| `@openbox-ai/openbox-sdk-ts/approvals` | `ApprovalPoller` — HITL poll-loop orchestration |
| `@openbox-ai/openbox-sdk-ts/client` | `OpenBoxClient` — the governance HTTP client (`fromConfig`, `evaluate`/`pollApproval`/`validateApiKey`/`sendHandoff`, identity metadata/refresh, transition proofs, `close`) |
| `@openbox-ai/openbox-sdk-ts/config` | `OpenBoxConfig` — layered env resolution + validation |
| `@openbox-ai/openbox-sdk-ts/conformance` | `FakeCore`/`FakeAdapter`, scenario matrices, wire-shape assertions (test utility, not a frozen API) |
| `@openbox-ai/openbox-sdk-ts/context` | `ContextStore` — per-runtime `AsyncLocalStorage` activity binding |
| `@openbox-ai/openbox-sdk-ts/identity` | `AgentIdentity` + Ed25519 signing primitives |
| `@openbox-ai/openbox-sdk-ts/instrumentation` | `initOpenBoxInstrumentation`, `traced()`, recursion-guard helpers |
| `@openbox-ai/openbox-sdk-ts/runtime` | `OpenBoxRuntime` composition root + `HookEvaluator` |
| `@openbox-ai/openbox-sdk-ts/package.json` | Raw package metadata (for tooling) |

## Documentation

- [`docs/installation.md`](docs/installation.md) — install, engine
  requirement, optional DB peers.
- [`docs/framework-adapter-guide.md`](docs/framework-adapter-guide.md) — how
  to build a framework adapter on top of this SDK.
- [`docs/adapter-checklist.md`](docs/adapter-checklist.md) — a checklist for
  future TS SDKs adopting this base.
- [`docs/instrumentation-coverage.md`](docs/instrumentation-coverage.md) —
  exactly what Node instrumentation blocks vs. passes through.
- [`docs/source-of-truth.md`](docs/source-of-truth.md) and
  [`docs/contract-conflict-ledger.md`](docs/contract-conflict-ledger.md) — the
  source hierarchy this SDK is verified against, and every documented
  contract conflict + resolution.
- [`CHANGELOG.md`](CHANGELOG.md).

## Development

```bash
npm install
npm run lint         # eslint (flat, type-checked)
npm run typecheck    # tsc --noEmit
npm run test         # vitest + v8 coverage
npm run build        # tsup (ESM, bundle:false, dts)
npm run pack:check   # npm pack --dry-run
npm run import:check # asserts the built root stays import-light
npm run interop:core        # TS ↔ Core IAM v3 gate: Core's real v3 verifiers via `go test -overlay`
npm run interop:core:packed # same gate, from npm-packed tarballs in an isolated consumer
```

The interop gate needs a Go toolchain and an IAM v3 `openbox-core` checkout
(`../openbox-core`, or `--core <dir>` / `OPENBOX_CORE_DIR`); it never modifies that
checkout. It runs with controlled authority fixtures and a controlled Keycloak
issuer — it is not a deployed Core/Keycloak/Backend run.

## License

MIT — see [`LICENSE`](LICENSE).
