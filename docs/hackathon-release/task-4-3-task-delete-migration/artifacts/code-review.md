# Code Review: Task 4.3 canonical task delete

### Summary

Canonical deletion uses the existing transactional task and ledger boundary. Archive conversion is content-preserving, and exact Home retries return the recorded receipt only after current gates. Focused unit/typecheck and guarded PostgreSQL migration/parity evidence passes.

### Findings

- No blocking Task 4.3 findings.
- Delete and undo replay check owner/key/fingerprint in the ledger use cases. The handler preserves principal, skill invocation/capability, and Home policy checks before replay; it performs no target/task lookup, mutation, event write, or workspace effect for an exact match.
- Task-create undo physically deletes task-scoped content. Workspace undo still blocks changed or nonempty workspaces and retains all prior ownership, version, root/folder, file mapping, provider/run, quota, and recovery checks.
- Migration 0036 preserves old task content during conversion and fails closed on rollback after deletion or later changes.
- Seven unrelated storage-quota OpenAPI 413 references are missing at HEAD and current; see `verification-receipt.md`.

### Verdict: APPROVED FOR QA