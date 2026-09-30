# MVP2 Decision Gate: Scheduling and Voice

**Date:** 2026-09-30
**Scope:** Task 6.5 decision only; no feature implementation is authorized.
**Disposition:** Defer scheduling/autonomy and voice pending evidence of a recurring user need. Neither capability is approved for implementation.

## Evidence reviewed

- The user said there were no real usage examples to provide for Task 5.3 and asked to skip collecting them for the current baseline.
- No repeated scheduling or voice problem, current workaround, or desired outcome has been described.
- The user has not explicitly approved either feature.

This supports a defer recommendation; it does not prove that these features have no value or claim that the user requested their rejection.

## Scheduling and autonomous work

**Problem hypothesis, not validated:** A user may want a recurring or time-triggered project task to run without opening the workspace.

**Decision:** Defer. There is no real workflow, frequency, or saved effort to measure. The MVP2 run model also does not provide durable job scheduling, worker leases, missed/duplicate-run recovery, or operator observability.

**Minimum safe scope if later approved:** User-created and project-scoped schedules; visible next-run time; a pause/revoke control; single-run idempotency and bounded concurrency; per-run provider disclosure and current permission checks; separate file-change and command approvals. No schedule may grant broader provider, file, or command authority.

**Privacy and failure controls to require:** Explain that scheduled runs may send reviewed project context at a later time; do not rely on an old file-change approval; preserve exact scope and revocation; expose missed, delayed, duplicate, failed, and cancelled runs; never silently catch up with an unbounded burst. Durable execution and reconciliation are prerequisites.

**Possible measures for a future contract:** User-reported time saved; requested versus completed scheduled runs; missed/duplicate rate; scope violations (target zero); and time from pause/revoke to prevention of the next run. Thresholds must be set from actual use before implementation.

## Voice input and output

**Problem hypothesis, not validated:** A user may want hands-free input or spoken responses while using the workspace.

**Decision:** Defer. No repeated typing, accessibility, or response-consumption problem has been described, so the value/privacy tradeoff and preferred modality are unknown.

**Minimum safe scope if later approved:** Explicit push-to-talk; show and let the user correct the transcript before submitting; keep audio out of persistent storage by default; make spoken output opt-in; preserve the existing provider disclosure and permission flow. No always-on capture.

**Privacy and failure controls to require:** Clearly identify microphone activation and any external speech-processing destination; request browser permission only from a user action; support denial and unavailable-device states; give the user a typed fallback; do not submit misunderstood text without review.

**Possible measures for a future contract:** Task completion compared with typed input; transcript correction rate; time to complete; user-reported accessibility or hands-free benefit; and audio/transcript retention and egress checks. Thresholds must be set from actual use before implementation.

## Revisit trigger

Revisit each capability independently when the user can provide concrete examples from repeated use: what they were doing, how often it happened, the current workaround, the impact, and the desired result. Create a separate scoped task and obtain explicit user approval before implementation. MVP3 remains gated on the broader MVP2 regular-use exit evidence and separate user approval for production investment.

## Approval status

| Capability | Gate decision | User approval to implement | Follow-on task |
|---|---|---|---|
| Scheduling/autonomy | Deferred pending repeated-use evidence | Not granted | None |
| Voice input/output | Deferred pending repeated-use evidence | Not granted | None |
