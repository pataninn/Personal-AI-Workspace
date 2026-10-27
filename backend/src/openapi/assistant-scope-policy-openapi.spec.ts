import document from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

describe('assistant scope policy OpenAPI contract', () => {
  it('documents a strict, authenticated, read-only scope status endpoint and its safe DTO', () => {
    const root = record(document, 'document');
    const paths = record(root.paths, 'paths');
    const path = record(paths['/api/v1/assistant/execution-policy'], 'execution policy path');
    const operation = record(path.get, 'GET execution policy');
    const params = operation.parameters as readonly unknown[];
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
    expect(params.map((value) => record(value, 'query parameter').name)).toEqual(['scope', 'projectId']);
    expect(operation.responses).toMatchObject({ 200: expect.any(Object), 400: expect.any(Object), 401: expect.any(Object), 404: expect.any(Object), 500: expect.any(Object) });

    const components = record(root.components, 'components');
    const schemas = record(components.schemas, 'schemas');
    const envelope = record(schemas.AssistantExecutionPolicyEnvelope, 'status envelope');
    const envelopeData = record(envelope.properties, 'envelope properties').data;
    const dataProperties = record(record(envelopeData, 'data schema').properties, 'data properties');
    expect(Object.keys(dataProperties).sort()).toEqual(['fileAccess', 'policy', 'readiness', 'scope']);
    expect(JSON.stringify(schemas.AssistantExecutionPolicy)).not.toContain('relativeRoot');
    expect(JSON.stringify(schemas.AssistantExecutionPolicy)).not.toContain('ownerId');
    expect(JSON.stringify(operation)).not.toContain('csrf');
    expect(JSON.stringify(operation)).not.toContain('OriginHeader');
  });
});
