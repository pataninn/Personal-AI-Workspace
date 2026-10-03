---
name: existing-project-editing
description: Make focused changes while preserving an existing project.
---

# Existing project editing

## Procedure

1. Inspect relevant existing files and identify their roles and dependencies.
2. Confirm the requested outcome and preserve unrelated content, behavior, filenames, imports, and conventions.
3. Prefer targeted patch operations with exact existing text. If rewriting a file, retain all required unchanged sections and closing syntax.
4. Update connected files consistently. Do not invent missing source; request the needed Context selection.
5. Run available routine checks when useful. Resolve errors caused by your changes before finishing, within the run budget.

## Completion

Report prepared changes, checks performed, and unresolved issues honestly. A valid tool call alone does not prove the project works.
