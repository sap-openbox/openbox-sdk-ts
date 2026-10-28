/**
 * OpenBoxClient — async HTTP client for the OpenBox Core governance API.
 *
 * Endpoints (the `/api/v{1,2,3}` family is fixed per client at construction —
 * v1 DID/unsigned, v2 `okta_ai_agent`, v3 `keycloak_workload` — and never
 * retried on another version):
 *   POST /api/vN/governance/evaluate   — lifecycle + hook evaluations
 *   POST /api/vN/governance/approval   — HITL approval polling
 *   GET  /api/vN/auth/validate         — API key / identity validation
 *   POST /api/vN/handoffs              — source-authenticated handoff
 *
 * Transport rules:
 * - Signed requests send the raw body bytes verbatim — never re-serialize (that
 *   breaks Core's body-hash verification).
 * - Uses the global `fetch` + `AbortSignal.timeout`; injectable for tests.
 * - Fail-open/closed applies to NETWORK/outage failures only. A persistent
 *   AUTH/SIGNING rejection (401/403) is NOT an outage and must never be laundered
 *   into a fail-open ALLOW — that would silently disable governance fleet-wide on
 *   a key/clock/signing break. Auth failures are loud and fail-closed regardless
 *   of `onApiError`.
 */

import {
  ApprovalResult,
  EvaluationResult,
  verdictShouldStop
} from "../contracts/results.js";
import type { JsonValue } from "../contracts/results.js";
import {
  GovernanceAPIError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxNetworkError,
  mapSigningError
} from "../errors/index.js";
import { mapAssertionError } from "../errors/assertion.js";
import { OpenBoxWorkloadAuthError } from "../errors/workload.js";
import { AgentIdentity, buildAuthHeaders, prepareSignedRequest } from "../identity/index.js";
import {
  OktaAgentIdentity,
  loadRsaPkcs8PrivateKey,
  prepareOktaSignedRequest,
  type OktaTransitionClaims
} from "../identity/okta.js";
import type {
  OktaAiAgentIdentityConfig,
  OpenBoxDidIdentityConfig
} from "../identity/types.js";
import { WORKLOAD_TOKEN_HEADER } from "../identity/workload.js";
import type { OnApiError, OpenBoxConfig } from "../config/index.js";
import { trimTrailingSlashes, validateUrlSecurity } from "../config/url-security.js";
import { serializeBody } from "../serialization/index.js";
import { AuthStateCoordinator } from "./auth-state-coordinator.js";
import { buildHandoffRequestBody, parseHandoffResponse } from "./handoff.js";
import type { HandoffOptions, HandoffResult } from "./handoff.js";
import {
  assertCandidateMatchesExpectedTarget,
  parseTransitionProofResponse
} from "./transition-preflight.js";
import type {
  TransitionExpectedTarget,
  TransitionPreflightResult
} from "./transition-preflight.js";
// Phase 5 wiring: every fetch this client makes is the SDK's OWN governance
// traffic, never something to govern. `runAsInternal` marks the whole async
// chain of each call below so the Node instrumentation fetch patch (which may
// have replaced `globalThis.fetch` — this client's `fetchImpl` default —
// either before or after this client was constructed) sees
// `isInternalCall() === true` and skips governance unconditionally, instead
// of recursing into evaluating its own evaluate/approval/auth-validate calls.
// `recursion-guard.ts` is a dependency-free leaf (only `node:async_hooks`),
// so this import cannot create a cycle back through `runtime`/`instrumentation`.
import { drainOpenRouterProvenance } from "../instrumentation/openrouter-provenance.js";
import { runAsInternal } from "../instrumentation/recursion-guard.js";
import {
  assertPrivateKeyMatchesDocument,
  fetchBootstrapDocument,
  type IdentityBootstrapDocument
} from "../config/bootstrap.js";
import { WorkloadAuthenticator, type WorkloadAuthState } from "./workload-authenticator.js";
import type { WorkloadBootstrapDocument } from "./workload-documents.js";
import { CORE_REASON_KEYS, isRedirectResponse, reasonCodeFrom } from "./workload-http.js";
import {
  proveWorkloadTransition,
  type WorkloadTransitionProofOptions,
  type WorkloadTransitionProofResult
} from "./workload-transition.js";

export { AUTH_BOOTSTRAP_PATH_V3 } from "./workload-authenticator.js";
export {
  WORKLOAD_TRANSITION_BOOTSTRAP_PATH_V3,
  WORKLOAD_TRANSITION_PROOF_PATH_V3
} from "./workload-transition.js";
export { WORKLOAD_TOKEN_HEADER } from "../identity/workload.js";
export type { WorkloadBootstrapDocument, WorkloadIdentitySource } from "./workload-documents.js";
export type {
  WorkloadTransitionProofOptions,
  WorkloadTransitionProofResult
} from "./workload-transition.js";

// v1 (openbox_did / legacy_unsigned) — unchanged, byte-compatible.
export const EVALUATE_PATH = "/api/v1/governance/evaluate";
export const APPROVAL_PATH = "/api/v1/governance/approval";
export const AUTH_VALIDATE_PATH = "/api/v1/auth/validate";
export const HANDOFF_PATH_V1 = "/api/v1/handoffs";
export const TRANSITION_PROOF_PATH_V1 = "/api/v1/auth/transition-proof";

// v2 (okta_ai_agent) — contract §2.2. No cross-version retry (proposal §13.3).
export const EVALUATE_PATH_V2 = "/api/v2/governance/evaluate";
export const APPROVAL_PATH_V2 = "/api/v2/governance/approval";
export const AUTH_VALIDATE_PATH_V2 = "/api/v2/auth/validate";
export const HANDOFF_PATH_V2 = "/api/v2/handoffs";
export const TRANSITION_PROOF_PATH_V2 = "/api/v2/auth/transition-proof";

// v3 (keycloak_workload) — API key + short-lived Keycloak workload token. Fixed
// at construction: no v1/v2 or API-key-only retry, under any outage policy.
export const EVALUATE_PATH_V3 = "/api/v3/governance/evaluate";
export const APPROVAL_PATH_V3 = "/api/v3/governance/approval";
export const AUTH_VALIDATE_PATH_V3 = "/api/v3/auth/validate";
export const HANDOFF_PATH_V3 = "/api/v3/handoffs";

