import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

describe('action undo OpenAPI contract', () => {
  it('documents the single-receipt reload lookup without exposing reversible values', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const path = record(paths['/api/v1/actions/{actionId}'], 'receipt path');
    const operation = record(path.get, 'receipt operation');
    const responses = record(operation.responses, 'receipt responses');
    const components = record(document.components, 'components');
    const schemas = record(components.schemas, 'schemas');
    const metadata = record(schemas.ActionReceiptMetadata, 'receipt metadata schema');
    const properties = record(metadata.properties, 'receipt metadata properties');

    expect(operation.operationId).toBe('getActionReceipt');
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
    ['200', '400', '401', '404', '500'].forEach((status) => expect(responses[status]).toBeDefined());
    expect(Object.keys(properties).sort()).toEqual([
      'actionKind', 'id', 'postVersion', 'targetId', 'targetKind', 'undoActionId', 'undoStatus'
    ].sort());
    expect(properties.reversibleFields).toBeUndefined();
    expect(properties.requestFingerprint).toBeUndefined();
  });

  it('documents the owner-scoped undo command, guarded replay, and safe conflict envelope', () => {
    const document = record(openApiDocument, 'OpenAPI document');
    const paths = record(document.paths, 'paths');
    const path = record(paths['/api/v1/actions/{actionId}/undo'], 'undo path');
    const operation = record(path.post, 'undo operation');
    const responses = record(operation.responses, 'undo responses');
    const components = record(document.components, 'components');
    const schemas = record(components.schemas, 'schemas');
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    const refs = parameters.filter((item) => item && typeof item === 'object').map((item) => (item as JsonRecord).$ref);

    expect(operation.operationId).toBe('undoAction');
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
    expect(parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'actionId', in: 'path', required: true }),
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
    ]));
    expect(refs).toEqual(expect.arrayContaining([
      '#/components/parameters/OriginHeader',
      '#/components/parameters/CsrfHeader'
    ]));
    ['200', '400', '401', '403', '404', '409', '500'].forEach((status) => expect(responses[status]).toBeDefined());
    ['ActionUndoRequest', 'ActionUndoRecordSummary', 'ActionUndoTarget', 'ActionUndoSuccessEnvelope', 'ActionUndoConflictEnvelope']
      .forEach((name) => expect(schemas[name]).toBeDefined());
  });
});
