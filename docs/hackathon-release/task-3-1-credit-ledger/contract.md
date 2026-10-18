# Contract: Atomic credit reservations and runtime metering

## Change History

- 2026-10-19: Initial developer contract, based on release architecture §§7.1/10 and the runtime-metering preflight. No provider pricing or live inference is assumed.

## Ownership

- A credit decision uses the owner UUID from the persisted run/project or conversation and the account kind/status from PostgreSQL. Browser, model, bridge, and caller-supplied owner fields are not authority.
- Task 3.1 owns the shared `account_limits` row's credit fields. Task 3.2 may extend that same row with `storage_limit_bytes`; it must not add a duplicate per-owner limits row.
- Runtime credit counters and call reservations are separate persistence records. Provider and bridge adapters receive only an admission port, never SQL or account-limit mutation authority.
- The deterministic database lock order is: singleton inference policy -> persisted user row -> `account_limits` -> lifetime usage -> account daily window -> demo UTC daily window -> demo campaign window -> reservation/settlement rows. No provider, bridge, or filesystem I/O runs while these locks are held.

## Scope

- Persist integer account limits, lifetime/daily usage, deployment-wide demo daily/campaign usage, versioned per-call reservations, unique settlements, and an operator inference pause.
- Gate every supported paid send before transmission. Direct provider calls require an exact, versioned input-token upper-bound implementation, explicit rates and token caps, and an atomic reservation. Any missing or invalid prerequisite denies the call before `fetch`.
- The checked-in Hermes ACP boundary does not expose all actual model attempts/retries or per-call usage. Project Hermes and Home-planning Hermes calls therefore fail closed before bridge create until a real provider-send hook enforces and accounts for each attempt. Synthetic ACP events are not billing evidence. Unsupported OpenShell remains unavailable. The fake runtime is non-billable and does not send to a provider.
- No public API or OpenAPI schema changes are introduced in this task. Admin-facing budget editing remains with Task 3.6; this task seeds safe defaults and provides persistence/admission behavior.

## Endpoints / Events

- HTTP endpoints: none added or changed.
- Direct provider internal boundary: `IProviderCallCreditAdmission.reserveBeforeSend(...)` is awaited after request construction/validation and immediately before the provider POST. The request is not sent if admission fails. The existing `provider.request_started`, response, and usage events retain their external shape.
- Internal call identity is `(ownerId, sourceKind, sourceId, callId, attemptId)`. Direct project inference uses the persisted AI run ID, a stable primary-call key, and attempt `1`. Replaying an already-admitted attempt cannot trigger a second POST; a genuine retry requires a new attempt ID and its own reservation.
- Hermes project and Home-planning start paths return the existing safe unavailable/failure behavior before bridge create while the bridge lacks actual-call instrumentation.

## Request Shapes

Operator-supplied direct-provider configuration is all-or-none:

```text
NIM_CREDIT_PRICE_VERSION
NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS
NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS
NIM_MAX_INPUT_TOKENS
NIM_MAX_OUTPUT_TOKENS
NIM_MAX_PROVIDER_CALLS_PER_RUN
```

- No price, tokenizer, token-limit, or per-run attempt defaults are invented. An absent complete six-field configuration leaves inference unavailable; partially supplied or malformed configuration is rejected. Rates are canonical positive integer decimal strings. Token maxima are positive integers; the output maximum cannot exceed the request adapter's existing hard ceiling of 16,384. The per-run attempt maximum is an integer from 1 through 32 and is applied to each persisted source's durable admission budget.
- The injected input bounder receives the exact provider model and fully assembled request messages and returns a proven upper bound plus its implementation/version identifier. An estimate such as UTF-8 bytes divided by four is not acceptable. If no verified bounder is wired for the selected model, direct sends are denied.
- The provider sends `max_tokens = NIM_MAX_OUTPUT_TOKENS`; it does not accept a caller/model-selected larger cap.
- Reservation inputs include owner UUID, source kind/UUID, call/attempt keys, provider profile/model, price version and rate snapshot, input-bounder version, maximum input/output tokens, and computed maximum credit units. All values originate from trusted runtime/configuration state.

## Response Shapes

