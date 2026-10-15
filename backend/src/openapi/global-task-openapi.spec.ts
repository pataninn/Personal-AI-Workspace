import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

describe('global task query OpenAPI contract', () => {
  it('documents owner-scoped list/detail routes, filters, envelopes, and errors', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const listOperation = record(record(paths['/api/v1/tasks'], 'global tasks path').get, 'global task list');
    const inboxCountOperation = record(record(paths['/api/v1/tasks/inbox/count'], 'Inbox count path').get, 'Inbox count');
    const detailPath = record(paths['/api/v1/tasks/{taskId}'], 'global task detail path');
    const detailOperation = record(detailPath.get, 'global task detail');
    const listResponses = record(listOperation.responses, 'list responses');

    expect(listOperation.operationId).toBe('listGlobalTasks');
    expect(detailOperation.operationId).toBe('getGlobalTask');
    expect(inboxCountOperation.operationId).toBe('getInboxTaskCount');
    expect(inboxCountOperation.security).toEqual([{ sessionCookie: [] }]);
    expect(record(inboxCountOperation.responses, 'Inbox count responses')['200']).toBeDefined();
    expect(listOperation.security).toEqual([{ sessionCookie: [] }]);
    expect(detailOperation.security).toEqual([{ sessionCookie: [] }]);
    expect(listOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'workspaceId', in: 'query' }),
      expect.objectContaining({ name: 'inboxOnly', in: 'query' }),
      expect.objectContaining({ name: 'status', in: 'query' }),
      expect.objectContaining({ name: 'importance', in: 'query' }),
      expect.objectContaining({ name: 'deadlineFrom', in: 'query' }),
      expect.objectContaining({ name: 'deadlineTo', in: 'query' }),
      expect.objectContaining({ name: 'q', in: 'query' }),
      expect.objectContaining({ name: 'includeArchived', in: 'query' }),
      expect.objectContaining({ name: 'limit', in: 'query' }),
      expect.objectContaining({ name: 'cursor', in: 'query' })
    ]));
    expect(listResponses['200']).toBeDefined();
    expect(listResponses['400']).toBeDefined();
    expect(listResponses['401']).toBeDefined();
    expect(listResponses['500']).toBeDefined();
    expect(record(detailOperation.responses, 'detail responses')['404']).toBeDefined();
    expect(detailPath.parameters).toEqual([expect.objectContaining({ name: 'taskId', in: 'path', required: true })]);

    const schemas = record(record(document.components, 'components').schemas, 'schemas');
    ['GlobalTaskWorkspace', 'GlobalTaskQueryItem', 'GlobalTaskQueryPage', 'GlobalTaskQueryPageEnvelope', 'GlobalTaskQueryItemEnvelope', 'InboxTaskCount', 'InboxTaskCountEnvelope'].forEach((name) => {
      expect(schemas[name]).toBeDefined();
    });
    expect(list(record(schemas.GlobalTaskQueryItem, 'global task item').required, 'item required fields')).toEqual(expect.arrayContaining(['task', 'collection', 'workspace']));
    expect(list(record(schemas.GlobalTaskQueryPage, 'global task page').required, 'page required fields')).toEqual(expect.arrayContaining(['items', 'nextCursor']));
  });
});
