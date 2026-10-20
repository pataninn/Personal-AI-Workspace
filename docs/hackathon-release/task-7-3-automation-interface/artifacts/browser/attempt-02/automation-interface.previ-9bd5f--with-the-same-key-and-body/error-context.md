# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: automation-interface.preview.spec.ts >> shows budget exhaustion and retries an uncertain Run now with the same key and body
- Location: e2e\automation-interface.preview.spec.ts:319:1

# Error details

```
Error: expect(received).toMatch(expected)

Matcher error: expected value must be a string or regular expression

Expected has type:  array
Expected has value: [/status of a 422 \(Unprocessable Entity\).*automations\/schedules/u]
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary "Primary navigation" [ref=e4]:
    - link [ref=e5] [cursor=pointer]:
      - /url: /dashboard
      - text: P
      - generic [ref=e6]: Personal AIWorkspace
    - navigation "Primary navigation" [ref=e7]:
      - link "Home" [ref=e8] [cursor=pointer]:
        - /url: /dashboard
      - region [ref=e12]:
        - heading "Projects" [level=2] [ref=e13]
        - link "+ New project" [ref=e14] [cursor=pointer]:
          - /url: /dashboard?create=1
        - navigation "Active projects" [ref=e15]:
          - link "Preview workspace" [ref=e16] [cursor=pointer]:
            - /url: /projects/873c096a-bc57-4a0c-85da-10d4febde961
      - link "Automations" [ref=e21] [cursor=pointer]:
        - /url: /automations
      - link "Usage" [ref=e23] [cursor=pointer]:
        - /url: /usage
  - generic [ref=e25]:
    - banner [ref=e26]:
      - navigation "Current page" [ref=e27]:
        - strong [ref=e28]: Home
      - text: P
      - button "Account menu for Preview owner" [ref=e31] [cursor=pointer]:
        - generic [ref=e34]: Account
    - main [ref=e35]:
      - generic [ref=e36]:
        - generic [ref=e37]:
          - paragraph [ref=e38]: Workspace tools
          - heading "Automations" [level=1] [ref=e39]
          - paragraph [ref=e40]: Set a daily briefing for one workspace and one saved read-only skill.
        - generic [ref=e41]:
          - paragraph [ref=e42]: Schedules run on the server and keep their results in the workspace Home conversation.
          - button "Create daily briefing" [ref=e43] [cursor=pointer]
        - generic [ref=e44]:
          - generic [ref=e45]:
            - generic [ref=e46]:
              - heading "Daily briefing" [level=2] [ref=e47]
              - paragraph [ref=e48]: Preview workspace · Morning briefing · v4
              - paragraph [ref=e49]: Enabled · 08:30 (Asia/Shanghai)
            - generic [ref=e50]:
              - paragraph [ref=e51]: "Next run: Oct 21, 2026, 8:30 AM (Asia/Shanghai)"
              - paragraph [ref=e52]: "Last outcome: No runs yet"
          - status [ref=e53]: Run queued. Check history for its current status.
          - generic [ref=e54]:
            - button "Run now" [disabled] [ref=e55]
            - button "Hide history" [expanded] [ref=e56] [cursor=pointer]
            - button "Edit" [ref=e57] [cursor=pointer]
            - button "Pause" [ref=e58] [cursor=pointer]
          - generic [ref=e59]:
            - paragraph [ref=e60]: History is retained when a schedule is paused.
            - region [ref=e61]:
              - heading "Run history · Preview workspace" [level=3] [ref=e63]
              - generic [ref=e64]:
                - generic [ref=e65]:
                  - generic [ref=e66]:
                    - paragraph [ref=e67]: Run now · Oct 21, 2026, 8:00 AM (Asia/Shanghai)
                    - paragraph [ref=e68]: Skill version 4
                  - paragraph [ref=e69]: Queued
                - link "Open conversation" [ref=e70] [cursor=pointer]:
                  - /url: /projects/873c096a-bc57-4a0c-85da-10d4febde961/planning-chat?conversation=773c0000-0000-4000-8000-000000000002
                - list [ref=e71]:
                  - listitem [ref=e72]: "Provider: preview-profile · preview-model; usage: 1200 input / 180 output tokens; charged units: 4"
                - generic [ref=e73]:
                  - heading "Source tasks" [level=4] [ref=e74]
                  - list [ref=e75]:
                    - listitem [ref=e76]:
                      - link "Prepare release note · revision 7" [ref=e77] [cursor=pointer]:
                        - /url: /tasks/773c0000-0000-4000-8000-000000000004
  - button "Open Home assistant" [ref=e78] [cursor=pointer]:
    - generic [ref=e81]: Ask
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   |
  3   | const WORKSPACE_ID = '873c096a-bc57-4a0c-85da-10d4febde961';
  4   | const SKILL_ID = '873c096a-bc57-4a0c-85da-10d4febde962';
  5   | const SCHEDULE_ID = '773c0000-0000-4000-8000-000000000001';
  6   | const CONVERSATION_ID = '773c0000-0000-4000-8000-000000000002';
  7   | const TURN_ID = '773c0000-0000-4000-8000-000000000003';
  8   | const TASK_ID = '773c0000-0000-4000-8000-000000000004';
  9   | const PREVIEW_CSRF = 'automation-interface-preview-csrf';
  10  | const NOW = '2026-10-21T00:00:00.000Z';
  11  |
  12  | interface Schedule {
  13  |   readonly id: string;
  14  |   readonly workspaceId: string;
  15  |   readonly conversationId: string;
  16  |   readonly skillId: string;
  17  |   readonly skillVersion: number;
  18  |   readonly localTime: string;
  19  |   readonly timeZone: string;
  20  |   readonly enabled: boolean;
  21  |   readonly revision: number;
  22  |   readonly nextDueAt: string | null;
  23  |   readonly lastRunStatus: string | null;
  24  |   readonly createdAt: string;
  25  |   readonly updatedAt: string;
  26  | }
  27  |
  28  | interface Occurrence {
  29  |   readonly id: string;
  30  |   readonly kind: 'scheduled' | 'manual';
  31  |   readonly intendedFor: string;
  32  |   readonly status: string;
  33  |   readonly scheduleRevision: number;
  34  |   readonly skillVersion: number;
  35  |   readonly homeTurnId: string | null;
  36  |   readonly failureCode: string | null;
  37  |   readonly attemptCount: number;
  38  |   readonly taskSources: readonly { taskId: string; revision: number; available: boolean; title: string | null; href: string | null }[];
  39  |   readonly providerUsage: {
  40  |     readonly state: 'not_started' | 'settled' | 'pending' | 'unknown';
  41  |     readonly calls: readonly { status: 'pending' | 'unknown' | 'settled' | 'over_bound'; providerProfile: string; model: string; inputTokens: number | null; outputTokens: number | null; chargedUnits: string | null }[];
  42  |   };
  43  |   readonly createdAt: string;
  44  |   readonly updatedAt: string;
  45  | }
  46  |
  47  | interface PreviewState {
  48  |   schedules: Schedule[];
  49  |   occurrences: Occurrence[];
  50  |   createRequests: { body: unknown; key: string | undefined }[];
  51  |   updateRequests: { body: unknown; key: string | undefined }[];
  52  |   runRequests: { body: unknown; key: string | undefined }[];
  53  |   runModes: ('budget' | 'network' | 'queued' | 'succeeded')[];
  54  |   conflictNextUpdate: boolean;
  55  | }
  56  |
  57  | function schedule(overrides: Partial<Schedule> = {}): Schedule {
  58  |   return {
  59  |     id: SCHEDULE_ID, workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID, skillVersion: 4,
  60  |     localTime: '08:30', timeZone: 'Asia/Shanghai', enabled: true, revision: 3,
  61  |     nextDueAt: '2026-10-21T00:30:00.000Z', lastRunStatus: null, createdAt: NOW, updatedAt: NOW, ...overrides
  62  |   };
  63  | }
  64  |
  65  | function occurrence(status: 'queued' | 'succeeded' = 'queued'): Occurrence {
  66  |   return {
  67  |     id: '773c0000-0000-4000-8000-000000000005', kind: 'manual', intendedFor: NOW, status,
  68  |     scheduleRevision: 3, skillVersion: 4, homeTurnId: TURN_ID, failureCode: null, attemptCount: 1,
  69  |     taskSources: [{ taskId: TASK_ID, revision: 7, available: true, title: 'Prepare release note', href: `/tasks/${TASK_ID}` }],
  70  |     providerUsage: { state: 'settled', calls: [{ status: 'settled', providerProfile: 'preview-profile', model: 'preview-model', inputTokens: 1200, outputTokens: 180, chargedUnits: '4' }] },
  71  |     createdAt: NOW, updatedAt: NOW
  72  |   };
  73  | }
  74  |
  75  | interface BrowserErrors {
  76  |   readonly uncaught: string[];
  77  |   readonly resource: string[];
  78  | }
  79  |
  80  | function watchBrowserErrors(page: import('@playwright/test').Page): BrowserErrors {
  81  |   const errors: BrowserErrors = { uncaught: [], resource: [] };
  82  |   page.on('pageerror', (error) => errors.uncaught.push(error.message));
  83  |   page.on('console', (message) => {
  84  |     if (message.type() !== 'error') return;
  85  |     const entry = `${message.text()} ${message.location().url}`.trim();
  86  |     if (message.text().startsWith('Failed to load resource:') || message.text().includes('net::ERR_FAILED')) errors.resource.push(entry);
  87  |     else errors.uncaught.push(entry);
  88  |   });
  89  |   return errors;
  90  | }
  91  |
  92  | function expectBrowserErrors(errors: BrowserErrors, expectedResourceErrors: readonly RegExp[] = []): void {
  93  |   expect(errors.uncaught).toEqual([]);
  94  |   expect(errors.resource).toHaveLength(expectedResourceErrors.length);
> 95  |   expectedResourceErrors.forEach((expected, index) => expect(errors.resource[index]).toMatch(expected));
      |                                                                                      ^ Error: expect(received).toMatch(expected)
  96  | }
  97  |
  98  | async function installApi(
  99  |   page: import('@playwright/test').Page,
  100 |   options: { readonly schedules?: readonly Schedule[]; readonly occurrences?: readonly Occurrence[]; readonly runModes?: PreviewState['runModes'] } = {}
  101 | ): Promise<PreviewState> {
  102 |   const state: PreviewState = {
  103 |     schedules: [...(options.schedules ?? [])], occurrences: [...(options.occurrences ?? [])],
  104 |     createRequests: [], updateRequests: [], runRequests: [], runModes: [...(options.runModes ?? [])], conflictNextUpdate: false
  105 |   };
  106 |   await page.route('**/api/v1/**', async (route) => {
  107 |     const request = route.request();
  108 |     const url = new URL(request.url());
  109 |     const path = url.pathname;
  110 |     if (path === '/api/v1/auth/session') {
  111 |       await respond(route, 200, { principal: { id: 'preview-owner', displayName: 'Preview owner', accountKind: 'regular', role: 'user' }, csrfToken: PREVIEW_CSRF, expiresAt: '2026-10-21T02:00:00.000Z' });
  112 |       return;
  113 |     }
  114 |     if (path === '/api/v1/projects' && request.method() === 'GET') {
  115 |       await respond(route, 200, { projects: [project()] });
  116 |       return;
  117 |     }
  118 |     if (path === `/api/v1/projects/${WORKSPACE_ID}` && request.method() === 'GET') {
  119 |       await respond(route, 200, project());
  120 |       return;
  121 |     }
  122 |     if (path === '/api/v1/skills' && request.method() === 'GET') {
  123 |       await respond(route, 200, { skills: [skill()] });
  124 |       return;
  125 |     }
  126 |     if (path === '/api/v1/automations/schedules' && request.method() === 'GET') {
  127 |       await respond(route, 200, { schedules: state.schedules });
  128 |       return;
  129 |     }
  130 |     if (path === '/api/v1/automations/schedules' && request.method() === 'POST') {
  131 |       const body = request.postDataJSON() as { workspaceId: string; skillId: string; skillVersion: number; localTime: string; timeZone: string };
  132 |       state.createRequests.push({ body, key: request.headers()['idempotency-key'] });
  133 |       const created = schedule({ ...body, id: SCHEDULE_ID, conversationId: CONVERSATION_ID, enabled: true, revision: 1, nextDueAt: '2026-10-21T00:30:00.000Z', lastRunStatus: null });
  134 |       state.schedules = [created];
  135 |       await respond(route, 201, { schedule: created });
  136 |       return;
  137 |     }
  138 |     const schedulePath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)$/u);
  139 |     if (schedulePath && request.method() === 'PATCH') {
  140 |       const body = request.postDataJSON() as { expectedRevision: number; enabled?: boolean; localTime?: string; timeZone?: string; skillId?: string; skillVersion?: number };
  141 |       state.updateRequests.push({ body, key: request.headers()['idempotency-key'] });
  142 |       if (state.conflictNextUpdate) {
  143 |         state.conflictNextUpdate = false;
  144 |         state.schedules = state.schedules.map((item) => item.id === SCHEDULE_ID ? { ...item, localTime: '09:00', revision: item.revision + 1, nextDueAt: '2026-10-21T01:00:00.000Z', updatedAt: NOW } : item);
  145 |         await respond(route, 409, null, { code: 'SCHEDULE_REVISION_CONFLICT', message: 'This schedule changed.' });
  146 |         return;
  147 |       }
  148 |       const updated = state.schedules.map((item) => item.id === SCHEDULE_ID ? {
  149 |         ...item, ...body, revision: item.revision + 1,
  150 |         nextDueAt: body.enabled === false ? null : body.enabled === true ? '2026-10-21T00:30:00.000Z' : item.nextDueAt,
  151 |         updatedAt: NOW
  152 |       } : item);
  153 |       state.schedules = updated;
  154 |       await respond(route, 200, { schedule: updated[0] });
  155 |       return;
  156 |     }
  157 |     const runPath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)\/runs$/u);
  158 |     if (runPath && request.method() === 'POST') {
  159 |       state.runRequests.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
  160 |       const mode = state.runModes.shift() ?? 'queued';
  161 |       if (mode === 'budget') {
  162 |         await respond(route, 422, null, { code: 'BUDGET_EXHAUSTED', message: 'The AI budget is exhausted.' });
  163 |         return;
  164 |       }
  165 |       if (mode === 'network') {
  166 |         await route.abort();
  167 |         return;
  168 |       }
  169 |       const result = occurrence(mode === 'succeeded' ? 'succeeded' : 'queued');
  170 |       state.occurrences = [result, ...state.occurrences.filter((item) => item.id !== result.id)];
  171 |       await respond(route, 202, { occurrence: result });
  172 |       return;
  173 |     }
  174 |     const historyPath = path.match(/^\/api\/v1\/automations\/schedules\/([^/]+)\/occurrences$/u);
  175 |     if (historyPath && request.method() === 'GET') {
  176 |       await respond(route, 200, { occurrences: state.occurrences, nextCursor: null });
  177 |       return;
  178 |     }
  179 |     if (path === '/api/v1/assistant/execution-policy') {
  180 |       await respond(route, 200, { scope: { kind: url.searchParams.get('scope') ?? 'home', label: 'Preview workspace' }, policy: { enabled: true, revision: 'preview-policy', provider: { name: 'Preview provider', model: 'preview-model' }, included: { categories: [], items: [] }, exclusionsEnforced: true, capabilities: [] }, fileAccess: false, readiness: { state: 'ready' } });
  181 |       return;
  182 |     }
  183 |     if (path === '/api/v1/account/usage' && request.method() === 'GET') {
  184 |       await respond(route, 200, {
  185 |         asOf: NOW, expiresAt: null,
  186 |         daily: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null, resetAt: NOW, timeZone: 'Asia/Shanghai' },
  187 |         lifetime: { limitUnits: null, settledUnits: '0', reservedUnits: '0', remainingUnits: null },
  188 |         storage: { state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '0', reservedBytes: '0', limitBytes: null, availableBytes: null, overLimit: false, asOf: NOW },
  189 |         availability: { status: 'available', reason: null, canSubmit: true }
  190 |       });
  191 |       return;
  192 |     }
  193 |     if (path === '/api/v1/home/conversations' && request.method() === 'GET') {
  194 |       await respond(route, 200, { conversations: [homeConversation()], nextCursor: null });
  195 |       return;
```
