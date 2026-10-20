# Task 7.3 browser and preview attempt history

The production-preview tests use the installed Chromium binary and a route fixture for all `/api/v1/` calls. No live backend, user database, or provider was contacted. Playwright clears its configured output directory at each run, so this file records the earlier attempts whose original Playwright output was replaced by later runs. The second full-run failure bundle is retained under `attempt-02/`; the final passing run is under `final/`.

## Preview startup attempts

1. Owned PID 2168 was started from the app root, where the production `dist` directory was absent. The attempt was stopped by its exact PID.
2. Owned PID 36468 was started from `frontend` using Vite's default config loader and hit a sandbox access-denied error. The attempt was stopped by its exact PID.
3. Owned PID 23612 used `--configLoader runner` and printed its preview URL, but the initial readiness guard relied on a TCP enumeration that could not see the sandbox child listener. That owned attempt was stopped. Root clarified that HTTP readiness is authoritative in this environment.
4. The working preview used the installed Vite CLI from `frontend` with `--config vite.config.mjs --configLoader runner --host 127.0.0.1 --port 5173 --strictPort`. Owned PID 34740 returned HTTP 200 and hosted all six tests. Afterward that exact PID was stopped and a fetch to port 5173 returned `ECONNREFUSED`.

## Browser attempts

1. The initial full six-case run failed at test-harness selectors (duplicate Create/Run now buttons and the Time label matching Time zone) and exposed an unstubbed shell request to `/api/v1/account/usage`. The delivered account-usage DTO was added to the route fixture. The initial output directory was overwritten by subsequent Playwright runs, so only this summary of that attempt remains.
2. A focused pause/resume diagnostic identified the missing usage stub as the only unexpected 404.
3. The next full run passed 4/6. All tested user flows completed, while two assertions had incorrect regular-expression expectations for Chromium's handled 409/422 resource messages. The six-case run directory is archived at `attempt-02/`.
4. The final same-scope run passed 6/6. Expected resource messages are narrowly asserted for only the deliberate 409 conflict, 422 budget response, and aborted network request. Every case asserts no uncaught page errors; all other cases assert no resource errors. Final screenshots and Playwright status are under `final/`.

## Final six cases

1. Create an enabled schedule; invalid IANA zone focuses the field, then valid `Asia/Shanghai` saves the server-provided due time.
2. Pause and resume with the latest server revision while retaining history.
3. Preserve edit values after a revision conflict and reload the latest schedule only on explicit action.
4. Run a paused schedule without consent; show the ready notice, source task/provider usage fields, and open the saved Home result.
5. Show budget exhaustion and retry an uncertain Run now with the exact same empty body and idempotency key.
6. At 390px width, open and close navigation by keyboard, create a schedule by keyboard, focus invalid timezone feedback, and assert no horizontal overflow.
