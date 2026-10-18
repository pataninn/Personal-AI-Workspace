# HTTP ownership boundary test run

- Spec: `Personal-AI-Workspace/backend/test/integration/ownership-boundaries-http.integration.spec.ts`
- Command: `$env:pnpm_config_verify_deps_before_run='false'; pnpm.cmd --dir backend exec jest --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/ownership-boundaries-http.integration.spec.ts`
- Result: 1 suite passed, 3 tests passed, 0 snapshots; final Jest run completed in 4.922 seconds.
- Test shape: Supertest exercised the in-process Express app created by `createApp`; routes and use cases were real. Session, project, task, and run repositories were in-memory. Workspace reads used the real gateway adapter over a disposable temp directory.
- Coverage: each synthetic principal read its own project/files/tasks/run snapshot. Both principals were denied the other owner's project, file, task, and run event; valid foreign/missing IDs produced matching generic not-found errors, and serialized foreign responses did not expose the seeded marker strings. The admin denial for foreign files is explicit.
- Fixture cleanup: the suite creates its own `task-2-2-ownership-http-*` temp root and removes it in `afterAll`. Post-run check: zero matching temp directories remained.
- Scope limit: no PostgreSQL or external provider was used. The persisted-run workspace-tool adapter was not exercised because there is no production HTTP call site and its input seam is changing separately.

The first focused compile attempt found only errors in this new fixture's imported/implemented types; those fixture-only errors were corrected before the passing run. No production files were edited for this spec.
