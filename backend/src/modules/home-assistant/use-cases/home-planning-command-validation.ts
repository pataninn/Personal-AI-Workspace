import { z } from 'zod';

import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalInputInvalidError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeProposalDeadlineResolution } from '@/modules/home-assistant/domain/home-change-proposal-types';
import type { HomePlanningToolRequest } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';

const UUID = z.string().uuid();
const VERSION = z.number().int().positive().max(2147483647);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const IMPORTANCE = z.enum(['low', 'medium', 'high', 'urgent']);
const STATUS = z.enum(['todo', 'in_progress', 'blocked', 'done']);
const SUBTASK_CREATE = z.object({ title: z.string().min(1).max(120), completed: z.boolean().optional() }).strict();
const SUBTASK_PATCH = z.object({ id: UUID.optional(), title: z.string().min(1).max(120), completed: z.boolean().optional() }).strict();
const DEADLINE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), value: DATE }).strict(),
  z.object({ kind: z.literal('days_from_today'), days: z.number().int().min(0).max(365) }).strict()
]);
const WORKSPACE_REF = z.object({ workspaceRef: z.number().int().min(1).max(20) }).strict();
const WORKSPACE_TARGET = z.union([UUID, z.null(), WORKSPACE_REF]);

const listTasks = z.object({
  workspaceId: UUID.optional(), inboxOnly: z.boolean().optional(), status: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
  importance: IMPORTANCE.optional(), deadlineFrom: DATE.optional(), deadlineTo: DATE.optional(), q: z.string().trim().max(200).optional(),
  includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(20).optional(), cursor: z.string().max(1024).optional()
}).strict().superRefine((value, context) => {
  if (value.workspaceId && value.inboxOnly) context.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceId'], message: 'Choose either Inbox or one workspace.' });
  if (value.deadlineFrom && value.deadlineTo && value.deadlineFrom > value.deadlineTo) context.addIssue({ code: z.ZodIssueCode.custom, path: ['deadlineFrom'], message: 'The start date must not be later than the end date.' });
  if (value.deadlineFrom && !isCalendarDate(value.deadlineFrom)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['deadlineFrom'], message: 'Choose a valid calendar date.' });
  if (value.deadlineTo && !isCalendarDate(value.deadlineTo)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['deadlineTo'], message: 'Choose a valid calendar date.' });
});

const getTask = z.object({ taskId: UUID, includeArchived: z.boolean().optional() }).strict();
const createTask = z.object({
  title: z.string().min(1).max(120), details: z.string().max(4096).nullable().optional(), workspaceId: UUID.nullable().optional(),
  importance: IMPORTANCE.optional(), deadline: DEADLINE.nullable().optional(), subtasks: z.array(SUBTASK_CREATE).max(50).optional(), expectedOrderVersion: VERSION.optional()
}).strict();
const updateTask = z.object({
  taskId: UUID, expectedVersion: VERSION, title: z.string().min(1).max(120).optional(), details: z.string().max(4096).nullable().optional(),
  status: STATUS.optional(), importance: IMPORTANCE.optional(), deadline: DEADLINE.nullable().optional(), subtasks: z.array(SUBTASK_PATCH).max(50).optional()
}).strict().superRefine((value, context) => {
  const fields = ['title', 'details', 'importance', 'deadline', 'subtasks'] as const;
  const hasPatch = fields.some((field) => value[field] !== undefined);
  if (value.status !== undefined && hasPatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Status must be the only update field.' });
  if (value.status === undefined && !hasPatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ['request'], message: 'Provide a status change or a non-empty patch.' });
});
const moveTask = z.object({ taskId: UUID, expectedVersion: VERSION, workspaceId: UUID.nullable(), expectedSourceOrderVersion: VERSION.optional(), expectedDestinationOrderVersion: VERSION.optional() }).strict();
const deleteTask = z.object({ taskId: UUID, expectedVersion: VERSION }).strict();
const searchWorkspaces = z.object({ query: z.string().trim().min(2).max(120), limit: z.number().int().min(1).max(20).optional() }).strict();
const reuseWorkspace = z.object({ workspaceId: UUID }).strict();
const createWorkspace = z.object({ name: z.string().min(1).max(120), objective: z.string().max(2000).nullable().optional() }).strict();
const updateWorkspace = z.object({ workspaceId: UUID, expectedVersion: VERSION, objective: z.string().max(2000).nullable() }).strict();
const undoAction = z.object({ actionId: UUID }).strict();

