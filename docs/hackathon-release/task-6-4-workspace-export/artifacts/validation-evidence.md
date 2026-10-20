# Task 6.4 validation evidence

## QA1 repair checks

- Backend typecheck, from `backend`: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` — PASS, exit 0 after the gateway and probe-port changes.
- Focused backend Jest, from `backend`: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/openapi/workspace-export-openapi.spec.ts src/infrastructure/workspace/project-file-gateway.spec.ts src/modules/workspace-exports/use-cases/create-workspace-export.spec.ts src/modules/workspace-exports/use-cases/reconcile-workspace-exports.spec.ts src/infrastructure/workspace-export-process-identity.spec.ts` — PASS, 5 suites / 25 tests. The gateway spec alone passed 9/9.
- Direct file-boundary fixture calls `ProjectFileGateway.captureForExport` against real temporary directories on Windows. It verifies complete nested text/binary bytes, `.env`/credentials/recovery omission, `422 EXPORT_CONTENT_UNSAFE`, traversal and junction rejection, changed-file detection, incomplete-directory failure, deadline, and file-count bounds. A local capability probe confirmed a Windows junction was created and `lstat().isSymbolicLink()` returned true; capture rejected it.
- Architecture check: `reconcile-workspace-exports.ts` no longer imports infrastructure. The application defines `WorkspaceExportBuilderProbe`; the composition root injects `probeWorkspaceExportBuilder`. Existing unit and integration construction sites pass an explicit probe.
- Limits: these temporary-tree tests use the explicitly named test filesystem seam to exercise the actual gateway method and portable path policy. They do not prove Linux descriptor pinning, `/proc/self/fd`, race-resistant `O_NOFOLLOW`, or non-Windows reparse behavior. Production capture remains Linux-only and retains its descriptor path.

## Earlier implementation checks retained

- Backend typecheck, from `backend`: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` — PASS, exit 0.
- Frontend typecheck, from `frontend`: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` — PASS, exit 0.
- Earlier focused backend Jest: 5 suites / 19 tests passed before the QA1 repair. Those persistence, expiry, and UI-independent results remain applicable; the repair-specific command above adds direct gateway coverage.
- Preview build, from `frontend`: `node node_modules/vite/bin/vite.js build --mode preview --config vite.config.mjs --configLoader runner` — PASS. Vite reported existing Radix `use client` bundling notices and the existing >500 kB chunk warning.
- Browser: `PAI_PREVIEW_BASE_URL=http://127.0.0.1:5173`, `PAI_E2E_OUTPUT_DIR=test-results/task-6-4-workspace-export-security-final`; `node node_modules/@playwright/test/cli.js test --config playwright.preview.config.ts workspace-export.preview.spec.ts` — PASS, 2 cases. All API endpoints were route-stubbed; no live backend, database, or provider was used. The preview server was stopped and port 5173 verified unreachable.
- PostgreSQL: the approved `test/integration/workspace-exports.integration.spec.ts` run — PASS, 1 suite / 3 cases. A same-process preguard verified base database `home_history_test`, role `home_test`, isolated target `home_history_task_6_4_workspace_exports_test` absent, and zero target sessions. The integration spec created and normally dropped only that owned target. A fresh separate-process postguard verified the target absent and zero sessions. The launcher used the approved fixture key in process memory and emitted no URL or credential.
- Task tracker sync: canonical `.codex/docs/hackathon-release/tasks.md` and app `docs/hackathon-release/tasks.md` are byte-identical (SHA-256 `E7505D28D3101C58DE84935A291E30A9788E4D76231C77FA8308AB1CDEA637FA`).
- Evidence snapshot: canonical and app task artifact folders each contain 6 files (1 final screenshot, 1 preserved failed-run screenshot, 1 Playwright error context, 1 Playwright trace, this evidence note, and the source manifest). Both approved runtime windows were explicitly released.

## PostgreSQL attempt history

The first two attempts were command/config discovery failures before Jest launched; each was followed by a fresh postguard that found the target absent with zero sessions. The first launched three-case run failed all creates with the sanitized `EXPORT_FAILED` response; its postguard passed. The next run exposed a `status <> 'archived'` predicate that no longer matches the migrated task enum; its postguard passed. The task projection was corrected to include all current task rows. A subsequent full run passed 3/3 with normal owned-database teardown and clean postguard. After the DB-clock replay/download/startup-cleanup changes, the same exact three-case run passed 3/3 again with the same preguard, normal teardown, and fresh postguard. No failed attempt was force-cleaned or followed by a session termination.

## Browser attempt history

The first preview run had 1 pass / 1 fail because the assertion treated Playwright's `Download` object like a plain object. Its trace, error context, and screenshot are retained under `browser/test-results/task-6-4-workspace-export/`. The assertion was changed to read `suggestedFilename()`. The same two cases then passed. After the UI gained its explicit 422 credential-like-content response and key rotation, the final same-scope run passed 2/2; its screenshot is `browser/security-final/workspace-export.preview-k-ace33-te-response-after-switching.png`. The final test covers uncertain create retry, workspace switch/late response, 413, 422, 429, and unavailable download.

## Limits

The PG test injects an in-memory artifact store, so it proves PostgreSQL schema/ownership/idempotency/expiry/auth/header/cleanup-fence behavior but not the Linux temp-directory implementation. The production artifact adapter and `/proc` liveness probe were not run on a Linux application container; these remain a deployment-runtime boundary. Preview API behavior is stubbed by design. Type checks and tests were limited to Task 6.4; no full repository suite or platform matrix was run.

The earlier 3-case PostgreSQL run, 2-case preview browser run, frontend typecheck, and preview build were not rerun: the repair changes only gateway capture/error mapping, reconciliation dependency wiring, and backend coverage. The QA2 reviewer should use the retained integration/UI results for their unchanged surfaces and the new 25-test/type evidence for this repair.
