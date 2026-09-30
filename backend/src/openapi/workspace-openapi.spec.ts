import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected OpenAPI object.');
  }
  return value as JsonRecord;
}

describe('workspace OpenAPI document', () => {
  it('documents the authenticated bounded inspection endpoints and schemas', () => {
    const document = record(openApiDocument);
    const paths = record(document.paths);
    const expectedPaths = [
      '/api/v1/projects/{projectId}/files',
      '/api/v1/projects/{projectId}/files/tree',
      '/api/v1/projects/{projectId}/files/content',
      '/api/v1/projects/{projectId}/files/search'
    ];
    for (const path of expectedPaths) {
      const operation = record(record(paths[path]).get);
      expect(operation.security).toEqual([{ sessionCookie: [] }]);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      expect(parameters.length).toBeGreaterThan(0);
      expect(record(operation.responses)['200']).toBeDefined();
      expect(record(operation.responses)['400']).toBeDefined();
      expect(record(operation.responses)['401']).toBeDefined();
    }
    const schemas = record(record(document.components).schemas);
    ['WorkspaceEntry', 'WorkspaceList', 'WorkspaceTree', 'WorkspaceRead', 'WorkspaceSearch', 'WorkspaceListEnvelope', 'WorkspaceTreeEnvelope', 'WorkspaceReadEnvelope', 'WorkspaceSearchEnvelope'].forEach((schema) => expect(schemas[schema]).toBeDefined());
    const search = record(record(paths['/api/v1/projects/{projectId}/files/search']).get);
    expect(search.description).toMatch(/case-insensitive phrases or query terms/iu);
    expect(search.description).toMatch(/rank first/iu);
    expect(record(schemas.WorkspaceSearch).description).toMatch(/20,000 lines/iu);
  });
});
