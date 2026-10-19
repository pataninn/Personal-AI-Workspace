# F3 recovery helper validation and accepted composer viewport debt

## Source identity and scope

The accepted repair changes only the two scrolling call sites in frontend/e2e/run-recovery.preview.spec.ts to call the standard DOM scrollIntoView({ block: 'center', inline: 'nearest' }) on the target control. Cancellation ordering, idempotency, focus order, viewport loop, and ratio-1 assertions are unchanged. No product CSS or runtime source changed.

The actual app test file is byte-identical to the intended export: SHA-256 59C573C95120CFC944D8EC79DBB920AEDE661B0256A82604CD96CF8FF338F12B. Export and app workspace-redesign.css both hash to ADAECE73A6573B724E6BC7D68CBA7249B9C563340F29ECA656F02B4E8B0D095A. The task manifest remains 152 paths and already contains this test file.

## Preview results

The existing CSS-clean preview build was reused; no rebuild was needed for the test-only helper update.

- Exact saved-run cancellation test: 1/1 passed.
- Full run-recovery.preview.spec.ts: 2/2 passed, including cancellation, all recovery buttons, desktop/mobile/restored viewport checks.
- Required six-spec Home/workspace preview set: 17/18 passed. The single failure is provider-permissions.preview.spec.ts:19: its initial empty-draft assertion expects ai-run-submit to be inside the 1280×720 viewport before any interaction; the button is disabled and below the viewport (ratio 0). This assertion is unchanged. It is recorded as low visual/test debt, not a green result.

The read-only normal-input/Tab and Ctrl+Enter evidence is in provider-submit-diagnosis/validation.md and provider-submit-diagnosis/curated-geometry.json. It shows the enabled Send button is keyboard reachable and fully visible after normal interaction on desktop and a synthetic mobile viewport, and Ctrl+Enter sends the draft exactly once without a permission or decision request. No authentication, authorization, provider-admission, credit, quota, or data-loss requirement was waived.

Earlier red runs remain preserved in qa-repair-validation.md, qa-cycle-two-resolution.md, and their cycle artifacts. The native-End trial failure and earlier fractional status ratio are historical; the accepted centered DOM-scroll helper supersedes those scroll attempts. The 17/18 result remains explicitly visible for independent QA.

The owned preview process was stopped and postflight confirmed no task-owned preview listener remained.