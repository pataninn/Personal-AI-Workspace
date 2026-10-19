# Final verification: private demo admission

All commands ran from `Personal-AI-Workspace/backend` unless noted. PostgreSQL tests used the ACL-restricted isolated fixture on loopback port 55441 after validating its database, user, and target name. No connection string or credential was written to the artifact.

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Exit 0 |
| Focused run-start/auth unit tests | `node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath src/modules/ai-runs/use-cases/start-ai-run-use-case.spec.ts src/modules/ai-runs/use-cases/ai-run-use-cases.spec.ts src/modules/ai-runs/use-cases/change-set-use-cases.spec.ts src/modules/ai-runs/use-cases/sandbox-command-use-cases.spec.ts` | Exit 0; 4 suites / 81 tests |
| Full backend unit suite | `node node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand` | Exit 0; 140 suites / 838 tests |
| Guarded demo PostgreSQL suite | `node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand --runTestsByPath test/integration/demo-admission.integration.spec.ts` | Exit 0; 1 suite / 3 tests |
| Full backend integration suite | `node node_modules/jest/bin/jest.js --config jest.integration.config.cjs --runInBand` | Exit 0; 31 suites / 114 tests |
| Diff whitespace | `git diff --check` from app repository root | Exit 0; Git printed only the OpenAPI CRLF normalization warning |

The PostgreSQL run-start race pauses the production TypeORM repository immediately before `beginStart`, commits cancellation using the real cancellation use case, and then resumes the start. The start rejects with a state conflict; the run remains cancelled, no runtime starts, and no `demo_run_start_events` row is created.

The guarded target database was dropped by test teardown. A separate read-only check validated the base fixture identity and confirmed `home_history_task_3_3_demo_test` was absent. The base database was used only for fixture identity and target-existence checks; no user application database was accessed.

The initial broad integration run had 30 passing suites and one R1 fixture failure because its active demo account used an admission repository without configured limits. Production correctly failed closed. The R1 test now supplies explicit bounded test-only settings; the final 31-suite/114-test run passed.
