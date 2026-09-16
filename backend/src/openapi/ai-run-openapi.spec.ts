import openApiDocument from '../../openapi.json';

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.');
  }
  return value as RecordValue;
}

describe('AI run OpenAPI document', () => {
  it('documents the manifest, consent, and status endpoints', () => {
    const document = asRecord(openApiDocument);
    const paths = asRecord(document.paths);
    const expected: Record<string, Record<string, string[]>> = {
      '/api/v1/projects/{projectId}/ai-runs': { post: ['200', '202', '400', '401', '403', '404', '409', '500', '503'] },
      '/api/v1/ai-runs/{runId}': { get: ['200', '401', '404', '500'] },
      '/api/v1/ai-runs/{runId}/egress-manifest': { get: ['200', '401', '404', '409', '500'] },
      '/api/v1/ai-runs/{runId}/egress-decision': { post: ['200', '400', '401', '403', '404', '409', '500', '503'] }
    };
    for (const [path, methods] of Object.entries(expected)) {
      const pathItem = asRecord(paths[path]);
      for (const [method, statuses] of Object.entries(methods)) {
        const operation = asRecord(pathItem[method]);
        const responses = asRecord(operation.responses);
        statuses.forEach((status) => expect(responses[status]).toBeDefined());
      }
    }
    const schemas = asRecord(asRecord(document.components).schemas);
    ['CreateAiRunRequest', 'EgressDecisionRequest', 'AiRunSnapshot', 'EgressManifest', 'AiRunIntentEnvelope', 'EgressDecisionEnvelope'].forEach((schema) => {
      expect(schemas[schema]).toBeDefined();
    });
  });
});
