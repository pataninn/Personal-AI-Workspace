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
  return { projects, conversations, messages };
}
