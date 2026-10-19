# Task 4.1 final functional closeout

Date: 2026-10-19. This closeout reviews the frozen intended source, the final bounded E2E helper evidence, prior independent QA cycles, and the synthetic browser evidence for the remaining accepted viewport issue. It does not claim a live provider, deployed runtime, or production network check.

## Scope and source identity

The latest source change is limited to the two target-scroll calls in `frontend/e2e/run-recovery.preview.spec.ts`. The target is centered with the standard DOM `scrollIntoView` call. Ratio-1 viewport checks, cancellation ordering, idempotency, focus sequence, and viewport sequence remain unchanged. No product source changed in this final repair.

I recomputed SHA-256 on the app workspace and intended export. The recovery spec matches at `59C573C95120CFC944D8EC79DBB920AEDE661B0256A82604CD96CF8FF338F12B`. `ConversationPane.tsx` matches at `31EDDDEBC15F389478128D9047D6D560183416850E20870F57E712A44F00DFBB`; `ChatComposer.tsx` matches at `98F22765CF6F116BD24A06864DC03E7A48876BA831F973D1340E10EA8C5AB42F`. The task source manifest contains 152 entries and 152 unique paths.

## Final automated browser results

- The exact saved-run cancellation test passed 1/1 after the helper update.
- The full `run-recovery.preview.spec.ts` passed 2/2 with the existing ratio-1 and behavior assertions intact.
- The required six-spec Home/workspace preview set finished 17/18. Its one failure is `provider-permissions.preview.spec.ts:19`: before interaction at 1280×720, the disabled Send button is below the initial viewport. The assertion was not removed or weakened, and the result is not described as green.

Read-only synthetic-fixture checks show normal fill plus native Tab reaches the enabled Send control and brings it fully into view on desktop and a 390×844 emulated viewport. A fresh Ctrl+Enter submission creates exactly one matching synthetic chat-run request, retains the draft, and produces no consent dialog, decision request, provider-permission request, separate start request, external request, or unhandled API call. This supports classifying the initial-frame issue as Low visual/test debt; it does not replace the 17/18 result or claim an OS-keyboard test. The task's current-status evidence records that the user authorized deferring this minor visual issue to finish the project faster.

## Functional and risk review

The prior independent QA evidence and developer evidence cover the task contract: ownership and policy revision checks, Home/workspace scope intersection, selected-context boundaries, fail-closed unavailable policy/runtime handling, retired approval writes, automatic run/command transitions, cancellation and uncertain-outcome recovery, and persistence/provisioning behavior. The eight retired decision/mutation operations are documented as effect-free `409 POLICY_ACTION_RETIRED` responses; read/status/history and separate cancellation routes remain available. Migration and PostgreSQL tests cover backfill, provisioning, revocation, transaction behavior, and rollback guards.

Reviewed results include backend unit tests (151 suites / 902 tests), guarded backend integration tests (34 suites / 119 tests), focused independent PostgreSQL checks (3 suites / 6 tests), frontend Vitest (58 files / 298 tests with zero skips), backend/frontend/frontend-node TypeScript checks, focused OpenAPI tests (3 suites / 5 tests), preview API tests (26/26), and Linux bridge tests (48/48 with zero skips). The complete release evidence and second-cycle limitations are linked in the QA report. These suites were not rerun for this final test-helper-only change.

Security review found no remaining Critical or High issue in the reviewed code and evidence. Owner and scope authority stays server-derived, unavailable policy/runtime remains fail-closed, and the helper change does not affect authorization or egress. Playwright MCP and Chrome DevTools MCP were unavailable; local Playwright/Chrome evidence and source review are recorded as substitutes. Fixtures intercept requests and use synthetic data, so this evidence does not establish live provider admission, deployed bridge enforcement, public HTTPS, or production egress behavior. No material performance concern was introduced by the helper-only change. Disclosure, normal keyboard reachability, unavailable/error states, and recovery controls are covered; full assistive-technology testing is not claimed.

## Closeout decision

PASS with one explicit Low visual/test-debt exception under the user's faster-delivery priority. All six required preview specs must not be reported as passing: the final recorded result is 17/18. No authorization, scope, security, credit, quota, storage, or data-loss requirement is waived.

## Evidence references

- `artifacts/f3-native-center-validation.md` — final helper scope and exact automated results.
- `artifacts/provider-submit-diagnosis/validation.md` and `curated-geometry.json` — native keyboard reachability and single-submit request counts.
- `artifacts/qa-luna-independent-validation.md` and `qa-luna-second-cycle-validation.md` — independent test and review evidence, including prior findings and limitations.
- `artifacts/qa-repair-validation.md` and `artifacts/qa-repair-final/` — retired API contract, disclosure repair, focused tests, and reviewed UI captures.
- `artifacts/assistant-scope-policy-postgres-run.txt`, `assistant-scope-policy-final-migration-rerun.txt`, and `task-4-1-policy-authorized-change-set-pg.txt` — migration and persistence validation.
- `artifacts/bridge-command-validation.md` — isolated Linux bridge validation.
- `artifacts/task-source-manifest.txt` and `protected-task-only.patch` — intended source scope and authorized protected-file patch.
- `contract.md`, `ui-spec.md`, `dev-summary.md`, `.codex/docs/hackathon-release/tasks.md` Task 4.1, and `.codex/skills/definition-of-done/SKILL.md` — acceptance and workflow references.
