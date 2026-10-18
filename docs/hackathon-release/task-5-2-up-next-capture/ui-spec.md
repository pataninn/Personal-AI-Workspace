# UI Spec: Task 5.2 — Replace Inbox emphasis with Add task and View all

## Design Inputs
- Task 5.2 moves compact task capture into Up next and makes All tasks the browsing destination while retaining existing unassigned tasks.
- Baseline: Task 1.1 UI Spec sections B (Home, Up next, capture, empty states) and A (form feedback, spacing, and responsive states). Architecture section 4.2 covers Home and task entry.
- Existing implementation: pages/dashboard/DashboardPage.tsx, widgets/home-overview/HomeOverviewWidget.tsx, features/task-capture/ui/HomeInboxCapture.tsx, and pages/all-tasks/AllTasksPage.tsx.
- Reuse the existing task-capture and global-task-query features, canonical task entities/API, and shared/ui components. Keep this task’s Home form limited to compact capture; do not import task-detail controls from the sibling project-tasks feature.

## User Goal
Add a task from Home and browse all existing tasks, including tasks with no workspace assignment.

## User Flow
1. User opens /dashboard and sees Up next followed by Workspaces; the Up next heading has Add task and View all tasks actions.
2. User selects Add task. A compact capture form expands at the top of Up next and focuses Task title.
3. User enters a required title and optionally chooses a workspace. Unassigned is the default Home destination; workspace choices do not block capture if they fail to load.
4. User submits Add task. Empty/invalid title is explained inline; while saving, prevent duplicate submission and retain entered values.
5. On success, refresh the Home task summary, announce Task added, and provide a View task link to the existing task detail route for other task fields.
6. On failure, keep the entered values and show a safe retry action; do not report success until the canonical create request succeeds.
7. User selects View all tasks to open /tasks, where existing search, filters, pagination, Inbox collection, workspace tasks, and unassigned records remain available.

## Screens / Views
### Home: Up next and compact task capture
- Layout: Up next precedes Workspaces. Put Add task as the primary action and View all tasks as a visible secondary link in the Up next header. Keep the task list compact and leave full search/filtering on /tasks.
- Capture: Add task toggles an inline compact form in the Up next card. Include only required Task title and optional Workspace, with Unassigned selected by default. Reuse current capture validation and add the workspace selector through the task-capture feature.
- Other fields: Details, status, importance, deadline, and checklist are edited from the existing task detail route after creation. The View task link opens that route. Any task-detail editing changes belong to Task 5.3; Task 5.2 does not build a second rich form or shared task-editor abstraction.
- Loading: show the existing Up next skeleton when no rows are loaded; announce refresh politely when stale rows are visible. Workspace loading/error remains independent.
- Empty: “No open tasks yet. Add a task to plan your next step.” Keep both header actions available.
- Error: show “Up next is unavailable” with Try again when no rows are available; if stale rows exist, explain that they remain visible while refresh is retried.
- Success: show current task summaries with title, location, deadline, importance, and status. After capture, show Task added and View task.
- Long list: retain the compact Home summary and keep View all tasks visible. The /tasks route is the complete collection, so removing Inbox emphasis from Home does not remove any unassigned records.
- All tasks: use the existing /tasks view and query state. Continue to show unassigned tasks as Unassigned where location is displayed; retain Inbox as a collection/filter for existing data.

## Component Inventory
| Component | New or Existing | Notes |
|---|---|---|
| Up next/Workspaces | Existing widgets/home-overview | Move header actions into Up next; keep section loading independent |
| Home capture | Existing features/task-capture | Reuse canonical create flow; add only optional workspace selection |
| Task detail | Existing pages/task-detail | View task destination for remaining fields; no new editor in this task |
| All tasks | Existing pages/all-tasks and features/global-task-query | Preserve filters, pagination, and Inbox collection |
| Button/Input/Label/Card | Existing shared/ui | Header actions and labeled capture fields |
| Alert/Skeleton | Existing shared/ui | Retry feedback and section loading |

## Responsive Behaviour
- Desktop above 1024px: keep Up next and Workspaces in the existing Home grid; actions remain aligned with the Up next heading.
- Tablet 640–1024px: preserve the current grid collapse and wrap header actions if needed.
- Mobile 360–640px: single-column sections with 16px outer spacing; wrap Add task and View all tasks beneath the heading when needed. Capture fields stack vertically, and task rows may wrap without page-wide horizontal scrolling.
- At 200% zoom, keep the title input, submit action, and View all tasks link reachable without overlapping fixed UI.

## Theming / Dark Mode
Use existing light and system dark tokens for cards, links, inputs, status, focus, and error feedback. Do not add task-specific colors.

## i18n / Localisation
No translation runtime is established. Keep user-facing copy in existing UI copy conventions and format deadlines through the existing locale-aware formatter.

## Accessibility Notes
- Use section and heading semantics for Up next and Workspaces. View all tasks is a real link; Add task is a button with aria-expanded and aria-controls for the inline form.
- Opening capture moves focus to Task title; closing returns focus to Add task. Every input has a visible label; associate validation errors with aria-describedby and role=alert.
- Announce saving and Task added through a polite status region. Keep the visible focus ring and never use color alone for deadline, importance, or error meaning.
- Keep controls at least 44px high and preserve keyboard access to both header actions, capture fields, task rows, and All tasks filters.

## Design References
- .codex/docs/hackathon-release/task-1-1-baseline-and-ui-spec/ui-spec.md sections A and B.
- .codex/docs/hackathon-release/architecture.md section 4.2.
- Personal-AI-Workspace/frontend/src/widgets/home-overview/HomeOverviewWidget.tsx and features/task-capture/ui/HomeInboxCapture.tsx.

## Open Questions / Decisions Needed
- Add task uses an inline expansion to keep capture in the Up next context; the trade-off is that the card grows while the form is open.
- Home capture includes only title and optional workspace to match Task 5.2’s compact capture scope and the existing feature boundary. Remaining task fields stay on the existing detail route, avoiding a new shared abstraction; this keeps capture fast and the implementation within current FSD ownership.
- Unassigned remains a valid location and existing tasks remain discoverable through All tasks.
