import openApiDocument from '../../openapi.json';

type RecordLike = Record<string, unknown>;

function record(value: unknown, label: string): RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordLike;
}

describe('demo admission OpenAPI contract', () => {
  it('documents empty request, conditional CSRF/idempotency, statuses, and safe cookie-less replay', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const path = record(paths['/api/v1/demo/session'], 'demo admission path');
    const operation = record(path.post, 'demo admission POST');
    expect(operation.operationId).toBe('createOrResumeDemoSession');
    expect(operation.parameters).toEqual([
      { $ref: '#/components/parameters/OriginHeader' },
      { $ref: '#/components/parameters/DemoAdmissionCsrfHeader' },
      { $ref: '#/components/parameters/DemoAdmissionIdempotencyHeader' }
    ]);
    expect(operation.responses).toEqual(expect.objectContaining({
      '200': expect.any(Object), '201': expect.any(Object), '202': expect.any(Object),
      '400': expect.any(Object), '403': expect.any(Object), '409': expect.any(Object),
      '429': expect.any(Object), '503': expect.any(Object), '500': expect.any(Object)
    }));
    const components = record(document.components, 'components');
    const parameters = record(components.parameters, 'parameters');
    expect(parameters.DemoAdmissionCsrfHeader).toMatchObject({ name: 'X-CSRF-Token', required: false });
    expect(parameters.DemoAdmissionIdempotencyHeader).toMatchObject({
      name: 'Idempotency-Key', required: false,
      schema: { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' }
    });
    const schemas = record(components.schemas, 'schemas');
    expect(schemas.DemoAdmissionRequest).toMatchObject({ type: 'object', additionalProperties: false });
    expect(schemas.DemoSessionData).toMatchObject({ required: ['state', 'principal', 'csrfToken', 'expiresAt'] });
    expect(schemas.DemoAdmissionStatusData).toMatchObject({
      required: ['state'], properties: { state: { enum: ['pending', 'ready'] } }
    });
    expect(record(operation.responses, 'responses')['202']).toMatchObject({ description: expect.stringContaining('no cookie is set') });
  });
});
