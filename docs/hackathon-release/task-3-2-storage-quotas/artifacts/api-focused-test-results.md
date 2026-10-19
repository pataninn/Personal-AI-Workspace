# Focused account storage API checks

Command:

```powershell
$files = Get-ChildItem backend/src/openapi -Filter '*.spec.ts' | ForEach-Object { $_.FullName }
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.cjs --runInBand --runTestsByPath backend/src/modules/storage-quotas/controllers/account-storage-router.spec.ts $files
```

Result: **12 test suites passed, 26 tests passed, 0 failed**. This includes the new controller HTTP suite and all 11 existing/new OpenAPI suites.

Coverage includes authenticated owner derivation and cross-owner isolation, exact decimal serialization above JavaScript's safe integer range, no-CSRF GET, unauthenticated early rejection, unlimited and zero limits, over-limit output, reconciling/unavailable null totals, the GET DTO/examples, and documented 413/503/409 error responses on the Task 3.2 persistent-write roster.

The route test uses isolated in-memory fakes with a real Express router and `GetSessionUseCase`; it does not exercise PostgreSQL, filesystem reservations, application composition wiring, or live quota enforcement. Main owns those integration checks and the combined backend typecheck.
