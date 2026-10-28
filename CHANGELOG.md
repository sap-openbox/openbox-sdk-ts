# Changelog

All notable changes to `@openbox-ai/openbox-sdk-ts` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-10-28

### Added

- OpenRouter routing provenance. After a governed `fetch` to `openrouter.ai`
  completes inside an activity, the SDK sends an `llm_provenance` span carrying
  the generation id, upstream provider, served model, cost, token usage, finish
  reason and requested-vs-honored routing (`gen_ai.*`, `openbox.routing.*`,
  `openbox.model.*`). It looks up OpenRouter's generation record within a
  fixed 12-second budget (`LOOKUP_BUDGET_MS`, counted from the end of the
  model call) and otherwise sends the provenance in the completion response
  itself; a rejected lookup (401/403/5xx) is logged with its status. Attribute
  names match the Python base SDK and the OpenRouter TypeScript SDK. Disable
  with `OPENBOX_OPENROUTER_PROVENANCE=false`.
- `HookType.LLM_PROVENANCE`, and `drainOpenRouterProvenance()` plus the record
  helpers exported from `@openbox-ai/openbox-sdk-ts/instrumentation`.

### Changed

- `OpenBoxClient.evaluate` waits for the closing session's own pending
  provenance lookups before sending `WorkflowCompleted` / `WorkflowFailed`
  (bounded by `DRAIN_TIMEOUT_MS`), since Core drops spans that arrive after the
  session closes. Other sessions' lookups are not waited on. Lookup timers are
  unref'd, so they never keep the process alive; await
  `drainOpenRouterProvenance()` before exiting a process that does not close
  its sessions.

## [2.1.0] - 2026-10-01

### Fixed

- Approval polling keeps Node alive while a governed operation awaits a decision,
  preventing an early exit with an unsettled top-level await warning. Cancellation
  still clears the polling timer and rejects the wait immediately.

## [2.0.0] - 2026-09-29

Major release: the v2 bootstrap parser, v2 refresh semantics, runtime shutdown,
and blank env-var handling change externally visible behavior.

### Added

- **IAM v3 Keycloak workload identity (`keycloak_workload`).** A new
  `workloadPrivateKey` option (`OPENBOX_WORKLOAD_PRIVATE_KEY`, framework-prefixed
  first) or an explicit `identityMethod: "keycloak_workload"` fixes a client to
  contract v3 before its first request. The client fetches
  `GET /api/v3/auth/bootstrap`, signs a one-minute RS256 `private_key_jwt`, exchanges
  it at the advertised Keycloak token endpoint, and sends
  `/api/v3/{auth/validate,governance/evaluate,governance/approval,handoffs}` with the
  API key plus `X-OpenBox-Workload-Token`. Tokens are cached per client (≤ 300 s,
  renewed 30 s early, one shared acquisition, bootstrap re-fetched on every renewal);
  a runtime 401/403 invalidates the token without replay. Failures throw the new
  `OpenBoxWorkloadAuthError` (`stage`, `httpStatus`, `reasonCode`) and never fall back
  to v1/v2, API-key-only requests, or a fail-open ALLOW; v3 non-retryable 4xx are
  contract errors. No v3 request follows a redirect — bootstrap, token exchange, or
  runtime call — so the workload token never reaches another host; a runtime
  redirect is a contract error. New client methods: `workloadIdentityMetadata()`,
  `refreshWorkloadIdentity()`, `proveWorkloadIdentityTransition({ transitionId,
  candidatePrivateKey })`. The Okta private key is accepted as a migration alias only
  under an explicit `keycloak_workload` selection.
- **`OpenBoxClient.fromConfig(config, { fetchImpl?, logger? })`** — the shared
  config → client mapping used by `OpenBoxRuntime` and framework adapters. It
  re-validates identity-mode exclusivity, so `validate: false` never skips mode or
  key checks.
- **`OpenBoxClient.close()`** — idempotent, synchronous release of cached tokens,
  identity metadata, and key references; later sends are rejected.
- Root exports: `OpenBoxWorkloadAuthError` and the identity configuration types
  (`AgentIdentityMethod`, `KeycloakWorkloadIdentityConfig`, ...). `FakeCore` answers
  and records Keycloak token-endpoint requests (`queueWorkloadToken`, `tokenRequests`).
- `npm run interop:core` / `interop:core:packed` — TS ↔ Core IAM v3 gate running
  Core's real v3 router and verifiers via `go test -overlay`.

### Changed

- **BREAKING — Okta v2 bootstrap requires Core's `authority` object**
  (`assignment_id`, `provider_generation_id`, positive `generation_number`,
  `activation_version`, `identity_id`, `credential_id`, `projection_version`). Core
  deployments that predate it fail closed; upgrade Core or use the complete explicit
  Okta configuration.