const proposalTaskCreate = z.object({
  action: z.literal('task.create'), title: z.string().min(1).max(120), details: z.string().max(4096).nullable().optional(),
  workspaceId: WORKSPACE_TARGET.optional(), importance: IMPORTANCE.optional(), deadline: DEADLINE.nullable().optional(),
  subtasks: z.array(SUBTASK_CREATE).max(50).optional(), expectedOrderVersion: VERSION.optional()
}).strict();
const proposalTaskUpdate = z.object({
  action: z.literal('task.update'), taskId: UUID, expectedVersion: VERSION, title: z.string().min(1).max(120).optional(),
  details: z.string().max(4096).nullable().optional(), status: STATUS.optional(), importance: IMPORTANCE.optional(),
  deadline: DEADLINE.nullable().optional(), subtasks: z.array(SUBTASK_PATCH).max(50).optional()
}).strict();
const proposalTaskMove = z.object({ action: z.literal('task.move'), taskId: UUID, expectedVersion: VERSION, workspaceId: WORKSPACE_TARGET }).strict();
const proposalWorkspaceCreate = z.object({ action: z.literal('workspace.create'), name: z.string().min(1).max(120), objective: z.string().max(2000).nullable().optional() }).strict();
const proposalWorkspaceUpdate = z.object({ action: z.literal('workspace.update_objective'), workspaceId: UUID, expectedVersion: VERSION, objective: z.string().max(2000).nullable() }).strict();
const proposeBulk = z.object({ items: z.array(z.discriminatedUnion('action', [proposalTaskCreate, proposalTaskUpdate, proposalTaskMove, proposalWorkspaceCreate, proposalWorkspaceUpdate])).min(2).max(20) }).strict().superRefine((value, context) => {
  for (const [index, item] of value.items.entries()) {
    if (item.action !== 'task.update') continue;
    const hasPatch = item.title !== undefined || item.details !== undefined || item.importance !== undefined || item.deadline !== undefined || item.subtasks !== undefined;
    if (item.status !== undefined && hasPatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'status'], message: 'Status must be the only update field.' });
    if (item.status === undefined && !hasPatch) context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index], message: 'Provide a status change or a non-empty patch.' });
  }
});

const schemas = {
  home_list_tasks: listTasks,
  home_get_task: getTask,
  home_create_task: createTask,
  home_update_task: updateTask,
  home_move_task: moveTask,
  home_delete_task: deleteTask,
  home_search_workspaces: searchWorkspaces,
  home_reuse_workspace: reuseWorkspace,
  home_create_workspace: createWorkspace,
  home_update_workspace_objective: updateWorkspace,
  home_undo_action: undoAction,
  home_propose_bulk_changes: proposeBulk
} as const;

export type HomePlanningToolName = keyof typeof schemas;

export function parseHomePlanningToolArgs(request: HomePlanningToolRequest): Record<string, unknown> {
  if (!(request.name in schemas)) throw new HomeConversationInputInvalidError('The Home planning tool is not registered.');
  const schema = schemas[request.name as HomePlanningToolName];
  const parsed = schema.safeParse(request.args);
  if (!parsed.success) throw new HomeConversationInputInvalidError('The Home planning tool arguments are invalid.');
  return parsed.data as Record<string, unknown>;
}

export function parseProposalToolArgs(value: unknown): z.infer<typeof proposeBulk> {
  const parsed = proposeBulk.safeParse(value);
  if (!parsed.success) throw new HomeProposalInputInvalidError();
  return parsed.data;
}

export function resolveDeadlineWithProvenance(value: unknown, timeZone: string | undefined, now = new Date()): { readonly deadline: string | null; readonly deadlineResolution: HomeProposalDeadlineResolution | null } {
  if (value === null) return { deadline: null, deadlineResolution: null };
  const parsed = DEADLINE.safeParse(value);
  if (!parsed.success) throw new HomeConversationInputInvalidError('The task deadline is invalid.');
  if (parsed.data.kind === 'date') {
    if (!isCalendarDate(parsed.data.value)) throw new HomeConversationInputInvalidError('Choose a valid calendar date.');
    return { deadline: parsed.data.value, deadlineResolution: null };
  }
  const zone = timeZone ?? 'UTC';
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  } catch {
    throw new HomeConversationInputInvalidError('The configured Home planning timezone is invalid.');
  }
  const numberPart = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const today = new Date(Date.UTC(numberPart('year'), numberPart('month') - 1, numberPart('day') + parsed.data.days));
  return {
    deadline: today.toISOString().slice(0, 10),
    deadlineResolution: { timeZone: zone, source: timeZone === undefined ? 'utc-fallback' : 'configured' }
  };
}

export function resolveDeadline(value: unknown, timeZone: string | undefined, now = new Date()): string | null {
  return resolveDeadlineWithProvenance(value, timeZone, now).deadline;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}
