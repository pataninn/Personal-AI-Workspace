import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

describe('project memory OpenAPI contract', () => {
  it('documents the fact CRUD and review routes with their error and concurrency behavior', () => {
    const document = asRecord(openApiDocument, 'OpenAPI document');
    const paths = asRecord(document.paths, 'paths');
    const expected: Record<string, Record<string, readonly string[]>> = {
      '/api/v1/projects/{projectId}/facts': {
        get: ['200', '401', '404', '500'],
        post: ['201', '400', '401', '403', '404', '409', '500']
      },
      '/api/v1/projects/{projectId}/facts/{factId}': {
        patch: ['200', '400', '401', '403', '404', '409', '500'],
        delete: ['204', '400', '401', '403', '404', '409', '500']
      },
      '/api/v1/projects/{projectId}/facts/{factId}/verification': {
        post: ['200', '400', '401', '403', '404', '409', '500']
      }
    };

    for (const [path, methods] of Object.entries(expected)) {
      const pathItem = asRecord(paths[path], path);
      for (const [method, statuses] of Object.entries(methods)) {
        const operation = asRecord(pathItem[method], `${method.toUpperCase()} ${path}`);
        const responses = asRecord(operation.responses, `${method.toUpperCase()} ${path} responses`);
        statuses.forEach((status) => expect(responses[status]).toBeDefined());
        if (method !== 'get') {
          const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
          const refs = parameters.map((parameter) => asRecord(parameter, 'parameter').$ref);
          expect(refs).toEqual(expect.arrayContaining([
            '#/components/parameters/OriginHeader',
            '#/components/parameters/CsrfHeader'
          ]));
        }
      }
    }

    const factResource = asRecord(paths['/api/v1/projects/{projectId}/facts/{factId}'], 'fact resource path');
    const deleteOperation = asRecord(factResource.delete, 'DELETE fact');
    const deleteParameters = deleteOperation.parameters as unknown[];
    expect(deleteParameters.map((parameter) => asRecord(parameter, 'DELETE parameter').$ref)).toContain('#/components/parameters/IfMatchVersionHeader');
  });

  it('documents editable user-owned facts and exact selected disclosure snapshots', () => {
    const document = asRecord(openApiDocument, 'OpenAPI document');
    const components = asRecord(document.components, 'components');
    const schemas = asRecord(components.schemas, 'schemas');
    [
      'ProjectFactSource',
      'ProjectFact',
      'ProjectFactList',
      'ProjectFactListEnvelope',
      'ProjectFactEnvelope',
      'CreateProjectFactRequest',
      'UpdateProjectFactRequest',
      'ReviewProjectFactRequest',
      'EgressProjectFact'
    ].forEach((name) => expect(schemas[name]).toBeDefined());

    const create = asRecord(schemas.CreateProjectFactRequest, 'create request');
    expect(Object.keys(asRecord(create.properties, 'create properties'))).toEqual(['title', 'content']);

    const aiRunPaths = asRecord(document.paths, 'paths');
    const createRunPath = asRecord(aiRunPaths['/api/v1/projects/{projectId}/ai-runs'], 'create AI run path');
    const createRun = asRecord(createRunPath.post, 'create AI run');
    const requestBody = asRecord(createRun.requestBody, 'create AI run request body');
    const requestContent = asRecord(requestBody.content, 'request content');
    const requestSchema = asRecord(asRecord(requestContent['application/json'], 'JSON request').schema, 'request schema');
    const createRunRequest = asRecord(schemas.CreateAiRunRequest, 'create AI run schema');
    expect(requestSchema.$ref).toBe('#/components/schemas/CreateAiRunRequest');
    const context = asRecord(asRecord(createRunRequest.properties, 'run request properties').context, 'run context');
    const factIds = asRecord(asRecord(context.properties, 'context properties').factIds, 'factIds');
    expect(factIds.maxItems).toBeUndefined();
    expect(factIds.uniqueItems).toBeUndefined();
    expect(factIds.description).toMatch(/defaults to none.*25 distinct IDs/iu);
    expect(factIds.description).toMatch(/deduplicated/iu);

    const egressFact = asRecord(schemas.EgressProjectFact, 'egress fact');
    const egressFactProperties = asRecord(egressFact.properties, 'egress fact properties');
    expect(egressFactProperties.content).toBeDefined();
    expect(egressFactProperties.sourceHash).toBeDefined();
    const egressManifest = asRecord(schemas.EgressManifest, 'egress manifest');
    const manifestContent = asRecord(asRecord(egressManifest.properties, 'manifest properties').content, 'manifest content');
    const manifestContentProperties = asRecord(manifestContent.properties, 'manifest content properties');
    expect(manifestContentProperties.facts).toBeDefined();
    expect(manifestContentProperties.factCount).toBeDefined();
  });
});
