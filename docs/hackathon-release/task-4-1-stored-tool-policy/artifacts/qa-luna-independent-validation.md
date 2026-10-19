# Independent QA validation record

## Change history

- 2026-10-19: Luna MAX independently reviewed the frozen Task 4.1 source export and reran the relevant test layers. This is evidence for the first QA cycle, not a PASS verdict.

## Source identity and isolation

- Source under review: `.qa-worktrees/automatic-tools-sol-1792387594045` (`Personal-AI-Workspace` intended export), assembled from HEAD plus the 147 manifest paths. All 147 paths were present. The export is separate from the checkout that contains unrelated original user changes.
- The only approved task-only changes in protected files were the one draft-clear line and two timeline test fixture/copy lines recorded in `protected-task-only.patch`. Original user hunks remained outside the export. The Git index was empty; the QA run made no application or test-source edits.
- No sensitive filename hits were found in the source manifest. No local configuration, credentials, environment files, or raw browser traces were included in the intended task-source snapshot.

## Independent checks

- TypeScript: backend, frontend, and frontend-node type checks passed.
- Frontend: full Vitest run passed, 58 files / 297 tests, zero skips. Preview `node:test` API suite passed, 26 / 26.
- Backend: full Jest run passed, 151 suites / 902 tests. An earlier concurrent invocation had one unrelated five-second test timeout; its focused rerun passed 20 / 20, followed by the complete serial 151 / 902 pass.
- Guarded PostgreSQL: after validating the approved process-only fixture identity and that no task QA databases existed, Jest passed 3 focused integration suites / 6 tests: `assistant-scope-policy.integration.spec.ts`, `task-4-1-policy-authorized-change-set.integration.spec.ts`, and `policy-command-run-cancellation.integration.spec.ts`. The suites exercised the registered migrations, stored policy and claims, and cancellation locking. A separate fresh-process postflight revalidated the approved base identity and found every `home_history_task_%` target absent. The test window was released. No database URL or credential was printed or saved.
- Linux command bridge: using only the existing image `personal-ai-hermes@sha256:6c672fd4bdb49502b6407546c92fbb683dc1a08e65d5df31813a67488fd16a02`, the readonly intended-export bridge mount and the approved non-root, no-network, read-only, dropped-capabilities, no-new-privileges, PID/memory/CPU/tmpfs limits, the full Python suite passed 48 / 48 with zero skips and exit 0. A separate postflight found the exact `--rm` container absent and the image digest/platform unchanged. This proves local Linux isolation behavior, not deployed runtime/provider availability.
- Browser evidence reviewed: developer Playwright CLI/Chrome fixtures report 18 / 18 combined Home/workspace scenarios, 4 / 4 final recovery scenarios, and 3 / 3 settled viewport checks. The latter checks keyboard-scroll reachability, focus, hit testing, and full viewport intersection after user-operable scrolling. The initial programmatic scroll leaves a documented 0.296875px fractional edge and remains a limitation. These are synthetic preview fixtures, not live backend/provider proof.
- Tool availability: Playwright MCP and Chrome DevTools MCP were unavailable. Existing Playwright CLI/Chrome and image review were used and are identified as such; no missing MCP is claimed as run. Full screen-reader traversal, full tab traversal, workspace 320px/200% zoom, and light-theme checks remain unverified.

## Contract findings recorded in the QA report

1. `backend/openapi.json` and its OpenAPI assertions still advertise successful legacy decision/proposal writes, although handlers now return `409 POLICY_ACTION_RETIRED`. Examples include Home consent `200`, Home proposal edit/remove `200`, proposal acceptance `201` / replay `200`, proposal execution `200`, and workspace egress/change-set/command decisions `200`. Contract and UI spec require these retired mutation routes to have no success response and document the stable 409. This is a Medium contract-alignment finding.
2. The active Home and workspace surfaces mount `AssistantPolicySummary`, which shows scope, provider/model, readiness, included context, and permitted capabilities. It does not include the required non-modal explanation that deployment data is operator-managed, selected context is sent to the provider, and provider terms are available. The existing `ProviderTerms` appears only inside the removed per-turn provider-consent dialog. This is a Medium privacy-transparency/UI-spec finding, not evidence of an authorization bypass.

No Critical or High security finding was identified in the source, guarded persistence tests, or bridge tests. The application still reports unsupported deployed provider/runtime capability as unavailable; no live provider, external egress, deployed OpenShell, public HTTPS, or scheduled worker execution is claimed.

