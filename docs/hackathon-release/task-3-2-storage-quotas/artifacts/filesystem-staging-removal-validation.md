# Task 3.2 Filesystem, staging, and removal validation

## Scope

This artifact records the filesystem quota reservation/settlement, durable project removal, and transient staging checks owned by `developer_storage_luna`. It is implementation evidence for those slices, not the independent Task 3.2 QA verdict. Main owns final cross-module typecheck, composition/startup verification, relational regression, and release-document consolidation.

## Filesystem and removal behavior

- Project-file mutations resolve an owner-scoped persisted root mapping, commit a durable growth reservation before filesystem I/O, and perform the file operation without holding a database transaction. Verified observed changes settle exact bytes; a verified no-side-effect failure releases the reservation; ambiguous outcomes remain reserved/unknown for reconciliation.
- Recovery copies use the configured recovery root and a durable `recovery-v1` reference. A project-removal job is committed before quarantine begins. Quarantine runs outside a database transaction; the final accounting transaction retains the project's authoritative root and deletes project-linked database content. Recovery references and the job are removed only after verified purge. Startup replay restores quarantined copies while the project exists and purges them after project deletion.
- Project removal's canonical pre-delete identity scope includes project conversation idempotency keys and Home content actually deleted by the current `0027` cascades: workspace Home conversation titles, messages, event `(conversation_id, sequence)` payloads, and proposal-item commands where either the proposal scope or parent Home conversation is attached to the project. Owner-scoped Home content survives and stays charged. Action-ledger receipts are intentionally retained. No migration lifecycle was changed.

## Staging limits and expiry

`LocalStagingGateway` redacts content before measuring UTF-8 bytes; it enforces 256 KiB per staged file and 2 MiB total per run, including the durable metadata marker. The marker records run ID, creation time, and a 24-hour expiry with a SHA-256 integrity checksum. Staging paths are generated from UUID run IDs and validated as direct children of the configured canonical root. Marker files are created exclusively and synced; staged files are created exclusively. Expired prepared references fail `assertFresh` before run start.

`cleanupExpired()` is single-flight per gateway instance and examines at most 128 sorted run directories per sweep. It deletes only expired directories with a valid marker; symlinked, aliased, malformed, or tampered entries are retained. Production scheduling is wired by main before readiness and hourly. Confirmed prepared-run cancellation attempts immediate staging cleanup after runtime destruction. Unknown runtime/cleanup outcomes retain staging for the bounded expiry sweep rather than claiming cleanup succeeded.

## Validation evidence

All commands below ran against the shared working tree with the direct local Jest runner; no package installation or lint tool was used.

| Check | Command / location | Result |
|---|---|---|
| Filesystem/quota/removal focused unit batch | From `backend`: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/infrastructure/database/repositories/typeorm-storage-quota-repository.spec.ts src/infrastructure/workspace/storage-quota-file-mutation.spec.ts src/infrastructure/workspace/storage-quota-reconciliation.spec.ts src/infrastructure/workspace/workspace-mutation-gateway.spec.ts src/infrastructure/workspace/project-recovery-cleaner.spec.ts src/infrastructure/workspace/project-file-gateway.spec.ts src/infrastructure/workspace/project-file-gateway-pinning.review.spec.ts src/infrastructure/database/repositories/typeorm-project-file-access.review.spec.ts src/infrastructure/database/repositories/typeorm-project-removal-repository.spec.ts src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts src/modules/storage-quotas/domain/storage-quota-policy.spec.ts src/modules/storage-quotas/domain/storage-file-operation-fingerprint.spec.ts` | Exit 0; 12 suites / 98 tests passed. |
| Staging/start/cancel focused unit batch | From `backend`: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/infrastructure/staging/local-staging-gateway.spec.ts src/modules/ai-runs/use-cases/start-ai-run-use-case.spec.ts src/modules/ai-runs/use-cases/ai-run-use-cases.spec.ts src/modules/ai-runs/use-cases/direct-egress-use-case.spec.ts` | Exit 0; 4 suites / 57 tests passed. |
| Project-removal repository unit suite (final source) | From app root: `node backend/node_modules/jest/bin/jest.js --config backend/jest.config.cjs --runInBand --runTestsByPath backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.spec.ts` | Exit 0; 1 suite / 14 tests passed. |
| Project-removal PostgreSQL integration (final expanded spec) | From app root: `node backend/node_modules/jest/bin/jest.js --config backend/jest.integration.config.cjs --runInBand --runTestsByPath backend/test/integration/project-removal-storage-quota.integration.spec.ts` | Exit 0; 1 suite / 2 tests passed (6.669 s). The fixture target was checked without printing its URL: loopback port 55441, `home_test` / `home_history_test`. The test itself creates and drops its isolated database. |
| Whitespace/conflict check | From app root: `git diff --check` | Exit 0. Git printed only existing CRLF-to-LF notices for `backend/openapi.json` and `typeorm-home-conversation-repository.ts`. |

The first run of the expanded PostgreSQL spec exited 1 because the newly added Home-reference assertion selected only `resource_key` while expecting `copy_key` and `byte_count`. The usage assertion had already passed; this was a test projection mismatch, not a runtime quota failure. The query was corrected to select the asserted columns and the final guarded rerun passed 2/2.

The separate managed-orphan startup PostgreSQL suite was run by main, not by this slice. The final broad backend typecheck and independent QA result are also owned by main/tester and are intentionally not claimed here.

## Changed files in this slice

- `backend/src/infrastructure/database/repositories/typeorm-project-removal-repository.ts`
- `backend/test/integration/project-removal-storage-quota.integration.spec.ts`
- `backend/src/infrastructure/database/repositories/typeorm-project-file-access.review.spec.ts` (fake updated for the shared root-mapping API)
- `backend/src/infrastructure/workspace/workspace-mutation-gateway.spec.ts` (fake updated for the shared root-mapping API)
- Filesystem reservation, recovery, staging, and run-use-case paths under `backend/src/infrastructure/workspace/`, `backend/src/infrastructure/staging/`, and `backend/src/modules/ai-runs/` previously listed in the task handoff and exercised by the focused batches above.
