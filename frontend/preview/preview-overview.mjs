import { sendData, sendError } from './preview-ai-run-support.mjs';

export function previewOverview(response, seed, url) {
  const raw = url.searchParams.getAll('taskLimit');
  const limit = Number(raw[0] ?? 6);
  if (raw.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) { sendError(response, 400, 'VALIDATION_ERROR', 'Choose a limit of 1 to 100.'); return; }
  const projects = seed.projects.filter((project) => project.status === 'active').map((project) => {
    const { relativeRoot, ...publicProject } = project;
    const fileAccess = relativeRoot !== null;
    return {
      ...publicProject,
      objective: project.objective ?? null,
      workspaceMode: fileAccess ? 'file_backed' : 'planning',
      capabilities: { planning: true, fileAccess },
      lastActivityAt: [project.updatedAt, ...seed.conversations.filter((item) => item.projectId === project.id).map((item) => item.lastActivityAt),
        ...seed.tasks.filter((item) => item.projectId === project.id).map((item) => item.updatedAt)].sort().at(-1)
    };
  }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
  const ranks = { low: 0, medium: 1, high: 2, urgent: 3 };
  const tasks = seed.tasks.filter((task) => projects.some((project) => project.id === task.projectId) && ['todo', 'in_progress', 'blocked'].includes(task.status))
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || ranks[b.importance] - ranks[a.importance] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit).map(({ id, projectId, title, status, importance, deadline, version }) => ({ id, projectId, projectName: projects.find((project) => project.id === projectId).name, title, status, importance, deadline, version }));
  sendData(response, { projects, tasks });
}

export function removePreviewProject(request, response, seed, idempotency, project, aiRuns) {
  const header = request.headers['if-match'];
  if (!/^[1-9]\d*$/u.test(header ?? '')) { sendError(response, 400, 'PROJECT_VERSION_REQUIRED', 'Current project version required.'); return; }
  if (Number(header) !== project.version) { sendError(response, 409, 'PROJECT_VERSION_CONFLICT', 'Refresh project before removing.'); return; }
  if (aiRuns.isBusy(project.id)) { sendError(response, 409, 'PROJECT_REMOVAL_BUSY', 'Resolve active operations first.'); return; }
  const conversations = new Set(seed.conversations.filter((item) => item.projectId === project.id).map((item) => item.id));
  seed.projects = seed.projects.filter((item) => item.id !== project.id);
  seed.conversations = seed.conversations.filter((item) => item.projectId !== project.id);
  seed.messages = seed.messages.filter((item) => !conversations.has(item.conversationId));
  seed.tasks = seed.tasks.filter((item) => item.projectId !== project.id);
  seed.taskSuggestions = seed.taskSuggestions.filter((item) => item.projectId !== project.id);
  delete seed.taskOrders[project.id]; delete seed.contexts[project.id];
  for (const [key, record] of idempotency) if (key.includes(project.id) || conversations.has(record.conversationId)) idempotency.delete(key);
  aiRuns.removeProject(project.id);
  // seed.files is keyed by project root; folder contents survive removal and reattachment.
  response.writeHead(204); response.end();
}
