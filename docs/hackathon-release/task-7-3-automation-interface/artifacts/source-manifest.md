# Task 7.3 source and shared-hunk manifest

## New frontend source

- `frontend/src/entities/automation/model/types.ts`
- `frontend/src/entities/automation/api/automation-api.ts`
- `frontend/src/entities/automation/api/automation-api.spec.ts`
- `frontend/src/entities/automation/index.ts`
- `frontend/src/features/automation-management/model/automation-presentation.ts`
- `frontend/src/features/automation-management/model/automation-presentation.spec.ts`
- `frontend/src/features/automation-management/model/use-automation-management.ts`
- `frontend/src/features/automation-management/model/use-automation-management.spec.tsx`
- `frontend/src/features/automation-management/ui/AutomationScheduleForm.tsx`
- `frontend/src/features/automation-management/ui/AutomationScheduleCard.tsx`
- `frontend/src/features/automation-management/ui/AutomationRunHistory.tsx`
- `frontend/src/features/automation-management/index.ts`
- `frontend/src/pages/automations/AutomationsPage.tsx`
- `frontend/src/pages/automations/index.ts`
- `frontend/e2e/automation-interface.preview.spec.ts` (six cases)
- `frontend/playwright.automation.preview.config.ts` (selects only the Task 7.3 spec)

## Existing paths with Task 7.3 hunks

- `frontend/src/app/routes.tsx`: imports `AutomationsPage` and registers `/automations` under the existing authenticated shell.
- `frontend/src/app/routes.spec.tsx`: asserts the Automations route is registered.
- `frontend/src/entities/skill/api/skill-api.ts`: adds `listSkillsForWorkspace(workspaceId)` using the existing skills endpoint query.
- `frontend/src/entities/skill/index.ts`: exports that entity API method.
- `frontend/src/widgets/app-shell/AppShell.tsx`: adds the Automations breadcrumb label and navigation link.
- `frontend/src/widgets/project-navigation/ProjectHeader.tsx`: adds the workspace-prefilled Automations link.
- `frontend/src/widgets/project-navigation/ProjectHeader.spec.tsx`: asserts that link target.

No other shared-path hunks belong to Task 7.3. `frontend/playwright.preview.config.ts` remains untouched; the task-specific config imports and narrows its test selection.

## Boundaries and preserved concurrent work

No Task 7.3 backend, database, OpenAPI, provider, usage/export, or shared preview-config change. The existing workspace-export feature and protected AI-run/direct-chat work were outside this task's ownership and were left as found. In particular, Task 7.3 does not own `frontend/src/features/ai-run/model/use-ai-run-timeline.ts`, `use-direct-chat-consent.ts`, `use-direct-chat.ts`, `AiRunTimeline.spec.tsx`, untracked `use-direct-chat.spec.tsx`, `ponytail-review.md`, or `frontend/tsconfig.node.tsbuildinfo`.

The canonical Task 7.3 documentation mirror contains the updated `contract.md`, `dev-summary.md`, prepared `ui-spec.md`, pre-review report, and the complete `artifacts/` subtree. The canonical and application `docs/hackathon-release/tasks.md` files have identical SHA256 hashes; no additional tracker hunk was introduced by Task 7.3.