type ContractVersion = 1 | 2 | 3;
type RuntimeOperation = "evaluate" | "approval" | "validate" | "handoff";

/** The ONLY route table — selected by the client's fixed contract version. */
const RUNTIME_ROUTES: Readonly<Record<ContractVersion, Readonly<Record<RuntimeOperation, string>>>> = {
  1: { evaluate: EVALUATE_PATH, approval: APPROVAL_PATH, validate: AUTH_VALIDATE_PATH, handoff: HANDOFF_PATH_V1 },
  2: { evaluate: EVALUATE_PATH_V2, approval: APPROVAL_PATH_V2, validate: AUTH_VALIDATE_PATH_V2, handoff: HANDOFF_PATH_V2 },
  3: { evaluate: EVALUATE_PATH_V3, approval: APPROVAL_PATH_V3, validate: AUTH_VALIDATE_PATH_V3, handoff: HANDOFF_PATH_V3 }
};

/** A fully prepared runtime request. */
interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  /** Carried per request so error handling never re-reads (possibly changed) client state. */
  readonly contractVersion: ContractVersion;
  /** The v3 auth state this request carries, so a 401/403 invalidates exactly it. */
  readonly workloadAuth: WorkloadAuthState | null;
}

/** An Okta v2 bootstrap-mode identity together with the document it was built from. */
interface OktaBootstrapState {
  readonly identity: OktaAgentIdentity;
  readonly document: IdentityBootstrapDocument;
}

const CLIENT_CLOSED_MESSAGE =
  "This OpenBoxClient has been closed; construct a new client (or runtime) to send governance requests.";

function clientClosedError(): OpenBoxConfigError {
  return new OpenBoxConfigError(CLIENT_CLOSED_MESSAGE);
}

/**
 * Fetch refuses a header value containing CR, LF, or NUL (after trimming
 * surrounding whitespace, which it strips) — and its TypeError then echoes the
 * whole value. An API key like that can never be sent, so it is rejected at
 * construction, before it could reach a log or error message.
 */
function isHeaderSafe(value: string): boolean {
  // Linear scan (no backtracking regex): skip surrounding HTTP whitespace, then
  // look for a line break or NUL in what remains.
  const isHttpWhitespace = (char: string | undefined): boolean =>
    char === "\t" || char === "\n" || char === "\r" || char === " ";
  let start = 0;
  let end = value.length;
  while (start < end && isHttpWhitespace(value[start])) start += 1;
  while (end > start && isHttpWhitespace(value[end - 1])) end -= 1;
  const inner = value.slice(start, end);
  return !inner.includes("\r") && !inner.includes("\n") && !inner.includes("\0");
}

function validateOnApiError(onApiError: OnApiError): OnApiError {
  if (
    onApiError !== "fail_open" &&
    onApiError !== "fail_closed" &&
    onApiError !== "fail_closed_destructive"
  ) {
    throw new Error(
      `onApiError must be 'fail_open', 'fail_closed', or 'fail_closed_destructive', got ${String(onApiError)}`
    );
  }
  return onApiError;
}

function assertHeaderSafeApiKey(apiKey: string): void {
  if (typeof apiKey !== "string" || !isHeaderSafe(apiKey)) {
    throw new OpenBoxConfigError(
      "The OpenBox API key contains a line break or NUL character, which is not valid in an HTTP header (key not shown)."
    );
  }
}

/** At most one v1/v2 identity method per client: DID, explicit Okta, or Okta bootstrap. */
function assertExclusiveV1V2IdentityOptions(options: OpenBoxClientOptions): void {
  if (options.identity && options.oktaIdentity) {
    throw new OpenBoxConfigError(
      "OpenBoxClient received both a v1 identity and a v2 oktaIdentity; exactly one (or neither) is allowed."
    );
  }
  if (options.oktaBootstrapPrivateKey && options.oktaIdentity) {
    throw new OpenBoxConfigError(
      "OpenBoxClient received both oktaBootstrapPrivateKey and a fully resolved oktaIdentity; " +
        "supply exactly one — bootstrap mode fetches the metadata that oktaIdentity already carries."
    );
  }
  if (options.oktaBootstrapPrivateKey && options.identity) {
    throw new OpenBoxConfigError(
      "OpenBoxClient received both oktaBootstrapPrivateKey (okta_ai_agent) and a v1 identity " +
        "(openbox_did); exactly one identity method is allowed."
    );
  }
}

/** A workload key (keycloak_workload) excludes every other identity method. */
function assertWorkloadIsSoleIdentity(options: OpenBoxClientOptions): void {
  const conflicting = [
    options.identity ? "identity (openbox_did)" : null,
    options.oktaIdentity ? "oktaIdentity (okta_ai_agent)" : null,
    options.oktaBootstrapPrivateKey ? "oktaBootstrapPrivateKey (okta_ai_agent)" : null
  ].filter((name): name is string => name !== null);
  if (conflicting.length > 0) {
    throw new OpenBoxConfigError(
      `OpenBoxClient received workloadPrivateKey (keycloak_workload) together with ${conflicting.join(", ")}; ` +
        "exactly one identity method is allowed."
    );
  }
}

/**
 * v3 answers that are contract errors rather than outages: a redirect (never
 * followed on v3) and every 4xx except auth (401/403, handled separately) and
 * the retryable 408/429.
 */
function isV3ContractError(response: Response): boolean {
  const { status } = response;
  return isRedirectResponse(response) || (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status));
}

/**
 * v3 runtime requests never follow a redirect: fetch drops `Authorization` on a
 * cross-origin redirect but re-sends custom headers, so following one would hand
 * the reusable workload token to the redirect target. v1/v2 keep fetch's default.
 */
function redirectPolicy(prepared: PreparedRequest): { redirect?: "manual" } {
  return prepared.contractVersion === 3 ? { redirect: "manual" } : {};
}

const SESSION_CLOSING_EVENTS = new Set(["WorkflowCompleted", "WorkflowFailed"]);

