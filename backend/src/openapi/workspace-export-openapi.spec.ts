import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected OpenAPI object.');
  return value as JsonRecord;
}

describe('workspace export OpenAPI contract', () => {
  it('documents strict owner-authenticated create and private binary download operations', () => {
    const document = record(openApiDocument);
    const paths = record(document.paths);
    const create = record(record(paths['/api/v1/workspace-exports']).post);
    const download = record(record(paths['/api/v1/workspace-exports/{exportId}']).get);
    const schemas = record(record(document.components).schemas);

    expect(create.security).toEqual([{ sessionCookie: [] }]);
    const createParameters = (create.parameters as unknown[]).map(record);
    expect(createParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
    ]));
    const createStatuses = record(create.responses);
    ['200', '201', '400', '401', '403', '404', '409', '413', '422', '429', '500'].forEach((status) => expect(createStatuses[status]).toBeDefined());

    const request = record(record(create.requestBody).content);
    const requestSchema = record(record(request['application/json']).schema);
    expect(requestSchema.$ref).toBe('#/components/schemas/WorkspaceExportCreateRequest');
    const createShape = record(schemas.WorkspaceExportCreateRequest);
    expect(createShape.required).toEqual(['workspaceId']);
    expect(createShape.additionalProperties).toBe(false);

    expect(download.security).toEqual([{ sessionCookie: [] }]);
    const downloadResponses = record(download.responses);
    const success = record(downloadResponses['200']);
    expect(record(success.headers)['Cache-Control']).toBeDefined();
    expect(record(success.headers)['X-Content-Type-Options']).toBeDefined();
    const content = record(success.content);
    const binary = record(record(content['application/json']).schema);
    expect(binary).toMatchObject({ type: 'string', format: 'binary' });
    expect(downloadResponses['404']).toBeDefined();

    const exportShape = record(schemas.WorkspaceExport);
    expect(exportShape.required).toEqual(['id', 'workspaceId', 'sizeBytes', 'expiresAt']);
    expect(exportShape.additionalProperties).toBe(false);
  });
});
