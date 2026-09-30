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
      '/api/v1/projects/{projectId}/file-history': { get: ['200', '400', '401', '404', '500'] },
      '/api/v1/projects/{projectId}/provider-permissions': { get: ['200', '401', '500'] },
      '/api/v1/projects/{projectId}/provider-permissions/{permissionId}': { delete: ['200', '401', '403', '404', '500'] },
      '/api/v1/ai-runs/{runId}': { get: ['200', '401', '404', '500'] },
      '/api/v1/ai-runs/{runId}/egress-manifest': { get: ['200', '401', '404', '409', '500'] },
      '/api/v1/ai-runs/{runId}/egress-decision': { post: ['200', '400', '401', '403', '404', '409', '500', '503'] },
      '/api/v1/ai-runs/{runId}/proposed-change-set': { get: ['200', '401', '404', '500'] },
      '/api/v1/ai-runs/{runId}/proposed-change-set/decision': { post: ['200', '400', '401', '403', '404', '409', '503'] },
      '/api/v1/ai-runs/{runId}/start': { post: ['200', '202', '400', '401', '403', '404', '409', '500'] },
      '/api/v1/ai-runs/{runId}/cancel': { post: ['200', '202', '400', '401', '403', '404', '409', '500', '503'] },
      '/api/v1/ai-runs/{runId}/events': { get: ['200', '401', '404', '500'] }
      ,'/api/v1/ai-runs/{runId}/commands': { get: ['200', '401', '404', '500'] }
      ,'/api/v1/ai-runs/{runId}/commands/{commandId}': { get: ['200', '401', '404', '500'] }
      ,'/api/v1/ai-runs/{runId}/commands/{commandId}/decision': { post: ['200', '400', '401', '403', '404', '409', '500', '503'] }
      ,'/api/v1/ai-runs/{runId}/commands/{commandId}/cancel': { post: ['200', '202', '400', '401', '403', '404', '409', '500', '503'] }
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
    ['CreateAiRunRequest', 'EgressDecisionRequest', 'AiRunSnapshot', 'EgressManifest', 'AiRunIntentEnvelope', 'EgressDecisionEnvelope', 'ProviderPermission', 'ProviderPermissionList', 'ProviderPermissionListEnvelope', 'ProviderPermissionEnvelope', 'ProposedChangeSetDecisionRequest', 'ProposedChangeSet', 'ProposedChangeOperation', 'ProposedChangeOperationResult', 'ProposedChangeSetResult', 'ProposedChangeSetEnvelope', 'ProjectFileHistoryItem', 'ProjectFileHistoryPage', 'ProjectFileHistoryEnvelope', 'SandboxCommandDecisionRequest', 'SandboxCommand', 'SandboxCommandListEnvelope', 'SandboxCommandEnvelope', 'EmptyObject'].forEach((schema) => {
      expect(schemas[schema]).toBeDefined();
    });
    const runSnapshot = asRecord(schemas.AiRunSnapshot);
    const runProperties = asRecord(runSnapshot.properties);
    expect(asRecord(runProperties.status).enum).toEqual(expect.arrayContaining(['queued', 'running', 'succeeded', 'cancelled', 'review_required']));
    const listSchema = asRecord(schemas.SandboxCommandList);
    const listProperties = asRecord(listSchema.properties);
    expect(asRecord(listProperties.commands).maxItems).toBe(100);
    const operationResult = asRecord(schemas.ProposedChangeOperationResult);
    expect(asRecord(asRecord(operationResult.properties).backup).enum).toContain('not_created');
    const fileHistoryItem = asRecord(schemas.ProjectFileHistoryItem);
    expect(asRecord(asRecord(fileHistoryItem.properties).backupStatus).enum).toContain('not_created');
  });
});