- **BREAKING — `refreshIdentityMetadata()` no longer keeps the previous identity on
  failure.** The current identity is dropped first; a failed refresh leaves later
  requests blocked until a bootstrap succeeds. An older in-flight bootstrap can no
  longer overwrite a newer refresh.
- **BREAKING — `OpenBoxRuntime.close()` closes its client, including an injected one.**
  Consumers sharing a client must coordinate shutdown.
- **BREAKING — a blank environment variable counts as unset.** An empty or
  whitespace-only `OPENBOX_<PREFIX>_*` / `OPENBOX_*` value now falls through to the
  next layer instead of shadowing it — e.g. an empty
  `OPENBOX_<PREFIX>_WORKLOAD_PRIVATE_KEY=` no longer hides `OPENBOX_WORKLOAD_PRIVATE_KEY`
  and silently leaves the agent in API-key-only mode. A blank `OPENBOX_TIMEOUT_SECONDS`
  now means the 30 s default instead of a config error. Explicit values are unchanged.
- `OpenBoxRuntime` builds its default client with `OpenBoxClient.fromConfig`.
- `OpenBoxClient` serializes/inspects as a redacted summary (never the API key,
  private keys, or tokens).
- `AgentIdentityTransitionCandidate` is explicitly limited to the DID and Okta variants.

- **Governed `node:http` / `node:https` instrumentation with full preflight
  blocking.** `initOpenBoxInstrumentation` now patches
  `http.request`/`http.get`/`https.request`/`https.get` beside `fetch`, closing
  the gap where libraries built on `node:http` (axios, got, node-fetch@2,
  superagent) bypassed governance entirely — Node's undici `fetch` does not
  traverse `node:http`. Because `http.request()` returns synchronously, the patch
  returns a deferred stand-in `ClientRequest` that buffers the request, runs
  `runtime.preflight(...)` on `end()`, and creates the real request only on ALLOW,
  so a BLOCK/HALT verdict stops the request **before any byte reaches the
  network** (parity with `fetch`). Request + response text bodies are captured
  (best-effort, capped at `privacy.maxBodySize`) and credential headers redacted.
  All three HTTP surfaces share the existing `instrumentation.httpEnabled` toggle
  (no new config field) and surface as `"http"`/`"https"` in `installedTargets`.
  The completed hook fires detached (after the response ends), so it is drained by
  the controller's `flush()` alongside sync-fs telemetry. XHR is out of scope
  (Node has no `XMLHttpRequest`). See
  [`docs/instrumentation-coverage.md`](docs/instrumentation-coverage.md) for the
  blocked-vs-pass-through matrix (`CONNECT`/`upgrade`/`http2` are pass-through).

### Changed

- **Package renamed to `@openbox-ai/openbox-sdk-ts`** (previously
  `@openbox-ai/openbox-sdk`, last published as `0.1.1`). Update dependencies and
  imports to the new name; subpath exports are unchanged
  (`@openbox-ai/openbox-sdk-ts/client`, `.../runtime`, ...). Releases up to
  `0.1.2` in this changelog shipped under the old name.

## [1.0.1] - 2026-07-17

`@openbox-ai/openbox-copilotkit@0.4.0` migration prerequisites — three
base-SDK fixes/hardenings its adapter depends on.

### Fixed

- **`activityCompleted` emitted the activity output under the wrong wire
  key.** The lifecycle event wrote `payload["result"]`, but Core reads
  `activity_output` (`ActivityOutput json:"activity_output"`; no
  payload-level `result` tag), so every activity output was silently dropped
  on ingestion. `activityStarted`'s `activity_input` was already correct —
  this was an asymmetric bug on the output side, also inherited by
  `openbox-langchain-sdk-ts`. Fixed to write `payload["activity_output"]`;
  the ergonomic option name `result` is unchanged. (The unrelated
  `function_call` **span** field `result`, in `otel-spans`, was already
  correct and stays untouched.)

### Added

