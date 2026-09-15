import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

const EXPECTED_OPERATIONS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  '/api/v1/projects/{projectId}/conversations': {
    get: ['200', '400', '401', '404', '500', '503'],
    post: ['200', '201', '400', '401', '403', '404', '409', '500', '503']
  },
  '/api/v1/conversations/{conversationId}': {
    get: ['200', '400', '401', '404', '500', '503']
  },
  '/api/v1/conversations/{conversationId}/messages': {
    post: ['200', '201', '400', '401', '403', '404', '409', '500', '503']
  }
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function resolvePointer(root: JsonRecord, reference: string): unknown {
  if (!reference.startsWith('#/')) {
    throw new Error(`Unsupported OpenAPI reference: ${reference}`);
  }
  return reference.slice(2).split('/').reduce<unknown>((current, segment) => {
    const record = asRecord(current, reference);
    return record[segment];
  }, root);
}

function visitReferences(value: unknown, root: JsonRecord, references: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitReferences(entry, root, references));
    return references;
  }
  if (!isRecord(value)) {
    return references;
  }
  const reference = value.$ref;
  if (typeof reference === 'string') {
    references.push(reference);
    resolvePointer(root, reference);
  }
  Object.values(value).forEach((entry) => visitReferences(entry, root, references));
  return references;
}

function responseSchema(operation: JsonRecord, status: string): string | undefined {
  const responses = asRecord(operation.responses, 'operation responses');
  const response = asRecord(responses[status], `response ${status}`);
  if (typeof response.$ref === 'string') {
    const resolved = asRecord(resolvePointer(asRecord(openApiDocument, 'document'), response.$ref), response.$ref);
    const content = asRecord(resolved.content, `${status} response content`);
    const applicationJson = asRecord(content['application/json'], `${status} JSON content`);
    const schema = asRecord(applicationJson.schema, `${status} response schema`);
    return typeof schema.$ref === 'string' ? schema.$ref : undefined;
  }
  const content = asRecord(response.content, `${status} response content`);
  const applicationJson = asRecord(content['application/json'], `${status} JSON content`);
  const schema = asRecord(applicationJson.schema, `${status} response schema`);
  return typeof schema.$ref === 'string' ? schema.$ref : undefined;
}

describe('conversation OpenAPI document', () => {
  it('documents every Task 2.2 endpoint, envelope, DTO, error status, and reference', () => {
    const document = asRecord(openApiDocument, 'OpenAPI document');
    expect(document.openapi).toBe('3.0.3');
    const paths = asRecord(document.paths, 'paths');

    for (const [path, operations] of Object.entries(EXPECTED_OPERATIONS)) {
      const pathItem = asRecord(paths[path], path);
      for (const [method, statuses] of Object.entries(operations)) {
        const operation = asRecord(pathItem[method], `${method.toUpperCase()} ${path}`);
        const responses = asRecord(operation.responses, `${method.toUpperCase()} ${path} responses`);
        statuses.forEach((status) => expect(responses[status]).toBeDefined());
        expect(responseSchema(operation, '200') ?? responseSchema(operation, '201')).toMatch(/Envelope$/u);

        if (method === 'post') {
          const requestBody = asRecord(operation.requestBody, `${method.toUpperCase()} ${path} request body`);
          expect(requestBody.required).toBe(true);
          const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
          const references = parameters.map((parameter) => asRecord(parameter, 'operation parameter').$ref).filter((reference): reference is string => typeof reference === 'string');
          expect(references).toEqual(expect.arrayContaining([
            '#/components/parameters/OriginHeader',
            '#/components/parameters/CsrfHeader',
            '#/components/parameters/IdempotencyHeader'
          ]));
        }
      }
    }

    const schemas = asRecord(asRecord(document.components, 'components').schemas, 'schemas');
    ['ApiError', 'ErrorDetail', 'ErrorEnvelope', 'Conversation', 'Message', 'CreateConversationRequest', 'CreateMessageRequest', 'ConversationListEnvelope', 'ConversationHistoryEnvelope', 'MessageEnvelope'].forEach((schema) => expect(schemas[schema]).toBeDefined());
    expect(visitReferences(document, document).length).toBeGreaterThan(0);
  });
});
