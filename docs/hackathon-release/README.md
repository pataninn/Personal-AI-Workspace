# Release documentation snapshots

Canonical working documents live in the surrounding workspace at `.codex/docs/hackathon-release/`. This directory stores reviewed historical snapshots after the owning baseline or implementation passes QA; edit the canonical documents first, rather than maintaining a second source here.

Architecture/task snapshots record the state reviewed at this commit. Pending commit identifiers in historical tracking snapshots are resolved in the canonical tracker after the commit exists. Source-relative links retain their original canonical workspace context and may require that surrounding workspace to resolve.

The baseline snapshot includes small sanitized CLI summaries, fixture browser observations and screenshots. The live screenshots cover only unauthenticated loopback login with certificate errors ignored. Fixture screenshots use simulated APIs; they do not prove live persistence or inference. Existing failed/skipped checks remain documented, and baseline QA PASS does not certify application release readiness.

No provider keys, passwords, raw model prompts, database dumps, traces or videos are included. Execution handoff notes are intentionally excluded. All artifacts referenced by this baseline QA evidence index are included beneath its artifacts directory.