- **Cancellable `ApprovalPoller`** — a controller shutdown can now abort an
  in-flight approval wait instead of leaking it. `ApprovalPollerOptions`
  gains an optional `abortSignal` (constructor option; `waitForDecision`'s
  signature is unchanged, so the stock `CoreAdapter` is unaffected). The
  internal poll-loop `sleep` is now abort-aware and `unref`'d — it rejects
  immediately on abort instead of pinning the process or waiting out the
  full interval. `OpenBoxClient.pollApproval` gains an optional `signal`
  parameter, composed with the request timeout via `AbortSignal.any([...])`,
  so the in-flight fetch is aborted too. An abort surfaces as a fail-safe
  `ApprovalRejectedError` ("approval wait aborted (shutdown) — failing
  safe") — distinct from the existing poll-error→`null`→retry path, so a
  shutdown can never be mistaken for a transient poll failure and silently
  retried.

### Changed

- **`ContextStore` abort/halt keys are now per-run — a breaking `ContextStore`
  API change.** The aborted-activity set was keyed `(workflowId,
  activityId)`, so two runs of the same workflow reusing an `activityId`
  could cross-suppress each other's activity; it is now keyed `(workflowId,
  runId, activityId)`. `markActivityAborted`/`isActivityAborted`/
  `clearActivityAborted` all take an additional `runId` parameter. HALT was
  a single process-wide `haltFlag` boolean; it is now tracked per run.
  `requestHalt(workflowId, runId)` and the new `isHaltRequested(workflowId,
  runId)` replace the old no-arg `requestHalt()` and the `haltRequested`
  getter. `hook-evaluator.ts` and `openbox-runtime.ts` (the only in-repo
  consumers) are updated accordingly. Accepted as a coordinated `1.0.1`
  change since the base API only reached `1.0.0` in the previous release and
  this package has no other in-repo readers yet. A new
  `clearHalt(workflowId, runId)` (mirroring `clearActivityAborted`) lets a
  consumer drop a run's HALT entry on run terminal so `haltedRuns` stays
  bounded on a long-lived runtime; there is deliberately no FIFO eviction for
  HALT (silently forgetting a stop signal would fail open).

## [0.1.2] - 2026-07-09

### Fixed

- **Approval polling used the wrong IDs.** `FrameworkAdapter.handleApproval`
  read `workflow_id`/`run_id`/`activity_id` from `result.raw`, but Core's
  evaluate response never echoes them, so a configured `ApprovalPoller` polled
  `POST /api/v1/governance/approval` with empty IDs. The originating context is
  now threaded into the approval seam: `handleApproval(result, context?)`
  accepts an optional `ActivityContext` (lifecycle events build one from the
  event; hook evaluations pass the bound context) and prefers it, with
  `result.raw` kept only as a backward-compatible fallback. Existing adapters
  implementing `handleApproval(result)` keep working (the extra param is optional).

### Documented

- **Non-auth 4xx follows `on_api_error` (fail-open by default).** A review
  flagged that non-401/403 `4xx` evaluate responses fail open under the default
  policy; this is intentional (availability) and now recorded in
  `docs/contract-conflict-ledger.md`. Only auth `401/403` hard-fails regardless.

## [0.1.0] - 2026-07-09

Initial release. `@openbox-ai/openbox-sdk` is the TypeScript **base SDK** for
the OpenBox governance platform — a contract-driven foundation that Node/TS
framework SDKs build on instead of each reimplementing signing, validation,
and instrumentation. Behavior is reproduced from the canonical OpenBox Core
wire contract and the hardened Python base SDK, and verified against ported
golden fixtures plus a real Core-parity gate (see `docs/source-of-truth.md`).

### Added

- **Contracts** — `Verdict` (5-tier `allow < constrain < require_approval <
  block < halt`), `EvaluationResult`, `ApprovalResult`, `GuardrailsResult`,
  `EventEnvelope`/`EventType` with event factories (`workflowStarted`,
  `activityStarted`, `activityCompleted`, `signalReceived`, `handoff`,
  `hook`, ...), span field matrices, and diagnostics — all pure and lenient
  on unknown fields, available from the package root.
- **Layered configuration** (`OpenBoxConfig`, subpath `./config`) — explicit
  arguments > SDK-scoped env vars > global `OPENBOX_*` env vars > defaults,
  with eager validation (API key format, HTTPS-required URLs, DID/private-key
  pairing) and secret-redacted logging/serialization.
- **Byte-exact Ed25519 request signing** (`AgentIdentity`, subpath
  `./identity`) — an ASCII-escaping body serializer that matches Python's
  `json.dumps(ensure_ascii=True)` byte-for-byte, PKCS8-DER-wrapped Ed25519 key
  loading, and the exact canonical signing string OpenBox Core verifies
  (`UPPER(METHOD)\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`, no trailing
  newline, `+00:00` signing timestamp distinct from the `Z` event-payload
  timestamp).
- **HTTP client** (`OpenBoxClient`, subpath `./client`) — `evaluate`,
  `pollApproval`, and `validateApiKey` against the OpenBox Core governance
  API. Fails **closed** on an auth/signing rejection (HTTP 401/403)
  regardless of the configured `onApiError` policy, so a persistent auth
  failure (revoked key, signing drift, clock skew) can never silently
  degrade into a fleet-wide fail-open ALLOW. Outage (network/5xx) policy is
  configurable via `onApiError`: `fail_open` (default), `fail_closed`, or
  `fail_closed_destructive` — the last blocks only db/file writes +
  non-idempotent HTTP on an outage, while reads/idempotent ops and lifecycle
  events stay available.
- **Approvals** (`ApprovalPoller`, subpath `./approvals`) — HITL poll-loop
  orchestration (interval, backoff, timeout budget, consecutive-failure
  ceiling) on top of `OpenBoxClient.pollApproval`, with strict, fail-safe
  approval-decision parsing (unknown/empty decisions are pending, never an
  implicit allow).
- **Always-strict validation gate** (root + internal `./gate`) — malformed
  event/runtime contracts raise `ContractError` before any network send,
  independent of the fail-open/fail-closed network policy. No
  observe/sanitize/strict mode toggle — the gate is always strict.
- **Runtime composition root** (`OpenBoxRuntime`, subpath `./runtime`) —
  wires config, client, gate, context, and a `FrameworkAdapter` together;
  drives lifecycle evaluation (`evaluateLifecycle`) and preflight/completed
  hook evaluation (`preflight`/`completed`) through one seam, enforcing
  verdict priority (`HALT > BLOCK > guardrails-fail > REQUIRE_APPROVAL >
  CONSTRAIN > ALLOW`).
- **Framework adapter contract** (`FrameworkAdapter`, `CoreAdapter`, subpath
  `./adapters`) — the one place a governance verdict becomes a
  framework-native effect. `CoreAdapter` raises the base error types
  directly and fails safe (REJECTED, not silently allowed) when no
  `ApprovalPoller` is configured.
- **Per-runtime context** (`ContextStore`, subpath `./context`) —
  `AsyncLocalStorage`-scoped activity binding with a bounded trace-id
  correlation map fallback, plus abort/halt flags. Each `OpenBoxRuntime`
  owns its own store; there is no process-wide singleton.
- **Conformance kit** (subpath `./conformance`) — `FakeCore`/`FakeAdapter`,
  scenario matrices, and wire-shape assertions for testing SDKs and adapters
  built on this package (test utility, not a frozen public API), plus a real
  **Core-parity gate**: a Go harness that unmarshals TS-emitted wire spans
  into OpenBox Core's actual `SpanData` struct (`DisallowUnknownFields`) and
  independently verifies Ed25519 signatures with Go's `crypto/ed25519` —
  proving TS ≡ Core, not merely TS ≡ a ported fixture.
- **Node instrumentation** (`initOpenBoxInstrumentation`, subpath
  `./instrumentation`) — opt-in, custom-wrapper-based governance (never
  OpenTelemetry, which cannot block a call):
  - Tier A1 (always available): global `fetch`, `fs.promises`
    (`readFile`/`writeFile`), and `traced()` for arbitrary wrapped functions.
  - Tier A2/B (opt-in per driver via `databases: [...]`, never
    auto-detected): `pg` (promise-form `query`), `redis` (`sendCommand` only
    — see Known limitations), `mysql2` (promise-form `query`/`execute`),
    `mongodb` (12 named CRUD methods).
  - Fail-loud patchability checks (hard diagnostic, or a thrown
    `OpenBoxInstrumentationError` under `{ strict: true }`), atomic
    partial-failure rollback, and a recursion guard so the SDK's own
    governance traffic is never itself evaluated.
- **Import-light package root** — `import "@openbox-ai/openbox-sdk"` pulls in
  no crypto, network, database-driver, or OpenTelemetry code and performs no
  global patching. Heavy subsystems live behind subpath exports only,
  enforced by a root-import-safety test and the `import:check` script (which
  imports the built `dist/index.js` in a clean process and fails on any
  heavy module load or global patch).

### Known limitations

- `redis` governance blocking covers `client.sendCommand([...])` only —
  typed commands (`.get()`, `.set()`, `.hSet()`, ...) bind to an internal
  executor at module load and bypass the patched method entirely, so they
  are neither blocked nor observed. See `docs/instrumentation-coverage.md`.
- `pg`/`mysql2` callback-style `query(text, cb)` and streaming/cursor APIs
  are not intercepted (promise-form calls only).
- `mongodb` governance covers 12 named CRUD methods; cursors
  (`find()`/`aggregate()`) and `watch()` change streams pass through
  ungoverned.
- LLM-provider instrumentation is reserved
  (`config.instrumentation.llmEnabled`) but not yet implemented.
- `redis` typed-command blocking is an accepted, documented limitation
  (`sendCommand`-only) — see `docs/instrumentation-coverage.md`.

### Requirements

- Node.js `>=24.10.0`.
