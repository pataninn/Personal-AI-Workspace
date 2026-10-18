import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

describe('workspace planning OpenAPI contract', () => {
  it('documents bounded metadata search, explicit reuse, and ledger-backed workspace mutations', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const expected: Record<string, Record<string, readonly string[]>> = {
      '/api/v1/projects': { post: ['201', '400', '401', '403', '409', '500', '503'] },
      '/api/v1/projects/search': { get: ['200', '400', '401', '500'] },
      '/api/v1/projects/reuse': { post: ['200', '400', '401', '403', '404', '409', '500'] },
      '/api/v1/projects/planning': { post: ['200', '201', '400', '401', '403', '409', '500'] },
      '/api/v1/projects/{projectId}/objective': { patch: ['200', '400', '401', '403', '404', '409', '500'] },
      '/api/v1/projects/{projectId}/root-attachment': { patch: ['200', '400', '401', '403', '404', '409', '500', '503'] }
    };

    for (const [path, methods] of Object.entries(expected)) {
      const pathItem = record(paths[path], path);
      for (const [method, statuses] of Object.entries(methods)) {
        const operation = record(pathItem[method], `${method.toUpperCase()} ${path}`);
        const responses = record(operation.responses, `${method.toUpperCase()} ${path} responses`);
        statuses.forEach((status) => expect(responses[status]).toBeDefined());
        expect(operation.security).toEqual([{ sessionCookie: [] }]);
        if (method !== 'get') {
          const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
          const refs = parameters.map((parameter) => record(parameter, 'mutation parameter').$ref);
          expect(refs).toEqual(expect.arrayContaining([
            '#/components/parameters/OriginHeader',
            '#/components/parameters/CsrfHeader'
          ]));
        }
      }
    }

    const planning = record(record(paths['/api/v1/projects/planning'], 'planning route').post, 'planning create');
    expect(planning.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: '#/components/parameters/WorkspaceIdempotencyKeyHeader' })
    ]));
    const objective = record(record(paths['/api/v1/projects/{projectId}/objective'], 'objective route').patch, 'objective update');
    expect(objective.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: '#/components/parameters/ProjectIfMatchHeader' }),
      expect.objectContaining({ $ref: '#/components/parameters/WorkspaceIdempotencyKeyHeader' })
    ]));
    const attachment = record(record(paths['/api/v1/projects/{projectId}/root-attachment'], 'root attachment route').patch, 'root attachment');
    expect(attachment.summary).toMatch(/managed root/iu);
    expect(attachment.description).toMatch(/cannot select or attach a host path/iu);
    expect(attachment.description).toMatch(/not reversible/iu);
    const attachmentBody = record(attachment.requestBody, 'root attachment request body');
    const attachmentContent = record(attachmentBody.content, 'root attachment content');
    const attachmentJson = record(attachmentContent['application/json'], 'root attachment JSON body');
    expect(attachmentJson.schema).toEqual({ $ref: '#/components/schemas/AttachProjectRootRequest' });
    expect(attachment.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ $ref: '#/components/parameters/ProjectIfMatchHeader' }),
      expect.objectContaining({ $ref: '#/components/parameters/WorkspaceIdempotencyKeyHeader' })
    ]));
  });

  it('keeps search results metadata-only and defines the action receipt response shape', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const components = record(document.components, 'components');
    const schemas = record(components.schemas, 'schemas');
    [
      'ReuseProjectRequest',
      'CreatePlanningProjectRequest',
      'UpdateProjectObjectiveRequest',
      'AttachProjectRootRequest',
      'ProjectMetadataSearchItem',
      'ProjectMetadataSearchPage',
      'ProjectMetadataSearchPageEnvelope',
      'ProjectActionReceipt',
      'ProjectPlanningActionResult',
      'ProjectPlanningActionEnvelope'
    ].forEach((name) => expect(schemas[name]).toBeDefined());

    const searchItem = record(schemas.ProjectMetadataSearchItem, 'search item');
    const searchProperties = record(searchItem.properties, 'search item properties');
    expect(searchProperties.relativeRoot).toBeUndefined();
    expect(searchProperties.ownerId).toBeUndefined();

    const representation = record(schemas.ProjectRepresentation, 'project representation');
    const representationProperties = record(representation.properties, 'project representation properties');
    expect(representationProperties.relativeRoot).toBeUndefined();
    expect(record(schemas.ProjectSummary, 'project summary').properties).not.toHaveProperty('relativeRoot');

    const createProject = record(schemas.CreateProjectRequest, 'create project request');
    const createProjectProperties = record(createProject.properties, 'create project properties');
    expect(createProjectProperties.relativeRoot).toBeUndefined();
    expect(createProject.required).toEqual(['name']);
    expect(createProjectProperties.workspaceMode).toEqual(expect.objectContaining({ default: 'file_backed', enum: ['planning', 'file_backed'] }));
    const attachRequest = record(schemas.AttachProjectRootRequest, 'managed root request');
    expect(attachRequest.properties).toEqual({});
    expect(attachRequest.required).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('"relativeRoot"');
    const workspaceUnavailable = record(record(components.responses, 'responses').WorkspaceUnavailable, 'workspace unavailable response');
    expect(workspaceUnavailable.description).toMatch(/storage is unavailable/iu);
    const receipt = record(schemas.ProjectActionReceipt, 'action receipt');
    const receiptProperties = record(receipt.properties, 'receipt properties');
    expect(receiptProperties.undoStatus).toEqual(expect.objectContaining({ enum: expect.arrayContaining(['not_reversible']) }));

    const parameters = record(components.parameters, 'parameters');
    expect(parameters.ProjectIfMatchHeader).toBeDefined();
    expect(parameters.WorkspaceIdempotencyKeyHeader).toBeDefined();
  });
});
