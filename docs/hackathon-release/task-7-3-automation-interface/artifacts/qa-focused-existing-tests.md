# Focused QA rerun: existing route and navigation tests

Date: 2026-10-21

Command, run from `Personal-AI-Workspace/frontend`:

```powershell
pnpm.cmd exec vitest run --config vitest.config.mjs --configLoader runner src/app/routes.spec.tsx src/widgets/project-navigation/ProjectHeader.spec.tsx
```

Result: **2 files passed, 4 tests passed** in 8.18 seconds. The only stderr output was React Router v7 future-flag notices; no test failed.
