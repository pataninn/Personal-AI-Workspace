# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-export.preview.spec.ts >> keeps an uncertain retry on its workspace and ignores its late response after switching
- Location: e2e\workspace-export.preview.spec.ts:16:1

# Error details

```
Error: expect(received).resolves.toMatchObject(expected)

- Expected  -  2
+ Received  + 11

- Object {
-   "suggestedFilename": "workspace-export-6c640000-0000-4000-8000-000000000002.json",
+ Download2 {
+   "_artifact": Object {
+     "_guid": "artifact@f309e196fecd4134a786483adccc0edb",
+     "_type": "Artifact",
+   },
+   "_page": Object {
+     "_guid": "page@9246c9966d734753ce6e3798026d1e47",
+     "_type": "Page",
+   },
+   "_suggestedFilename": "workspace-export-6c640000-0000-4000-8000-000000000002.json",
+   "_url": "blob:http://127.0.0.1:5173/7b1d54a4-2938-4ed6-8901-de2ab561fd5a",
  }
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - status [ref=e3]: "Preview mode: mock data only; no real workspace or AI connection"
  - generic [ref=e4]:
    - complementary "Primary navigation" [ref=e5]:
      - link [ref=e6] [cursor=pointer]:
        - /url: /dashboard
        - text: P
        - generic [ref=e7]: Personal AIWorkspace
      - navigation "Primary navigation" [ref=e8]:
        - link "Home" [ref=e9] [cursor=pointer]:
          - /url: /dashboard
        - region [ref=e13]:
          - heading "Projects" [level=2] [ref=e14]
          - link "+ New project" [ref=e15] [cursor=pointer]:
            - /url: /dashboard?create=1
          - navigation "Active projects" [ref=e16]:
            - link "Alpha workspace" [ref=e17] [cursor=pointer]:
              - /url: /projects/873c096a-bc57-4a0c-85da-10d4febde961
            - link "Beta workspace" [ref=e22] [cursor=pointer]:
              - /url: /projects/873c096a-bc57-4a0c-85da-10d4febde962
        - link "Usage" [ref=e27] [cursor=pointer]:
          - /url: /usage
    - generic [ref=e29]:
      - banner [ref=e30]:
        - navigation "Current page" [ref=e31]:
          - strong [ref=e32]: Home
        - text: P
        - button "Account menu for Preview owner" [ref=e35] [cursor=pointer]:
          - generic [ref=e38]: Account
      - main [ref=e39]:
        - main [ref=e40]:
          - generic [ref=e41]:
            - generic [ref=e42]:
              - paragraph [ref=e43]: Account
              - heading "Usage" [level=1] [ref=e44]
              - paragraph [ref=e45]: Your current account allowances and logical workspace storage.
            - link "Back to workspace" [ref=e46] [cursor=pointer]:
              - /url: /dashboard
          - region "Account usage totals" [ref=e47]:
            - generic [ref=e48]:
              - heading "Daily credits" [level=2] [ref=e49]
              - paragraph [ref=e50]: No AI usage yet.
              - generic [ref=e51]:
                - term [ref=e52]: Allowance
                - definition [ref=e53]: "100"
                - term [ref=e54]: Consumed
                - definition [ref=e55]: "0"
                - term [ref=e56]: Pending reservations
                - definition [ref=e57]: "0"
                - term [ref=e58]: Remaining
                - definition [ref=e59]: "100"
              - paragraph [ref=e60]: Resets Oct 20, 2026, 8:00 AM (UTC).
            - generic [ref=e61]:
              - heading "Lifetime credits" [level=2] [ref=e62]
              - paragraph [ref=e63]: No AI usage yet.
              - generic [ref=e64]:
                - term [ref=e65]: Allowance
                - definition [ref=e66]: 1,000
                - term [ref=e67]: Consumed
                - definition [ref=e68]: "0"
                - term [ref=e69]: Pending reservations
                - definition [ref=e70]: "0"
                - term [ref=e71]: Remaining
                - definition [ref=e72]: 1,000
            - generic [ref=e73]:
              - heading "Workspace data storage" [level=2] [ref=e74]
              - generic [ref=e75]:
                - term [ref=e76]: Used
                - definition [ref=e77]: 17 B (17 bytes)
                - term [ref=e78]: Reserved
                - definition [ref=e79]: 0 B (0 bytes)
                - term [ref=e80]: Limit
                - definition [ref=e81]: 1 kB (1000 bytes)
              - paragraph [ref=e82]: Updated Oct 20, 2026, 4:00 PM.
          - region "AI availability" [ref=e83]:
            - generic [ref=e84]: AI budget availability is confirmed for this account. Provider readiness may vary.
          - paragraph [ref=e85]: Updated Oct 20, 2026, 4:00 PM. Credits measure the configured AI budget. Storage is logical persistent data, not physical disk use.
          - generic [ref=e86]:
            - generic [ref=e87]:
              - heading "Export a workspace" [level=2] [ref=e88]
              - paragraph [ref=e89]: Prepare one private JSON download. There is no import or restore action.
            - generic [ref=e90]:
              - generic [ref=e91]: Workspace to export
              - combobox "Workspace to export" [ref=e92]:
                - option "Choose an active workspace"
                - option "Alpha workspace"
                - option "Beta workspace" [selected]
            - generic [ref=e93]:
              - paragraph [ref=e94]: Includes this workspace’s files, tasks, saved facts and context, project and Home conversations, workspace-bound skills, and schedule definitions. Schedule run history stays in its Home transcript.
              - paragraph [ref=e95]: Credentials and detected secrets, other workspaces, account-wide skills, provider credentials, recovery data, and security or audit records are excluded. The canonical public showcase has no export action.
              - paragraph [ref=e96]: Credits continue to show the configured AI budget. Storage reports logical persistent workspace data, not physical disk use; temporary exports have separate size and expiry limits and do not count toward that total.
              - paragraph [ref=e97]:
                - text: "Workspace data is stored on the operator-controlled deployment. Selected AI context is sent to the configured inference provider:"
                - strong [ref=e98]: Preview inference provider
                - text: . Export expiry removes this temporary application artifact only. Deployment backups and provider-side copies follow their own retention policies; editing or deleting workspace data does not promise erasure of copies already held by a provider or backup.
            - region "Export ready" [ref=e99]:
              - heading "Export ready" [level=3] [ref=e100]
              - paragraph [ref=e101]: Beta workspace · 512 B
              - paragraph [ref=e102]: Available until Oct 20, 2026, 4:15 PM.
              - button "Download JSON" [ref=e103] [cursor=pointer]
              - paragraph [ref=e104]: Clicking download does not guarantee that your browser saved the file.
            - button "Prepare export" [ref=e106] [cursor=pointer]
    - button "Open Home assistant" [ref=e107] [cursor=pointer]:
      - generic [ref=e110]: Ask
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   |
  3   | const ALPHA_ID = '873c096a-bc57-4a0c-85da-10d4febde961';
  4   | const BETA_ID = '873c096a-bc57-4a0c-85da-10d4febde962';
  5   | const EXPORT_ALPHA = '6c640000-0000-4000-8000-000000000001';
  6   | const EXPORT_BETA = '6c640000-0000-4000-8000-000000000002';
  7   | const PREVIEW_CSRF = 'workspace-export-preview-csrf';
  8   | const PREVIEW_TIME = '2026-10-20T08:00:00.000Z';
  9   |
  10  | interface CreateRequestRecord {
  11  |   readonly workspaceId: string;
  12  |   readonly idempotencyKey: string | undefined;
  13  |   readonly body: unknown;
  14  | }
  15  |
  16  | test('keeps an uncertain retry on its workspace and ignores its late response after switching', async ({ page }, testInfo) => {
  17  |   const creates: CreateRequestRecord[] = [];
  18  |   let alphaCreateCount = 0;
  19  |   let alphaSecondRequestPending = false;
  20  |   let releaseAlphaResponse: (() => void) | undefined;
  21  |
  22  |   await installUsageApi(page, async (route) => {
  23  |     const request = route.request();
  24  |     const body = request.postDataJSON() as { readonly workspaceId: string };
  25  |     creates.push({ workspaceId: body.workspaceId, idempotencyKey: request.headers()['idempotency-key'], body });
  26  |     if (body.workspaceId === ALPHA_ID) {
  27  |       alphaCreateCount += 1;
  28  |       if (alphaCreateCount === 1) {
  29  |         await route.abort();
  30  |         return;
  31  |       }
  32  |       alphaSecondRequestPending = true;
  33  |       await new Promise<void>((resolve) => { releaseAlphaResponse = resolve; });
  34  |       await fulfillCreated(route, EXPORT_ALPHA, ALPHA_ID);
  35  |       return;
  36  |     }
  37  |     await fulfillCreated(route, EXPORT_BETA, BETA_ID);
  38  |   }, async (route) => {
  39  |     await route.fulfill({
  40  |       status: 200,
  41  |       contentType: 'application/json',
  42  |       headers: {
  43  |         'Cache-Control': 'no-store',
  44  |         'Content-Disposition': `attachment; filename="workspace-export-${EXPORT_BETA}.json"`,
  45  |         'X-Content-Type-Options': 'nosniff'
  46  |       },
  47  |       body: JSON.stringify({ manifest: { format: 'personal-ai-workspace-export', version: 1 }, workspace: { id: BETA_ID } })
  48  |     });
  49  |   });
  50  |
  51  |   await page.goto('/usage');
  52  |   await expect(page.getByTestId('workspace-export')).toBeVisible();
  53  |   const workspaceSelect = page.getByTestId('workspace-export-project-select');
  54  |   await workspaceSelect.selectOption(ALPHA_ID);
  55  |
  56  |   await page.getByRole('button', { name: 'Prepare export' }).click();
  57  |   await expect(page.getByTestId('workspace-export-create-error')).toContainText('Retry to check or prepare the same request');
  58  |   await page.getByRole('button', { name: 'Prepare export' }).click();
  59  |   await expect.poll(() => alphaSecondRequestPending).toBe(true);
  60  |   const lateAlphaResponse = page.waitForResponse((response) =>
  61  |     response.url().includes('/api/v1/workspace-exports') && response.request().method() === 'POST' && response.status() === 201
  62  |   );
  63  |
  64  |   await workspaceSelect.selectOption(BETA_ID);
  65  |   await page.getByRole('button', { name: 'Prepare export' }).click();
  66  |   await expect(page.getByTestId('workspace-export-ready')).toContainText('Beta workspace');
  67  |   expect(creates).toHaveLength(3);
  68  |   expect(creates[0]).toEqual(creates[1]);
  69  |   expect(creates[2]?.workspaceId).toBe(BETA_ID);
  70  |   expect(creates[2]?.body).toEqual({ workspaceId: BETA_ID });
  71  |   expect(creates[2]?.idempotencyKey).not.toBe(creates[1]?.idempotencyKey);
  72  |
  73  |   releaseAlphaResponse?.();
  74  |   await lateAlphaResponse;
  75  |   await expect(page.getByTestId('workspace-export-ready')).toContainText('Beta workspace');
  76  |   await expect(page.getByTestId('workspace-export-ready')).not.toContainText('Alpha workspace');
  77  |   await page.screenshot({ path: testInfo.outputPath('workspace-export-usage-ready.png'), fullPage: true });
  78  |
  79  |   const download = page.waitForEvent('download');
  80  |   await page.getByRole('button', { name: 'Download JSON' }).click();
> 81  |   await expect(download).resolves.toMatchObject({ suggestedFilename: `workspace-export-${EXPORT_BETA}.json` });
      |                                   ^ Error: expect(received).resolves.toMatchObject(expected)
  82  |   await expect(page.getByTestId('usage-daily-credits')).toContainText('No AI usage yet.');
  83  |   await expect(page.getByTestId('usage-workspace-storage')).toContainText('17 bytes');
  84  | });
  85  |
  86  | test('shows bounded, capacity, and unavailable errors without leaving a stale download', async ({ page }) => {
  87  |   let alphaCreateCount = 0;
  88  |   await installUsageApi(page, async (route) => {
  89  |     const request = route.request();
  90  |     const body = request.postDataJSON() as { readonly workspaceId: string };
  91  |     if (body.workspaceId === ALPHA_ID) {
  92  |       alphaCreateCount += 1;
  93  |       if (alphaCreateCount === 1) {
  94  |         await route.fulfill({ status: 413, contentType: 'application/json', body: errorEnvelope('EXPORT_TOO_LARGE', 'The export exceeds its safe limits.') });
  95  |         return;
  96  |       }
  97  |       await fulfillCreated(route, EXPORT_ALPHA, ALPHA_ID);
  98  |       return;
  99  |     }
  100 |     await route.fulfill({ status: 429, contentType: 'application/json', body: errorEnvelope('EXPORT_LIMIT_REACHED', 'Too many exports are active.') });
  101 |   }, async (route) => {
  102 |     await route.fulfill({
  103 |       status: 404,
  104 |       contentType: 'application/json',
  105 |       body: errorEnvelope('WORKSPACE_EXPORT_UNAVAILABLE', 'The workspace export is unavailable.')
  106 |     });
  107 |   });
  108 |
  109 |   await page.goto('/usage');
  110 |   await expect(page.getByTestId('workspace-export')).toBeVisible();
  111 |   const workspaceSelect = page.getByTestId('workspace-export-project-select');
  112 |   await workspaceSelect.selectOption(ALPHA_ID);
  113 |   await page.getByRole('button', { name: 'Prepare export' }).click();
  114 |   await expect(page.getByTestId('workspace-export-create-error')).toContainText('exceeds the supported export size');
  115 |   await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);
  116 |
  117 |   await workspaceSelect.selectOption(BETA_ID);
  118 |   await page.getByRole('button', { name: 'Prepare export' }).click();
  119 |   await expect(page.getByTestId('workspace-export-create-error')).toContainText('At most two exports can be active');
  120 |   await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);
  121 |
  122 |   await workspaceSelect.selectOption(ALPHA_ID);
  123 |   await page.getByRole('button', { name: 'Prepare export' }).click();
  124 |   await expect(page.getByTestId('workspace-export-ready')).toContainText('Alpha workspace');
  125 |   await page.getByRole('button', { name: 'Download JSON' }).click();
  126 |   await expect(page.getByTestId('workspace-export-download-error')).toContainText('This export is unavailable. Prepare a new export.');
  127 |   await expect(page.getByTestId('workspace-export-ready')).toHaveCount(0);
  128 |   await expect(page.getByTestId('usage-lifetime-credits')).toContainText('No AI usage yet.');
  129 |   await expect(page.getByTestId('usage-workspace-storage')).toContainText('17 bytes');
  130 | });
  131 |
  132 | async function installUsageApi(
  133 |   page: import('@playwright/test').Page,
  134 |   create: (route: import('@playwright/test').Route) => Promise<void>,
  135 |   download: (route: import('@playwright/test').Route) => Promise<void>
  136 | ): Promise<void> {
  137 |   await page.route('**/api/v1/**', async (route) => {
  138 |     const request = route.request();
  139 |     const url = new URL(request.url());
  140 |     if (url.pathname === '/api/v1/auth/session') {
  141 |       await respond(route, 200, {
  142 |         principal: { id: 'preview-owner', displayName: 'Preview owner', accountKind: 'regular', role: 'user' },
  143 |         csrfToken: PREVIEW_CSRF, expiresAt: '2026-10-20T09:00:00.000Z'
  144 |       });
  145 |       return;
  146 |     }
  147 |     if (url.pathname === '/api/v1/projects') {
  148 |       await respond(route, 200, { projects: [project(ALPHA_ID, 'Alpha workspace'), project(BETA_ID, 'Beta workspace')] });
  149 |       return;
  150 |     }
  151 |     if (url.pathname === '/api/v1/account/usage') {
  152 |       await respond(route, 200, {
  153 |         asOf: PREVIEW_TIME, expiresAt: null,
  154 |         daily: { limitUnits: '100', settledUnits: '0', reservedUnits: '0', remainingUnits: '100', resetAt: PREVIEW_TIME, timeZone: 'UTC' },
  155 |         lifetime: { limitUnits: '1000', settledUnits: '0', reservedUnits: '0', remainingUnits: '1000' },
  156 |         storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '17', reservedBytes: '0', limitBytes: '1000', availableBytes: '983', overLimit: false, asOf: PREVIEW_TIME },
  157 |         availability: { status: 'available', reason: null, canSubmit: true }
  158 |       });
  159 |       return;
  160 |     }
  161 |     if (url.pathname === '/api/v1/assistant/execution-policy') {
  162 |       await respond(route, 200, {
  163 |         scope: { kind: url.searchParams.get('scope') ?? 'home', label: 'Preview workspace' },
  164 |         policy: { enabled: true, revision: 'preview-policy', provider: { name: 'Preview inference provider', model: 'preview-only' }, included: { categories: [], items: [] }, exclusionsEnforced: true, capabilities: [] },
  165 |         fileAccess: false, readiness: { state: 'ready' }
  166 |       });
  167 |       return;
  168 |     }
  169 |     if (url.pathname === '/api/v1/workspace-exports' && request.method() === 'POST') {
  170 |       await create(route);
  171 |       return;
  172 |     }
  173 |     if (url.pathname.startsWith('/api/v1/workspace-exports/') && request.method() === 'GET') {
  174 |       await download(route);
  175 |       return;
  176 |     }
  177 |     await respond(route, 404, null, { code: 'NOT_FOUND', message: 'No preview API route is configured.' });
  178 |   });
  179 | }
  180 |
  181 | function project(id: string, name: string) {
```