- No public DTO changes.
- A successful internal admission returns a reservation UUID and the immutable maximum charge. The reservation is durable before the provider POST begins.
- A valid provider usage report settles the reservation once and creates one immutable usage entry. Usage must contain nonnegative safe-integer prompt and completion token counts; if total is present, it must equal their sum.
- Missing, partial, malformed, conflicting, or late usage leaves the maximum reservation held in `unknown` state for reconciliation. Cancellation, transport failure, or an absent usage chunk does not release it.
- A report exceeding the admitted bound is recorded at its reported cost, marks the call over-bound, and pauses further inference when the amount is representable by PostgreSQL bigint. If a valid provider report computes to an amount above bigint, settlement atomically records its token counts, marks the reservation unknown with `usage_charge_overflow`, retains the maximum reserved counters, and pauses further inference. It creates no invalid/overflowed charge entry and is not treated as a successfully charged call; the exact amount remains reconcilable from the immutable rate snapshot and token counts.

## Validation and Error Cases

- One displayed credit is exactly `1,000,000` integer credit units; one unit is one-millionth of a displayed credit. Input and output rates are stored as credit units per 1,000,000 tokens. Cost is computed with `BigInt` and rounded up separately per side:

  `ceil(inputTokens * inputRate / 1,000,000) + ceil(outputTokens * outputRate / 1,000,000)`.

- Account daily and lifetime limit `null` means unlimited; `0` means no spending. Admission evaluates settled plus currently reserved units and enforces each non-null limit independently. Lifetime usage never resets on sign-out, session replacement, timezone changes, or daily-window rollover.
- The account daily window is a local calendar day in the active IANA timezone, represented by persisted UTC start/end instants and timezone. A timezone change is queued for the next midnight in the old timezone. It takes effect at that boundary; the first new-zone window starts at the effective instant and ends at the next local midnight in the new zone. The old window is not rewritten, and reservations settle into the window captured at admission.
- The deployment demo daily window uses UTC midnight boundaries. The demo campaign window is deployment-wide and keyed by an operator-controlled campaign ID. Missing demo daily/campaign limits or campaign ID means unconfigured and denies demo inference; explicit zero denies. No cookie/session reset creates new budget.
- The singleton policy row is seeded with inference paused. A pause committed before admission denies the call; a reservation admitted first is treated as in-flight, without claiming an atomic ordering with an external network send. Each subsequent provider attempt requires its own admission.
- Account and demo reservations lock rows in the order defined above. Account updates, timezone changes, pause/budget updates, reservations, settlements, and releases use transactions and integer arithmetic. Lock order is shared with Task 3.2 through `account_limits`.
- Denial outcomes are internal (`paused`, `unconfigured`, `missing_bound`, `limit_exceeded`, `account_inactive`, `duplicate_attempt`, or `ledger_unavailable`). The current public run API keeps its existing response envelope and safe provider-failure event; no new API error code is promised by this task.
- A known-not-sent attempt may release its reservation. Once the POST boundary has been crossed, only a validated usage settlement or explicit trusted reconciliation may release unused units. Unknown outcomes retain the full maximum.
- An unrepresentable usage charge returns an internal `unknown` settlement result with reason `usage_charge_overflow`; it preserves the provider-reported token counts for reconciliation, keeps the full reservation, and globally pauses admission in the same transaction. No PostgreSQL bigint counter or usage row is written with an overflowed value.

## Versioning / Compatibility Notes

- The schema is additive: existing users, AI runs, Home conversations, and provider usage fields remain intact. `account_limits` is seeded once per existing user with null credit limits and the documented default timezone `Asia/Shanghai`; new accounts receive the same row lazily or at account creation. The default limits are unlimited for regular accounts, but the global pause and missing prices/bounds still fail closed.
- Per-reservation rows snapshot price version, provider/model, rates, token maxima, bounder version, daily-window identities, and maximum units. Reusing a price version with changed rates does not alter historical reservations; operator configuration must still change the version when prices change.
- Existing `ai_runs.provider_*_tokens` remain descriptive run aggregates, not the credit ledger. No historic usage is back-billed because the provider price was not configured and per-call usage is unavailable.
- No migration moves workspace data. The account limits row is the shared extension point promised to Task 3.2.

## Open Questions

- The operator must supply and verify actual provider price version/rates and budget values before enabling paid inference. No production values are selected here.
- The repository currently has no verified tokenizer for the configured Nemotron model and no bridge hook for Hermes actual inference attempts/retries. Until those upstream enforcement points exist, the corresponding runtime modes remain fail-closed; no live inference or public readiness is claimed.
- Provider-side retries, billing on transport loss, and delayed external usage reconciliation are not established from this checkout. The application reserves conservatively and keeps unknown calls held pending trusted reconciliation.
