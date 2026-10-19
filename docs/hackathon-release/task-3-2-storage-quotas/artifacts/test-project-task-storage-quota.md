# Project task storage quota PostgreSQL integration evidence

Run date: 2026-10-19

Command, run from `Personal-AI-Workspace/backend` with the protected fixture value set only in the Jest process environment:

```powershell
node .\node_modules\jest\bin\jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/project-task-storage-quota.integration.spec.ts
```

Final result: exit code `0`; 1 Jest suite passed, 1 test passed, 0 snapshots; Jest reported 5.776 seconds.

The test verified the allowed loopback PostgreSQL base identity (`home_test` on `home_history_test`), created only `home_history_task_3_2_task_test`, verified the isolated session identity, and ran all registered TypeORM migrations. After the run, an independent read-only query against the guarded base identity confirmed that the unique test database no longer existed (`owner=absent`). No database URL or credential was printed or saved.

Assertions covered project name/objective bytes; run-backed task suggestion content and acceptance; task text, checklist JSONB, and retained idempotency snapshot; action-ledger reversible/outcome JSONB and replay without a duplicate charge; a 413 positive-growth denial with rollback of task, event, receipt, references, and counters; and a permitted shrink while still over limit. Reference totals matched the canonical PostgreSQL scan. The action_ledger_records.request_fingerprint field is a SHA-256 request-identity hash used as metadata and was verified not to create a content reference. This is distinct from conversation_idempotency_keys.request_fingerprint, which stores raw retained request text/JSON and is charged by the conversation quota coverage. No provider or filesystem activity was performed; the legacy root exists only as a logical database fixture for the run/suggestion foreign-key path.

The first guarded attempt exposed an incomplete test matcher that omitted the expected subtasks reference; it was corrected. The passing result above is from the rerun with that assertion fixed.