/**
 * Let this session's in-flight OpenRouter provenance reach Core before the
 * session closes. The last model call's lookup finishes after the workflow
 * returns, and Core does not record spans that arrive after the closing event.
 * Only the closing session's lookups are awaited, bounded by the lookup budget.
 */
async function drainProvenanceBeforeClose(payload: JsonValue): Promise<void> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
  const eventType = payload["event_type"];
  if (typeof eventType !== "string" || !SESSION_CLOSING_EVENTS.has(eventType)) return;
  const workflowId = payload["workflow_id"];
  const runId = payload["run_id"];
  await drainOpenRouterProvenance({
    workflowId: typeof workflowId === "string" ? workflowId : null,
    runId: typeof runId === "string" ? runId : null
  });
}

export interface ClientLogger {
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export interface OpenBoxClientOptions {
  timeoutSeconds?: number;
  onApiError?: OnApiError;
  /** v1 (`openbox_did`) identity. Mutually exclusive with `oktaIdentity`. */
  identity?: AgentIdentity | null;
  /**
   * v2 (`okta_ai_agent`) identity. When set, EVERY route this client calls
   * (evaluate/approval/validate/handoff) selects the `/api/v2/*` equivalent
   * and signs `X-OpenBox-Agent-Assertion` instead of v1's DID headers —
   * mutually exclusive with `identity` (contract §1, proposal §13.3).
   */
  oktaIdentity?: OktaAgentIdentity | null;
  /**
   * PKCS8 PEM RSA private key for BOOTSTRAP mode: the client fetches the
   * agent's non-secret identity metadata from
   * `GET /api/v2/auth/bootstrap` and builds its `oktaIdentity` from the result.
   *
   * Mutually exclusive with `oktaIdentity` (that is already-resolved metadata)
   * and with `identity` (a different method entirely). Supplying this makes the
   * client a v2 client IMMEDIATELY — before the fetch completes — so a bootstrap
   * failure can never be mistaken for "no v2 identity configured" and silently
   * downgrade the request to v1.
   */
  oktaBootstrapPrivateKey?: string | null;
  /**
   * IAM v3 (`keycloak_workload`): PKCS8 PEM RSA key of the agent's active
   * Keycloak service account. Its presence fixes this client to contract v3
   * BEFORE the first request: every route is `/api/v3/*`, authenticated by the
   * API key plus a short-lived workload token acquired from Core's bootstrap
   * metadata, and no failure ever turns it into a v1/v2 or API-key-only request.
   *
   * Parsed and validated at construction. Mutually exclusive with `identity`,
   * `oktaIdentity`, and `oktaBootstrapPrivateKey`.
   */
  workloadPrivateKey?: string | null;
  sdkVersion?: string | null;
  sdkEngine?: string;
  sdkLanguage?: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: ClientLogger;
}

/** The transport overrides `OpenBoxClient.fromConfig` accepts; everything else comes from config. */
export type OpenBoxClientTransportOptions = Pick<OpenBoxClientOptions, "fetchImpl" | "logger">;

type Dict = Record<string, unknown>;

/** Set `expired=true` on `data` if `approval_expiration_time` is in the past. */
export function checkExpiration(data: Dict): Dict {
  const raw = data["approval_expiration_time"];
  if (typeof raw !== "string" || !raw) return data;
  try {
    // Handle ISO `Z`, ISO offset, and space-separated DB formats. A tz-naive
    // timestamp is assumed UTC (matching Python) — `new Date("...T00:00:00")`
    // would otherwise parse as host-local time and mis-flag expiry by the offset.
    let normalized = raw.replace("Z", "+00:00").replace(" ", "T");
    if (!/[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += "+00:00";
    const expiration = new Date(normalized);
    if (!Number.isNaN(expiration.getTime()) && Date.now() > expiration.getTime()) {
      data["expired"] = true;
    }
  } catch {
    /* parse failures are non-fatal — never raise from expiry parsing */
  }
  return data;
}

/** Machine reason code from Core's JSON error body, if present. */
function extractReasonCode(body: string | null): string | null {
  if (!body) return null;
  try {
    const data: unknown = JSON.parse(body);
    if (typeof data !== "object" || data === null) return null;
    const dict = data as Dict;
    const code = dict["reason_code"] ?? dict["code"] ?? dict["reason"];
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export class OpenBoxClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly onApiError: OnApiError;
  /** Fixed at construction: 1 (DID/unsigned), 2 (okta_ai_agent), 3 (keycloak_workload). */
  private readonly contractVersion: ContractVersion;
  // Not `readonly`: close() drops key references.
  private identity: AgentIdentity | null;
  /** Explicit (fully configured) Okta identity. Bootstrap mode uses `oktaBootstrap`. */
  private oktaIdentity: OktaAgentIdentity | null;
  private oktaBootstrapPrivateKey: string | null;
  /**
   * Okta bootstrap-mode identity + document, acquired on first use and replaced
   * only by refreshIdentityMetadata(). Revision-guarded, so an older in-flight
   * bootstrap can never overwrite a newer identity.
   */
  private readonly oktaBootstrap: AuthStateCoordinator<OktaBootstrapState> | null;
  /** IAM v3 workload authentication; non-null exactly when contractVersion is 3. */
  private readonly workload: WorkloadAuthenticator | null;
  private readonly sdkVersion: string | null;
  private readonly sdkEngine: string | undefined;
  private readonly sdkLanguage: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ClientLogger;
  private consecutiveAuthFailures = 0;
  private closed = false;

  constructor(apiUrl: string, apiKey: string, options: OpenBoxClientOptions = {}) {
    const onApiError = validateOnApiError(options.onApiError ?? "fail_open");
    assertExclusiveV1V2IdentityOptions(options);
    assertHeaderSafeApiKey(apiKey);
    // Any supplied value — even an empty one — selects v3 and is validated
    // below; it never silently falls through to a v1 client.
    const workloadPrivateKey = options.workloadPrivateKey ?? null;
    if (workloadPrivateKey !== null) {
      // A reusable workload token (and the API key) must never travel in
      // cleartext, even when config normalization was skipped (`validate: false`).
      validateUrlSecurity(apiUrl);
      assertWorkloadIsSoleIdentity(options);
    }
    this.apiUrl = trimTrailingSlashes(apiUrl);
    this.apiKey = apiKey;
    this.timeoutMs = Math.round((options.timeoutSeconds ?? 30.0) * 1000);
    this.onApiError = onApiError;
    this.identity = options.identity ?? null;
    this.oktaIdentity = options.oktaIdentity ?? null;
    this.oktaBootstrapPrivateKey = options.oktaBootstrapPrivateKey ?? null;
    this.sdkVersion = options.sdkVersion ?? null;
    this.sdkEngine = options.sdkEngine;
    this.sdkLanguage = options.sdkLanguage;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? console;

    // The contract is decided HERE, before any request: a pending bootstrap or
    // a failed acquisition can never downgrade a v2/v3 client.
    if (workloadPrivateKey !== null) {
      this.contractVersion = 3;
      this.workload = new WorkloadAuthenticator({
        privateKeyPem: workloadPrivateKey,
        apiUrl: this.apiUrl,
        coreHeaders: () => this.coreHeaders(),
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
        closedError: clientClosedError
      });
    } else {
      this.contractVersion = this.oktaIdentity !== null || this.oktaBootstrapPrivateKey !== null ? 2 : 1;
      this.workload = null;
    }
    this.oktaBootstrap =
      this.oktaBootstrapPrivateKey === null
        ? null
        : new AuthStateCoordinator<OktaBootstrapState>({
            acquire: () => this.runBootstrap(),
            isUsable: () => true,
            closedError: clientClosedError,
            // Logged on publish, so a superseded bootstrap never reports success.
            onPublish: ({ document }) => {
              this.logger.info(
                `OpenBox identity bootstrap succeeded (version ${document.bootstrapVersion}, ` +
                  `agent ${document.openboxAgentId}, kid ${document.okta.credentialKid}, thumbprint matched)`
              );
            }
          });
  }

  /**
   * Build a client from a resolved `OpenBoxConfig` — the one construction path
   * shared by `OpenBoxRuntime` and framework adapters.
   *
   * Maps the config's identity mode to exactly one set of client options
   * (DID, explicit Okta, Okta bootstrap, workload, or none) and carries the
   * timeout, outage policy, and SDK branding. Identity-mode exclusivity is
   * re-validated here, so a config resolved with `validate: false` can skip
   * eager server validation but never mode or key checks.
   */
  static fromConfig(config: OpenBoxConfig, options: OpenBoxClientTransportOptions = {}): OpenBoxClient {
    config.validateIdentity();
    const common: OpenBoxClientOptions = {
      timeoutSeconds: config.timeoutSeconds,
      onApiError: config.onApiError,
      sdkVersion: config.sdkVersion,
      sdkEngine: config.sdkEngine,
      sdkLanguage: config.sdkLanguage,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    };
    // A selected method whose identity input is missing must fail here, never
    // fall through to an unsigned v1 client (validateIdentity() already makes
    // that unreachable; this keeps it fail-closed if the two ever drift).
    const unresolved = (method: string): never => {
      throw new OpenBoxConfigError(`identity method '${method}' resolved without its identity input.`);
    };
    let identityOptions: OpenBoxClientOptions;
    const method = config.resolvedIdentityMethod();
    switch (method) {
      case "keycloak_workload":
        identityOptions = { workloadPrivateKey: config.resolvedWorkloadPrivateKey() ?? unresolved(method) };
        break;
      case "okta_ai_agent": {
        // Exactly one is non-null: explicit (legacy) metadata or bootstrap mode.
        const oktaIdentity = config.loadOktaIdentity();
        const oktaBootstrapPrivateKey = config.oktaBootstrapPrivateKey();
        if (oktaIdentity === null && oktaBootstrapPrivateKey === null) unresolved(method);
        identityOptions = { oktaIdentity, oktaBootstrapPrivateKey };
        break;
      }
      case "openbox_did":
        identityOptions = { identity: config.loadIdentity() ?? unresolved(method) };
        break;
      case "legacy_unsigned":
        identityOptions = {};
        break;
    }
    return new OpenBoxClient(config.apiUrl, config.apiKey, { ...common, ...identityOptions });
  }

  /** True when this client is configured for the v2 (`okta_ai_agent`) method, even while a bootstrap is pending. */
  private get isV2(): boolean {
    return this.contractVersion === 2;
  }

  /** Base Core auth + SDK identity headers (API key, `User-Agent`, `X-OpenBox-SDK-Version`). */
  private coreHeaders(): Record<string, string> {
    return buildAuthHeaders(this.apiKey, this.sdkVersion, {
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    });
  }

  private assertOpen(): void {
    if (this.closed) throw clientClosedError();
  }

  /**
   * Release this client: drop cached tokens, identity metadata, and key
   * references, abort in-flight workload acquisition, and reject every later
   * send. Idempotent and synchronous.
   *
   * A client shared by several consumers (e.g. an injected client) closes for
   * all of them — `OpenBoxRuntime.close()` closes its client, so consumers
   * sharing one must coordinate shutdown. This releases SDK-held references; it
   * cannot zeroize strings still held by application configuration.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.workload?.close();
    this.oktaBootstrap?.close();
    this.oktaBootstrapPrivateKey = null;
    this.oktaIdentity = null;
    this.identity = null;
  }

  /** Redacted view for `JSON.stringify` / `util.inspect`: never the API key, keys, or tokens. */
  toJSON(): Record<string, unknown> {
    return { apiUrl: this.apiUrl, contractVersion: this.contractVersion, closed: this.closed };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * The validated bootstrap document, or null when this client is not in
   * bootstrap mode or has not bootstrapped yet. Non-secret; safe to log.
   */
  identityMetadata(): IdentityBootstrapDocument | null {
    return this.oktaBootstrap?.current()?.document ?? null;
  }

  /**
   * Re-fetch identity metadata from Core and replace the cached copy.
   *
   * For long-running agents whose selected credential changed. The current
   * identity is dropped FIRST, so a refresh that fails — a rotated-away
   * credential, missing authority metadata, or an outage — leaves no stale
   * signer behind: later requests bootstrap again and stay blocked until one
   * succeeds. A concurrent older bootstrap can never overwrite the result.
   *
   * This is explicit on purpose. The client never refreshes automatically after a
   * signature, binding, or credential error: rotation may have selected a new
   * public key while this process still holds the old private key, so a blind
   * refresh-and-replay would hide the real problem and could not repair it.
   */
  async refreshIdentityMetadata(): Promise<IdentityBootstrapDocument> {
    this.assertOpen();
    if (this.oktaBootstrap === null) {
      throw new OpenBoxConfigError(
        "refreshIdentityMetadata() requires identity bootstrap mode; this client was constructed " +
          "with explicit Okta identity configuration."
      );
    }
    this.oktaBootstrap.reset();
    return (await this.oktaBootstrap.get()).document;
  }

  /**
   * Non-secret metadata of the active workload service account backing a
   * currently usable workload token, or null (no token yet, refresh due,
   * invalidated, closed, or not a `keycloak_workload` client). Immutable.
   */
  workloadIdentityMetadata(): WorkloadBootstrapDocument | null {
    return this.workload?.metadata() ?? null;
  }

  /**
   * Invalidate the current workload token immediately, re-fetch
   * `/api/v3/auth/bootstrap`, and acquire a new token — the same coordination
   * as automatic renewal. If this fails, nothing usable remains: later
   * operations stay blocked until an acquisition succeeds or the application
   * replaces the client. A different private key needs a new client.
   */
  async refreshWorkloadIdentity(): Promise<WorkloadBootstrapDocument> {
    this.assertOpen();
    if (this.workload === null) {
      throw new OpenBoxConfigError(
        `refreshWorkloadIdentity() requires a keycloak_workload client; this client uses contract v${this.contractVersion}.`
      );
    }
    return this.workload.refresh();
  }

  /** Resolve the v2 identity, bootstrapping (once, shared by concurrent callers) if needed. */
  private async ensureOktaIdentity(signal?: AbortSignal): Promise<OktaAgentIdentity> {
    if (this.oktaIdentity) return this.oktaIdentity;
    if (this.oktaBootstrap === null) {
      // Unreachable via prepared(), which only calls this for contract v2.
      throw new OpenBoxConfigError("No Okta identity is configured for this client.");
    }
    return (await this.oktaBootstrap.get(signal)).identity;
  }

  /**
   * Fetch, validate, thumbprint-check, and build the identity.
   *
   * Order matters: the local key is parsed and size-checked first (a malformed
   * or undersized key fails without a network round trip), then the document is
   * fetched and structurally validated (including its authority metadata), then
   * the thumbprint is compared. The coordinator publishes identity and document
   * together, only if no newer refresh superseded this bootstrap.
   */
  private async runBootstrap(): Promise<OktaBootstrapState> {
    const privateKeyPem = this.oktaBootstrapPrivateKey;
    if (privateKeyPem === null) throw clientClosedError();
    // Fails locally, before any request, on a malformed / non-RSA / undersized key.
    loadRsaPkcs8PrivateKey(privateKeyPem);

    const document = await runAsInternal(() =>
      fetchBootstrapDocument({
        apiUrl: this.apiUrl,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        sdkVersion: this.sdkVersion,
        ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
        ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
      })
    );

    // Throws on mismatch — no governed request is ever sent after this point.
    assertPrivateKeyMatchesDocument(privateKeyPem, document);

    const identity = OktaAgentIdentity.fromConfig({
      method: "okta_ai_agent",
      openboxAgentId: document.openboxAgentId,
      organizationId: document.organizationId,
      deploymentId: document.deploymentId,
      externalAgentId: document.okta.externalAgentId,
      keyId: document.okta.credentialKid,
      algorithm: "RS256",
      privateKey: privateKeyPem,
      audience: document.assertionAudience
    });

    return { identity, document };
  }

  /**
   * Prepare a runtime request on this client's fixed contract. The await on
   * the v2/v3 identity is the only thing between an unresolved client and a
   * request: it throws rather than proceeding unsigned or on another version.
   * `signal` cancels only this caller's wait for a shared acquisition.
   */
  private async prepared(
    operation: RuntimeOperation,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<PreparedRequest> {
    this.assertOpen();
    const contractVersion = this.contractVersion;
    const path = RUNTIME_ROUTES[contractVersion][operation];
    const url = `${this.apiUrl}${path}`;

    if (this.workload !== null) {
      // v3 sends ONLY the API key, SDK headers, and the raw workload token —
      // never DID signature headers or X-OpenBox-Agent-Assertion.
      const workloadAuth = await this.workload.get(signal);
      const headers = this.coreHeaders();
      headers[WORKLOAD_TOKEN_HEADER] = workloadAuth.accessToken();
      return { url, headers, body: serializeBody(payload), contractVersion, workloadAuth };
    }

    const method = operation === "validate" ? "GET" : "POST";
    const sdkOptions = {
      apiKey: this.apiKey,
      sdkVersion: this.sdkVersion,
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    };
    const oktaIdentity = contractVersion === 2 ? await this.ensureOktaIdentity(signal) : null;
    // v2 sends ONLY X-OpenBox-Agent-Assertion + the base auth headers — never
    // v1 DID identity headers as a fallback (contract §2.1, proposal §13.4
    // step 11). Selecting `prepareOktaSignedRequest` here instead of
    // `prepareSignedRequest` is what guarantees that: the two functions build
    // disjoint header sets and this branch calls exactly one.
    const { headers, body } = oktaIdentity
      ? prepareOktaSignedRequest(method, path, payload, { ...sdkOptions, identity: oktaIdentity })
      : prepareSignedRequest(method, path, payload, { ...sdkOptions, identity: this.identity });
    return { url, headers, body, contractVersion, workloadAuth: null };
  }

  // ── Evaluate ────────────────────────────────────────────────────────────

  /**
   * POST a governance event; parse the verdict. Under fail_open, network/outage
   * failures return a `fallbackUsed=true` ALLOW. An auth/signing 401/403 throws
   * (never fail-opens) — see the class docstring. On v3, a workload-acquisition
   * failure throws before any request, and a redirect or non-retryable 4xx is
   * a contract error that throws under every outage policy.
   */
  async evaluate(payload: JsonValue): Promise<EvaluationResult> {
    await drainProvenanceBeforeClose(payload);
    const prepared = await this.prepared("evaluate", payload);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(prepared.url, {
          method: "POST",
          headers: prepared.headers,
          body: prepared.body,
          signal: AbortSignal.timeout(this.timeoutMs),
          ...redirectPolicy(prepared)
        })
      );
    } catch (e) {
      return this.networkFailure(`Governance API unreachable: ${errorMessage(e)}`, payload);
    }

    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("evaluate", response, prepared);
    }
    this.consecutiveAuthFailures = 0;
    if (prepared.contractVersion === 3 && isV3ContractError(response)) {
      throw await this.v3ContractError("evaluate", response);
    }
    if (response.status >= 400) {
      return this.networkFailure(`Governance API error: HTTP ${response.status}`, payload);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      return this.networkFailure(`Governance API returned unparseable body: ${errorMessage(e)}`, payload);
    }
    const result = EvaluationResult.fromDict((data ?? {}) as Dict);
    if (verdictShouldStop(result.verdict)) {
      this.logger.info(`Governance blocked: ${result.reason} (policy: ${result.policyId})`);
    }
    return result;
  }

  /**
   * Apply the onApiError policy to a NETWORK/outage failure. `fail_closed` blocks
   * everything; `fail_closed_destructive` blocks only when the payload carries a
   * destructive span (db/file write, non-idempotent HTTP) — reads/idempotent ops
   * and lifecycle events (no spans) fail open; `fail_open` always fails open.
   */
  private networkFailure(reason: string, payload: JsonValue): EvaluationResult {
    this.logger.warn(reason);
    const failClosed =
      this.onApiError === "fail_closed" ||
      (this.onApiError === "fail_closed_destructive" && payloadHasDestructiveSpan(payload));
    if (failClosed) throw new GovernanceAPIError(reason);
    return EvaluationResult.fallbackAllow(reason);
  }

  /**
   * An auth/signing rejection is never an outage. Emit a loud diagnostic and
   * fail CLOSED (throw) regardless of onApiError, so a signing break cannot
   * silently become a fleet-wide ALLOW.
   *
   * v3: the workload token this request carried is invalidated (never a newer
   * one), the operation is NOT replayed, and the next operation bootstraps
   * again. Core deliberately collapses identity failures into a generic 401, so
   * this does not depend on a specific reason code.
   */
  private async rejectAuthFailure(
    op: RuntimeOperation,
    response: Response,
    prepared: PreparedRequest
  ): Promise<never> {
    this.consecutiveAuthFailures += 1;
    if (prepared.workloadAuth !== null) {
      this.workload?.invalidate(prepared.workloadAuth);
      const reasonCode = reasonCodeFrom((await safeText(response)) ?? "", CORE_REASON_KEYS);
      const detail = reasonCode ? `HTTP ${response.status} ${reasonCode}` : `HTTP ${response.status}`;
      this.logger.error(
        `OpenBox ${op} rejected with ${detail} (workload authentication, contract v3). ` +
          `Governance is NOT failing open on an auth rejection (consecutive=${this.consecutiveAuthFailures}); ` +
          "the cached workload token was discarded and the operation was not replayed."
      );
      throw new OpenBoxWorkloadAuthError(
        `OpenBox Core rejected the workload-authenticated ${op} request (${detail}). The cached workload ` +
          "token was discarded and the next operation bootstraps again. Core does not distinguish an " +
          "expired token from changed authority here — check the agent's active workload identity if this persists.",
        { stage: "runtime", httpStatus: response.status, reasonCode }
      );
    }
    let reasonCode: string | null = null;
    if (this.identity !== null || this.isV2) {
      const text = await safeText(response);
      reasonCode = extractReasonCode(text);
    }
    this.logger.error(
      `OpenBox ${op} rejected with HTTP ${response.status} (auth/signing). ` +
        `Governance is NOT failing open on an auth rejection ` +
        `(consecutive=${this.consecutiveAuthFailures}) — check API key, signing key, and clock skew.` +
        (reasonCode ? ` reason=${reasonCode}` : "")
    );
    // v1 and v2 reason-code vocabularies are disjoint (Core's Phase 6
    // compatibility refactor kept v1's external codes byte-stable) — select
    // the mapper that matches the method actually in use.
    if (reasonCode) throw this.isV2 ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
    throw new GovernanceAPIError(
      `Governance API auth rejected (HTTP ${response.status}); refusing to fail-open on an auth failure.`
    );
  }

  /** A v3 refused redirect or non-retryable 4xx: a contract error, never an outage and never a fallback ALLOW. */
  private async v3ContractError(op: RuntimeOperation, response: Response): Promise<GovernanceAPIError> {
    if (isRedirectResponse(response)) {
      return new GovernanceAPIError(
        `The v3 ${op} request was answered with a redirect (HTTP ${response.status}). Redirects are ` +
          "refused so the workload token never follows one to another target; point apiUrl at " +
          "OpenBox Core directly."
      );
    }
    const reasonCode = reasonCodeFrom((await safeText(response)) ?? "", CORE_REASON_KEYS);
    const detail = reasonCode ? `HTTP ${response.status} ${reasonCode}` : `HTTP ${response.status}`;
    return new GovernanceAPIError(
      `OpenBox Core rejected the v3 ${op} request (${detail}). ` +
        "This is a contract error, not an outage, so it never becomes a fallback ALLOW; check that the " +
        "SDK and Core versions are compatible."
    );
  }

  // ── Approval polling ──────────────────────────────────────────────────────

  /**
   * Poll HITL approval status once. Returns null on poll failure (still
   * pending). `signal` (e.g., a controller-shutdown abort) is composed with
   * the request timeout so either can cancel the in-flight fetch — but only a
   * caller-provided abort surfaces (thrown, not swallowed to null): the poller
   * must fail safe on shutdown rather than treat it as a transient failure to
   * retry. An internal-timeout-only abort keeps the existing null/retry
   * behavior. Identity preparation/acquisition failures and auth rejections
   * always throw — they are never "still pending".
   */
  async pollApproval(
    workflowId: string,
    runId: string,
    activityId: string,
    signal?: AbortSignal
  ): Promise<ApprovalResult | null> {
    const payload = { workflow_id: workflowId, run_id: runId, activity_id: activityId };
    const prepared = await this.prepared("approval", payload, signal);
    const composedSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(prepared.url, {
          method: "POST",
          headers: prepared.headers,
          body: prepared.body,
          signal: composedSignal,
          ...redirectPolicy(prepared)
        })
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      this.logger.warn(`Failed to poll approval status: ${errorMessage(e)}`);
      return null;
    }
    // An auth/signing rejection is never "still pending" — proposal §13.6:
    // never convert an approval authentication failure into null. This
    // mirrors evaluate()'s 401/403 handling exactly (previously only evaluate
    // had this fix; approval polling treated EVERY non-200, including
    // 401/403, as a retryable "still pending" failure).
    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("approval", response, prepared);
    }
    if (prepared.contractVersion === 3 && isV3ContractError(response)) {
      throw await this.v3ContractError("approval", response);
    }
    if (response.status !== 200) {
      this.logger.warn(`Failed to get approval status: HTTP ${response.status}`);
      return null;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      this.logger.warn(`Failed to parse approval response: ${errorMessage(e)}`);
      return null;
    }
    const dict = (data ?? {}) as Dict;
    checkExpiration(dict);
    return ApprovalResult.fromDict(dict);
  }

  // ── Auth validation ───────────────────────────────────────────────────────

  /**
   * GET the contract's auth/validate route (signed or workload-authenticated
   * when an identity is configured). Returns true on success; throws
   * OpenBoxAuthError/OpenBoxSigningError/OpenBoxWorkloadAuthError on 401/403,
   * OpenBoxNetworkError on connectivity failure, and (v3) GovernanceAPIError on
   * a contract error.
   */
  async validateApiKey(): Promise<boolean> {
    const prepared = await this.prepared("validate", null);
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(prepared.url, {
          method: "GET",
          headers: prepared.headers,
          signal: AbortSignal.timeout(this.timeoutMs),
          ...redirectPolicy(prepared)
        })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 403) {
      if (prepared.workloadAuth !== null) return this.rejectAuthFailure("validate", response, prepared);
      // When signing is enabled, surface Core's machine reason code.
      const reasonCode =
        this.identity !== null || this.isV2 ? extractReasonCode(await safeText(response)) : null;
      if (reasonCode) throw this.isV2 ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
      throw new OpenBoxAuthError("Invalid API key. Check your API key at dashboard.openbox.ai");
    }
    if (prepared.contractVersion === 3 && isV3ContractError(response)) {
      throw await this.v3ContractError("validate", response);
    }
    throw new OpenBoxNetworkError(
      `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
    );
  }

  // ── Handoff (source-authenticated) ────────────────────────────────────────

  /**
   * `POST /api/{v1,v2,v3}/handoffs` — proves the SOURCE agent via the
   * configured identity (never a caller-supplied source, contract §17.22).
   * Unsigned (`legacy_unsigned`) mode has no source-authenticated identity to
   * prove and must provision one first (proposal §13.3): "An updated unsigned
   * client must not call /api/v1/handoffs."
   */
  async sendHandoff(toAgentId: string, options: HandoffOptions = {}): Promise<HandoffResult> {
    this.assertOpen();
    // Decided by the fixed contract, never by whether a v2/v3 identity has
    // been RESOLVED yet: a correctly configured okta_ai_agent or
    // keycloak_workload client whose first call is a handoff must initialize
    // its identity here, not be told to provision one it already has.
    if (this.contractVersion === 1 && this.identity === null) {
      throw new OpenBoxConfigError(
        "Cannot send a source-authenticated handoff in unsigned (legacy_unsigned) mode: " +
          "provision an OpenBox DID, Okta AI Agent, or Keycloak workload identity first."
      );
    }
    const prepared = await this.prepared("handoff", buildHandoffRequestBody(toAgentId, options));
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(prepared.url, {
          method: "POST",
          headers: prepared.headers,
          body: prepared.body,
          signal: AbortSignal.timeout(this.timeoutMs),
          ...redirectPolicy(prepared)
        })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 401 || response.status === 403) {
      return this.rejectAuthFailure("handoff", response, prepared);
    }
    if (prepared.contractVersion === 3 && isRedirectResponse(response)) {
      throw await this.v3ContractError("handoff", response);
    }
    if (response.status !== 200) {
      throw new GovernanceAPIError(`Handoff request failed: HTTP ${response.status}`);
    }
    return parseHandoffResponse((await response.json()) as Record<string, unknown>);
  }

  // ── Transition preflight ──────────────────────────────────────────────────

  /**
   * `POST /api/v2/auth/transition-proof` — proves possession of an EXPLICIT
   * candidate Okta identity (never this client's active identity, even if
   * one is configured). Proposal §13.5 / §17.28: omitting the candidate is a
   * local configuration error, and the helper never falls back to the active
   * signer, searches local keys by `kid`, or mutates the client's active
   * identity.
   */
  async validateOktaIdentityTransition(options: {
    transitionId: string;
    challenge: string;
    candidateIdentity: OktaAiAgentIdentityConfig;
    /** Optional local convenience check against prepare's non-secret metadata. */
    expectedTarget?: TransitionExpectedTarget;
  }): Promise<TransitionPreflightResult> {
    this.assertOpen();
    if (!options.candidateIdentity) {
      throw new OpenBoxConfigError(
        "validateOktaIdentityTransition requires an explicit candidateIdentity; it never falls " +
          "back to the client's active identity (proposal §17.28)."
      );
    }
    assertCandidateMatchesExpectedTarget(options.candidateIdentity, options.expectedTarget);

    const candidate = OktaAgentIdentity.fromConfig(options.candidateIdentity);
    const transition: OktaTransitionClaims = {
      transitionId: options.transitionId,
      transitionChallenge: options.challenge
    };
    const { headers, body } = prepareOktaSignedRequest(
      "POST",
      TRANSITION_PROOF_PATH_V2,
      { transition_id: options.transitionId },
      {
        apiKey: this.apiKey,
        identity: candidate, // EXPLICIT candidate — never this.oktaIdentity
        sdkVersion: this.sdkVersion,
        transition,
        ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
        ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
      }
    );
    return this.postTransitionProof(TRANSITION_PROOF_PATH_V2, headers, body);
  }

  /**
   * `POST /api/v1/auth/transition-proof` — proves possession of an EXPLICIT
   * candidate OpenBox DID identity (the fresh one-time key returned by
   * reverse prepare), never this client's active identity. Same
   * non-negotiable as the Okta helper above (proposal §13.5 / §17.28).
   */
  async validateOpenBoxDidIdentityTransition(options: {
    transitionId: string;
    challenge: string;
    candidateIdentity: OpenBoxDidIdentityConfig;
    /** Optional local convenience check against prepare's non-secret metadata. */
    expectedTarget?: TransitionExpectedTarget;
  }): Promise<TransitionPreflightResult> {
    this.assertOpen();
    if (!options.candidateIdentity) {
      throw new OpenBoxConfigError(
        "validateOpenBoxDidIdentityTransition requires an explicit candidateIdentity; it never " +
          "falls back to the client's active identity (proposal §17.28)."
      );
    }
    assertCandidateMatchesExpectedTarget(options.candidateIdentity, options.expectedTarget);

    const candidate = AgentIdentity.fromPrivateKey(
      options.candidateIdentity.did,
      options.candidateIdentity.privateKey
    );
    const body = { transition_id: options.transitionId, challenge: options.challenge };
    const { headers, body: bytes } = prepareSignedRequest("POST", TRANSITION_PROOF_PATH_V1, body, {
      apiKey: this.apiKey,
      identity: candidate, // EXPLICIT candidate — never this.identity
      sdkVersion: this.sdkVersion,
      ...(this.sdkEngine !== undefined ? { sdkEngine: this.sdkEngine } : {}),
      ...(this.sdkLanguage !== undefined ? { sdkLanguage: this.sdkLanguage } : {})
    });
    return this.postTransitionProof(TRANSITION_PROOF_PATH_V1, headers, bytes);
  }

  /**
   * Prove possession of a prepared Keycloak workload CANDIDATE key (IAM v3):
   * candidate bootstrap, a one-minute client assertion for the candidate
   * client/key, then `POST /api/v3/auth/workload-transition/proof`.
   *
   * `candidatePrivateKey` is required — it never defaults to this client's
   * active key and is never stored. The helper works from any client mode (it
   * authenticates with the agent API key alone), never calls Keycloak, never
   * activates the candidate (a separate Backend action), never resends, and
   * never changes this client's active authentication state.
   */
  async proveWorkloadIdentityTransition(
    options: WorkloadTransitionProofOptions
  ): Promise<WorkloadTransitionProofResult> {
    this.assertOpen();
    return proveWorkloadTransition(
      {
        apiUrl: this.apiUrl,
        coreHeaders: () => this.coreHeaders(),
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs
      },
      options
    );
  }

  private async postTransitionProof(
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<TransitionPreflightResult> {
    const url = `${this.apiUrl}${path}`;
    let response: Response;
    try {
      response = await runAsInternal(() =>
        this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) })
      );
    } catch (e) {
      throw new OpenBoxNetworkError(`Cannot reach OpenBox Core at ${this.apiUrl}: ${errorMessage(e)}`);
    }
    if (response.status === 401 || response.status === 403) {
      const reasonCode = extractReasonCode(await safeText(response));
      const isV2Route = path === TRANSITION_PROOF_PATH_V2;
      if (reasonCode) throw isV2Route ? mapAssertionError(reasonCode) : mapSigningError(reasonCode);
      throw new OpenBoxAuthError(
        "Transition proof rejected (invalid candidate identity, transition ID, or challenge)."
      );
    }
    if (response.status !== 200) {
      throw new GovernanceAPIError(`Transition proof request failed: HTTP ${response.status}`);
    }
    return parseTransitionProofResponse((await response.json()) as Record<string, unknown>);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

// Destructive-operation classification for the `fail_closed_destructive` outage
// policy. A destructive op mutates external state; a read/idempotent op does not.
const DESTRUCTIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DESTRUCTIVE_DB_OPERATIONS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "UPSERT",
  "MERGE",
  "REPLACE",
  "CREATE",
  "DROP",
  "TRUNCATE",
  "ALTER",
  "GRANT",
  "REVOKE"
]);
const DESTRUCTIVE_FILE_OPERATIONS = new Set(["write", "append"]);

/**
 * True if the evaluate payload carries a span for a destructive operation — a
 * db/file WRITE or a non-idempotent HTTP method. Lifecycle events carry no spans
 * → not destructive → they stay available under `fail_closed_destructive`.
 * `function_call` and reads (GET/SELECT) cannot be classified destructive.
 */
function payloadHasDestructiveSpan(payload: JsonValue): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const spans = payload["spans"];
  if (!Array.isArray(spans)) return false;
  return spans.some(
    (span) =>
      typeof span === "object" && span !== null && !Array.isArray(span) && isDestructiveSpan(span)
  );
}

function isDestructiveSpan(span: Record<string, JsonValue>): boolean {
  switch (span["hook_type"]) {
    case "http_request": {
      const method = span["http_method"];
      return typeof method === "string" && DESTRUCTIVE_HTTP_METHODS.has(method.toUpperCase());
    }
    case "db_query": {
      const op = span["db_operation"];
      return typeof op === "string" && DESTRUCTIVE_DB_OPERATIONS.has(op.toUpperCase());
    }
    case "file_operation": {
      const op = span["file_operation"];
      if (typeof op === "string" && DESTRUCTIVE_FILE_OPERATIONS.has(op.toLowerCase())) return true;
      // fs write/append/read-write modes: w, a, r+, w+, a+.
      const mode = span["file_mode"];
      return typeof mode === "string" && /[wa+]/i.test(mode);
    }
    default:
      return false;
  }
}
