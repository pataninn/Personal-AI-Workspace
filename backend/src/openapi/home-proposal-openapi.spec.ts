import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function expectRetiredOperation(paths: JsonRecord, pathName: string, method: string): void {
  const operation = record(record(paths[pathName], pathName)[method], `${method} ${pathName}`);
  const responses = record(operation.responses, `${method} ${pathName} responses`);
  expect(Object.keys(responses).filter((status) => status.startsWith('2'))).toEqual([]);
  const retired = record(responses['409'], `${method} ${pathName} 409 response`);
  expect(retired.description).toEqual(expect.stringContaining('POLICY_ACTION_RETIRED'));
  const schema = record(record(record(retired.content, '409 content')['application/json'], '409 JSON content').schema, '409 error schema');
  expect(schema.$ref).toBe('#/components/schemas/ErrorEnvelope');
  expect(operation.security).toEqual([{ sessionCookie: [] }]);
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  expect(parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ $ref: '#/components/parameters/OriginHeader' }),
    expect.objectContaining({ $ref: '#/components/parameters/CsrfHeader' })
  ]));
  expect(responses['400']).toBeDefined();
  expect(responses['401']).toBeDefined();
  expect(responses['403']).toBeDefined();
}

describe('Home proposal OpenAPI contract', () => {
  it('documents owner-scoped proposal review, execution, and cancellation endpoints', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const expected = [
      ['/api/v1/home/conversations/{conversationId}/proposals', 'get', '200'],
      ['/api/v1/home/conversations/{conversationId}/proposals/{proposalId}', 'get', '200'],
      ['/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/cancellation', 'post', '200']
    ] as const;

    for (const [pathName, method, successCode] of expected) {
      const operation = record(record(paths[pathName], pathName)[method], `${method} ${pathName}`);
      const responses = record(operation.responses, `${method} ${pathName} responses`);
      expect(operation.security).toEqual([{ sessionCookie: [] }]);
      expect(responses[successCode]).toBeDefined();
      expect(responses['401']).toBeDefined();
      if (method !== 'get') {
        expect(responses['403']).toBeDefined();
        const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
        expect(parameters).toEqual(expect.arrayContaining([
          expect.objectContaining({ $ref: '#/components/parameters/OriginHeader' }),
          expect.objectContaining({ $ref: '#/components/parameters/CsrfHeader' })
        ]));
      }
    }
    expectRetiredOperation(paths, '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}', 'patch');
    expectRetiredOperation(paths, '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}', 'delete');
    expectRetiredOperation(paths, '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/acceptance', 'post');
    expectRetiredOperation(paths, '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/execution', 'post');
  });

  it('defines strict proposal revisions, bounded item states, and execution result schemas', () => {
    const components = record(record(openApiDocument, 'OpenAPI document').components, 'components');
    const schemas = record(components.schemas, 'schemas');
    expect(schemas.HomeProposalState).toBeDefined();
    expect(schemas.HomeProposalItemState).toBeDefined();
    expect(schemas.HomeProposalItem).toBeDefined();
    const proposalItem = record(schemas.HomeProposalItem, 'HomeProposalItem');
    const itemProperties = record(proposalItem.properties, 'HomeProposalItem properties');
    const deadlineResolution = record(itemProperties.deadlineResolution, 'HomeProposalItem deadlineResolution');
    const deadlineProperties = record(deadlineResolution.properties, 'deadlineResolution properties');
    const resolutionRequired = Array.isArray(deadlineResolution.required) ? deadlineResolution.required : [];
    const proposalItemRequired = Array.isArray(proposalItem.required) ? proposalItem.required : [];
    expect(deadlineResolution).toMatchObject({ type: 'object', nullable: true, additionalProperties: false });
    expect(deadlineProperties.timeZone).toEqual({ type: 'string' });
    expect(deadlineProperties.source).toEqual({ type: 'string', enum: ['configured', 'utc-fallback'] });
    expect(resolutionRequired).toEqual(expect.arrayContaining(['timeZone', 'source']));
    expect(proposalItemRequired).toContain('deadlineResolution');
    expect(schemas.HomeChangeProposal).toBeDefined();
    expect(schemas.HomeProposalExecution).toBeDefined();
    expect(schemas.HomeProposalRevisionRequest).toBeDefined();
    expect(schemas.HomeProposalEditRequest).toBeDefined();
    expect(schemas.HomeProposalAcceptanceEnvelope).toBeDefined();
    expect(schemas.HomeProposalExecutionEnvelope).toBeDefined();
    const parameters = record(components.parameters, 'parameters');
    expect(parameters.HomeProposalIdPath).toBeDefined();
    expect(parameters.HomeProposalItemIdPath).toBeDefined();
    expect(parameters.HomeProposalIfMatchHeader).toBeDefined();
  });
});
