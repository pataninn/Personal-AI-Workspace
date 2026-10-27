import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

const EXPECTED_OPERATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  '/api/v1/demo/session': { post: ['200', '201', '202', '400', '403', '409', '429', '500', '503'] },
  '/api/v1/demo/availability': { get: ['200', '500'] },
  '/api/v1/showcases/current': { get: ['200', '404', '500'] },
  '/api/v1/showcases/current/files/{fileId}': { get: ['200', '404', '500'] },
  '/api/v1/admin/showcases/previews': { post: ['200', '400', '401', '403', '404', '413', '500', '503'] },
  '/api/v1/admin/showcases/versions': { post: ['200', '201', '400', '401', '403', '404', '409', '413', '500', '503'] },
  '/api/v1/demo/showcase-copy': { get: ['200', '202', '401', '500'] },
  '/api/v1/demo/showcase-copy/retries': { post: ['200', '202', '400', '401', '403', '409', '500', '503'] }
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function resolvePointer(root: JsonRecord, reference: string): unknown {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported OpenAPI reference: ${reference}`);
  return reference.slice(2).split('/').reduce<unknown>((current, segment) => asRecord(current, reference)[segment], root);
}

function visitReferences(value: unknown, root: JsonRecord): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => visitReferences(entry, root));
  if (!isRecord(value)) return [];
  const own = typeof value.$ref === 'string' ? [value.$ref] : [];
  own.forEach((reference) => resolvePointer(root, reference));
  return [...own, ...Object.values(value).flatMap((entry) => visitReferences(entry, root))];
}

describe('showcase and private demo OpenAPI contract', () => {
  it('documents the eight Task 3.4 operations, status codes, and resolvable references', () => {
    const document = asRecord(openApiDocument, 'OpenAPI document');
    expect(document.openapi).toBe('3.0.3');
    const paths = asRecord(document.paths, 'paths');

    for (const [path, methods] of Object.entries(EXPECTED_OPERATIONS)) {
      const item = asRecord(paths[path], path);
      for (const [method, statuses] of Object.entries(methods)) {
        const operation = asRecord(item[method], `${method.toUpperCase()} ${path}`);
        const responses = asRecord(operation.responses, `${method.toUpperCase()} ${path} responses`);
        statuses.forEach((status) => expect(responses[status]).toBeDefined());
        expect(operation.operationId).toBeDefined();
      }
    }

    const referenced = visitReferences(document, document);
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('requires session, exact Origin, and CSRF on administrator mutations', () => {
    const document = asRecord(openApiDocument, 'OpenAPI document');
    const paths = asRecord(document.paths, 'paths');
    for (const path of ['/api/v1/admin/showcases/previews', '/api/v1/admin/showcases/versions']) {
      const operation = asRecord(asRecord(paths[path], path).post, `POST ${path}`);
      expect(operation.security).toEqual([{ sessionCookie: [] }]);
      const parameters = operation.parameters as unknown[];
      const refs = parameters.map((parameter) => asRecord(parameter, 'parameter').$ref);
      expect(refs).toEqual(expect.arrayContaining([
        '#/components/parameters/OriginHeader',
        '#/components/parameters/CsrfHeader'
      ]));
      expect(asRecord(operation.requestBody, 'request body').required).toBe(true);
    }
    const publish = asRecord(asRecord(paths['/api/v1/admin/showcases/versions'], 'publish').post, 'publish');
    expect((publish.parameters as unknown[]).map((parameter) => asRecord(parameter, 'parameter').$ref)).toContain('#/components/parameters/ShowcaseIdempotencyHeader');
  });

  it('keeps preview bytes admin-only and separates preview from publish-generated public IDs', () => {
    const components = asRecord(asRecord(openApiDocument, 'document').components, 'components');
    const schemas = asRecord(components.schemas, 'schemas');
    const previewFile = asRecord(schemas.PreviewFile, 'PreviewFile');
    const previewProperties = asRecord(previewFile.properties, 'PreviewFile properties');
    expect(Object.keys(previewProperties)).toEqual(['name', 'mediaType', 'byteLength', 'sha256', 'contentBase64']);
    expect(previewFile.additionalProperties).toBe(false);

    const publishResponse = asRecord(schemas.ShowcasePublishResult, 'ShowcasePublishResult');
    expect(publishResponse.required).toEqual(['version', 'publishedAt']);
    const publishProperties = asRecord(publishResponse.properties, 'publish result properties');
    expect(publishProperties.version).toEqual({ $ref: '#/components/schemas/Uuid' });
  });

  it('documents current files as raw attachment bytes and exposes the owner project ID only through ready copy status', () => {
    const paths = asRecord(asRecord(openApiDocument, 'document').paths, 'paths');
    const fileRoute = asRecord(asRecord(paths['/api/v1/showcases/current/files/{fileId}'], 'file path').get, 'file route');
    const fileResponses = asRecord(fileRoute.responses, 'file responses');
    const fileResponse = asRecord(fileResponses['200'], 'file 200');
    const content = asRecord(fileResponse.content, 'file content');
    expect(asRecord(content['application/octet-stream'], 'binary content').schema).toEqual({ type: 'string', format: 'binary' });
    expect(asRecord(fileResponse.headers, 'file headers')['X-Content-Type-Options']).toBeDefined();

    const statusRoute = asRecord(asRecord(paths['/api/v1/demo/showcase-copy'], 'copy status path').get, 'copy status route');
    expect(statusRoute.security).toEqual([{ sessionCookie: [] }]);
    const copySchema = asRecord(asRecord(asRecord(openApiDocument, 'document').components, 'components').schemas, 'schemas').DemoShowcaseCopy;
    const copyProperties = asRecord(asRecord(copySchema, 'DemoShowcaseCopy').properties, 'copy properties');
    expect(Object.keys(copyProperties)).toEqual(['state', 'projectId', 'retryAllowed', 'workspaceMode', 'capabilities']);
    expect(copyProperties.projectId).toMatchObject({ type: 'string', format: 'uuid', nullable: true });
    expect(String(asRecord(copyProperties.projectId, 'copy project ID').description)).toContain('Null unless state is ready');
  });
});
