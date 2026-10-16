import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

describe('Home conversation OpenAPI contract', () => {
  it('documents owner-scoped history, submission, cancellation, and event replay routes', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const expected = [
      ['/api/v1/home/conversations', 'get'],
      ['/api/v1/home/conversations', 'post'],
      ['/api/v1/home/conversations/{conversationId}', 'get'],
      ['/api/v1/home/conversations/{conversationId}/turns', 'get'],
      ['/api/v1/home/conversations/{conversationId}/turns', 'post'],
      ['/api/v1/home/conversations/{conversationId}/turns/{turnId}', 'get'],
      ['/api/v1/home/conversations/{conversationId}/turns/{turnId}/cancellation', 'post'],
      ['/api/v1/home/conversations/{conversationId}/turns/{turnId}/consent-decisions', 'post'],
      ['/api/v1/home/conversations/{conversationId}/messages', 'get'],
      ['/api/v1/home/conversations/{conversationId}/events', 'get']
    ] as const;

    for (const [pathName, method] of expected) {
      const path = record(paths[pathName], pathName);
      const operation = record(path[method], `${method} ${pathName}`);
      const responses = record(operation.responses, `${pathName} responses`);
      expect(operation.security).toEqual([{ sessionCookie: [] }]);
      expect(responses['200']).toBeDefined();
      expect(responses['401']).toBeDefined();
      if (method === 'post') expect(responses['403']).toBeDefined();
    }
  });

  it('defines bounded sequence replay and the honest unsupported runtime submission result', () => {
    const components = record(record(openApiDocument, 'OpenAPI document').components, 'components');
    const schemas = record(components.schemas, 'schemas');
    const event = record(schemas.HomeEvent, 'HomeEvent schema');
    const eventProperties = record(event.properties, 'HomeEvent properties');
    const eventType = record(eventProperties.type, 'HomeEvent.type');
    expect(eventType.enum).toEqual([
      'conversation.created', 'turn.created', 'turn.status_changed', 'message.appended', 'action.receipt',
      'consent.requested', 'consent.decided', 'proposal.created', 'proposal.updated', 'proposal.accepted',
      'proposal.cancelled', 'proposal.item_status_changed'
    ]);

    const submission = record(schemas.HomeTurnSubmissionEnvelope, 'HomeTurnSubmissionEnvelope');
    const data = record(record(submission.properties, 'submission properties').data, 'submission data');
    const dataProperties = record(data.properties, 'submission data properties');
    expect(dataProperties.turn).toBeDefined();
    expect(dataProperties.message).toBeDefined();
    expect(dataProperties.execution).toBeDefined();
    expect(dataProperties.replayed).toBeDefined();
    expect(schemas.HomeTurn).toBeDefined();
    expect(schemas.HomeEventPageEnvelope).toBeDefined();
    expect(schemas.HomeConsentDecisionRequest).toBeDefined();
    expect(schemas.HomeConsentDecisionEnvelope).toBeDefined();
    expect(schemas.HomeConsentDisclosure).toBeDefined();
  });
});
