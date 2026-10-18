# Developer self-review: atomic credit reservations and runtime metering

## Summary

The credit ledger uses PostgreSQL transactions and integer arithmetic to reserve a bounded maximum charge before a supported direct-provider POST. Every other inference route remains unavailable until its send boundary can enforce per-attempt admission; no request is sent without required configuration, a verified input bounder, and a successful reservation.

## Findings and resolutions

- **Unsupported billing boundaries:** The checked-in Hermes bridge does not expose every real provider attempt, retry, fallback, and usage report. Client-side HTTP hooks could be bypassed by alternate egress. Project and Home Hermes runtimes are explicitly disabled in production composition before bridge create. The direct provider is also denied before fetch because the checkout has no endpoint-verified input token bounder. No guessed model-wide context size or price enables billing.
- **Transaction scope:** Admission, settlement, and release use short transactions with a deterministic global-policy/user/account-limit/account-usage/window/budget/reservation lock order. Provider fetch and Hermes bridge work occur after the transaction returns; no account or ledger lock is held during inference.
- **Unknown billing outcome:** After the direct POST boundary, malformed/missing usage and transport/cancellation outcomes retain the maximum reservation as unknown. Only known-not-sent outcomes release it. A representable over-bound report is charged as reported, marks the attempt over-bound, and pauses later admissions. If a valid report computes above PostgreSQL bigint, settlement records actual token counts, marks the reservation unknown with `usage_charge_overflow`, leaves the maximum reserved, and pauses further admissions in the same transaction. It does not persist a truncated charge or let settlement roll back the pause.
- **Identity and counters:** Reservations use the trusted owner ID and persisted account kind/status. Account/daily/demo campaign and window counters are updated in the same transaction as the immutable reservation. `account_limits` is created lazily by the production repository for an account lacking a row; the PostgreSQL test now exercises that path.
- **Mixed Task 3.2 handoff:** `data-source.ts` contains a separate 1710000029000 import/registration owned by Task 3.2. Task 3.1's eventual commit must stage only the 1710000028000 hunk and preserve the 0029 worktree change for the storage task.
- **Test-fixture correction:** The first PostgreSQL attempt revealed that test users inserted after migrations did not receive migration-seeded `account_limits`; a test-only update therefore changed zero rows. The fixture now explicitly seeds the regular account limit and verifies lazy row creation for the demo account. The overflow integration case uses a separate regular account so earlier retained reservations cannot affect its expected counters.
- **Global demo races:** Independent demo accounts race against deployment-wide daily and campaign caps. PostgreSQL confirms that only one reservation wins each cap and the aggregate reserved counter equals the admitted amount.
- **Migration-chain compatibility:** The populated R1 migration fixture no longer asserts that migration 0027 is globally latest. It confirms the ownership-boundary migration remains applied and dynamically unwinds it and any later additive migrations before running its existing rollback checks. Existing owner, session, ownership, and legacy-data assertions remain intact.

## Verification state

- Broad backend unit regression passed: 129 suites / 770 tests. Backend TypeScript typecheck passed after the final implementation and test edits.
- Full isolated PostgreSQL integration regression passed: 24 suites / 98 tests, including migrations 0028 and 0029. The focused credit-ledger suite passed 7/7 and the populated migration suite passed 3/3.
- No live provider/network call, production price, hosted endpoint tokenizer parity, Hermes all-egress enforcement, or deployed-host attestation was exercised or claimed.
