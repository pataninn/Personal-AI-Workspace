# Conversation storage quota PostgreSQL test

Run date: 2026-10-19

Command, run from `Personal-AI-Workspace/backend` with the protected fixture variable supplied only in the process environment:

```powershell
node .\node_modules\jest\bin\jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/project-conversation-storage-quota.integration.spec.ts
```

Result: exit code `0`; 1 Jest suite passed, 1 test passed, 0 snapshots; Jest reported 7.399 seconds.

The spec verified its base connection against the allowed loopback test identity, created only `home_history_task_3_2_conversation_test`, confirmed the isolated database session, ran every registered TypeORM migration, then dropped the database after the test. A separate read-only query confirmed that database was absent afterward. No connection URL or credential was emitted.

The test exercised the real PostgreSQL conversation and storage-accounting repositories. It verified exact `octet_length`/UTF-8 accounting for the title, message, and retained idempotency fingerprints, no additional charge on replay, rollback of denied positive growth, foreign-owner not-found, and denial after a committed project-removal barrier. Conversation retained payloads here are text; the removal job’s `run_ids` JSONB is metadata and is excluded from content usage.
