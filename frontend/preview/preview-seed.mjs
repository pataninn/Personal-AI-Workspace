import { buildTask } from './preview-tasks.mjs';
const CREATED_AT = '2026-09-12T09:00:00.000Z';

export function createPreviewSeed() {
  const projectId = '873c096a-bc57-4a0c-85da-10d4febde96b';
  const archivedProjectId = '5b16a4e5-834b-492e-996e-e49f6f49945b';
  const conversationId = '489541da-57a5-416d-afb6-45b19ad7bc98';
  const projects = [
    {
      id: projectId,
      name: 'Website redesign',
      slug: 'website-redesign',
      relativeRoot: 'apps/website',
      status: 'active',
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    },
    {
      id: archivedProjectId,
      name: 'Research notes',
      slug: 'research-notes',
      relativeRoot: 'notes/research',
      status: 'archived',
      version: 2,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    }
  ];
  const conversations = [{
    id: conversationId,
    projectId,
    title: 'Homepage ideas',
    status: 'active',
    lastActivityAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  }];
  const messages = [{
    id: '46c277b4-47f5-4d16-bf1d-11d5c10b0d7f',
    conversationId,
    role: 'user',
    sequence: 1,
    content: 'We want a clearer homepage for the new site.',
    createdAt: CREATED_AT
  }];
  const tasks = [buildTask(projectId, { title: 'Review the homepage layout', importance: 'high', deadline: '2026-10-10', details: 'Check the desktop and mobile layout.', subtasks: [{ title: 'Review desktop' }, { title: 'Review mobile' }] }, 0),
    buildTask(projectId, { title: 'Collect launch feedback', importance: 'urgent', deadline: null }, 1)];
  tasks.forEach((task) => { task.createdAt = CREATED_AT; task.updatedAt = CREATED_AT; });
  const taskSuggestions = [{ id: '51295692-4bc0-4dd7-844a-5a6cd6c3858b', projectId, runId: '8c57f5a6-a01f-4e78-89cc-617b21d79b19', conversationId,
    title: 'Prepare the launch checklist', details: 'Confirm the final homepage content.', subtasks: [{ title: 'Proofread the headline' }, { title: 'Check the primary link' }],
    status: 'pending', version: 1, taskId: null, source: { kind: 'assistant', label: 'Suggested by the assistant' }, createdAt: CREATED_AT, resolvedAt: null }];
  const files = { 'apps/website': { 'README.md': Buffer.from('# Website redesign\n\nProject notes for the homepage.\n'), 'src/index.ts': Buffer.from('export const title = "Website redesign";\n'), 'brief.pdf': Buffer.from('%PDF-1.4 preview document') } };
  return { projects, conversations, messages, tasks, taskSuggestions, taskOrders: { [projectId]: 1 }, contexts: {}, files };
}
