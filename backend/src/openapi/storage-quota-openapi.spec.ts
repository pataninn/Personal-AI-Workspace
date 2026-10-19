import openApiDocument from '../../openapi.json';

type JsonRecord = Record<string, unknown>;
type Method = 'post' | 'put' | 'patch' | 'delete';

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

const document = record(openApiDocument, 'OpenAPI document');
const components = record(document.components, 'components');
const schemas = record(components.schemas, 'schemas');
const responseComponents = record(components.responses, 'response components');
const paths = record(document.paths, 'paths');

function operation(path: string, method: 'get' | Method): JsonRecord {
  return record(record(paths[path], path)[method], `${method.toUpperCase()} ${path}`);
}

function operationResponse(path: string, method: 'get' | Method, status: string): JsonRecord {
  return record(record(operation(path, method).responses, `${method.toUpperCase()} ${path} responses`)[status], `${status} response`);
}

function componentResponse(name: string): JsonRecord {
  return record(responseComponents[name], `response component ${name}`);
}

function responseReference(path: string, method: Method, status: string, name: string): void {
  expect(operationResponse(path, method, status).$ref).toBe(`#/components/responses/${name}`);
}

const GROWING_WRITES: ReadonlyArray<readonly [Method, string]> = [
  ['post', '/api/v1/projects'],
  ['post', '/api/v1/projects/planning'],
  ['patch', '/api/v1/projects/{projectId}/objective'],
  ['post', '/api/v1/projects/{projectId}/tasks'],
  ['patch', '/api/v1/projects/{projectId}/tasks/{taskId}'],
  ['patch', '/api/v1/projects/{projectId}/task-suggestions/{suggestionId}'],
  ['post', '/api/v1/tasks'],
  ['patch', '/api/v1/tasks/{taskId}'],
  ['post', '/api/v1/tasks/{taskId}/move'],
  ['post', '/api/v1/projects/{projectId}/conversations'],
  ['post', '/api/v1/conversations/{conversationId}/messages'],
  ['post', '/api/v1/home/conversations'],
  ['post', '/api/v1/home/conversations/{conversationId}/turns'],
  ['post', '/api/v1/home/conversations/{conversationId}/turns/{turnId}/consent-decisions'],
  ['patch', '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}'],
  ['post', '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/acceptance'],
  ['post', '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/execution'],
  ['post', '/api/v1/actions/{actionId}/undo'],
  ['post', '/api/v1/projects/{projectId}/chat-runs'],
  ['post', '/api/v1/projects/{projectId}/ai-runs'],
  ['post', '/api/v1/ai-runs/{runId}/egress-decision'],
  ['post', '/api/v1/ai-runs/{runId}/proposed-change-set/decision'],
  ['post', '/api/v1/ai-runs/{runId}/commands/{commandId}/decision'],
  ['post', '/api/v1/ai-runs/{runId}/start'],
  ['post', '/api/v1/projects/{projectId}/facts'],
  ['patch', '/api/v1/projects/{projectId}/facts/{factId}'],
  ['put', '/api/v1/projects/{projectId}/files/content'],
  ['post', '/api/v1/projects/{projectId}/files/upload']
];

const ACCOUNTING_GATED_WRITES: ReadonlyArray<readonly [Method, string]> = [
  ...GROWING_WRITES,
  ['delete', '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/items/{itemId}'],
  ['post', '/api/v1/home/conversations/{conversationId}/turns/{turnId}/cancellation'],
  ['post', '/api/v1/home/conversations/{conversationId}/proposals/{proposalId}/cancellation'],
  ['delete', '/api/v1/projects/{projectId}/tasks/{taskId}'],
  ['post', '/api/v1/tasks/{taskId}/archive'],
  ['post', '/api/v1/ai-runs/{runId}/commands/{commandId}/cancel'],
  ['post', '/api/v1/ai-runs/{runId}/cancel'],
  ['delete', '/api/v1/projects/{projectId}/facts/{factId}'],
  ['post', '/api/v1/projects/{projectId}/facts/{factId}/verification'],
  ['delete', '/api/v1/projects/{projectId}/files/content'],
  ['delete', '/api/v1/projects/{projectId}'],
  ['patch', '/api/v1/projects/{projectId}/task-order']
];

describe('storage quota OpenAPI contract', () => {
  it('documents the authenticated account read without caller-selected ownership or request inputs', () => {
    const path = '/api/v1/account/storage';
    const get = operation(path, 'get');
    expect(get.security).toEqual([{ sessionCookie: [] }]);
    expect(get.parameters ?? []).toEqual([]);
    expect(get.requestBody).toBeUndefined();
    expect(operationResponse(path, 'get', '200').content).toBeDefined();
    expect(operationResponse(path, 'get', '401').$ref).toBe('#/components/responses/Unauthenticated');
    expect(operationResponse(path, 'get', '500').$ref).toBe('#/components/responses/InternalError');

    const content = record(operationResponse(path, 'get', '200').content, '200 content');
    const json = record(content['application/json'], '200 JSON content');
    expect(record(json.schema, '200 schema').$ref).toBe('#/components/schemas/AccountStorageUsageEnvelope');
    const examples = record(json.examples, '200 examples');
    expect(Object.keys(examples)).toEqual(expect.arrayContaining([
      'ready', 'unlimited', 'zeroLimit', 'overLimit', 'reconciling', 'unavailable'
    ]));
  });

  it('specifies exact byte strings, nullable states, and no client or host-path identifiers', () => {
    const usage = record(schemas.AccountStorageUsage, 'AccountStorageUsage');
    const properties = record(usage.properties, 'AccountStorageUsage properties');
    expect(usage.required).toEqual([
      'state', 'unit', 'unitSystem', 'usedBytes', 'reservedBytes', 'limitBytes',
      'availableBytes', 'overLimit', 'asOf'
    ]);
    expect(Object.keys(properties)).toEqual([
      'state', 'unit', 'unitSystem', 'usedBytes', 'reservedBytes', 'limitBytes',
      'availableBytes', 'overLimit', 'asOf'
    ]);
    expect(properties).not.toHaveProperty('ownerId');
    expect(properties).not.toHaveProperty('accountId');
    expect(properties).not.toHaveProperty('projectId');
    expect(properties).not.toHaveProperty('rootPath');
    expect(properties).not.toHaveProperty('path');
    expect(record(properties.state, 'state schema').enum).toEqual(['ready', 'reconciling', 'unavailable']);

    for (const name of ['usedBytes', 'reservedBytes', 'limitBytes', 'availableBytes']) {
      const property = record(properties[name], `${name} schema`);
      expect(property.type).toBe('string');
      expect(property.pattern).toBe('^(0|[1-9][0-9]*)$');
    }
    for (const name of ['usedBytes', 'reservedBytes', 'limitBytes', 'availableBytes', 'overLimit', 'asOf']) {
      expect(record(properties[name], `${name} schema`).nullable).toBe(true);
    }

    const envelope = record(schemas.AccountStorageUsageEnvelope, 'AccountStorageUsageEnvelope');
    expect(record(record(envelope.properties, 'envelope properties').data, 'data schema').type).toBe('object');
    expect(JSON.stringify(usage)).not.toMatch(/ownerId|accountId|projectId|rootPath|absolutePath/iu);
  });

  it('documents quota/accounting response codes, safe detail examples, and write coverage', () => {
    for (const [method, path] of GROWING_WRITES) {
      responseReference(path, method, '413', path.endsWith('/files/content') || path.endsWith('/files/upload') ? 'StorageWriteTooLarge' : 'StorageQuotaExceeded');
    }
    for (const [method, path] of ACCOUNTING_GATED_WRITES) {
      responseReference(path, method, '503', 'StorageWriteUnavailable');
    }
    for (const [path, method] of [
      ['/api/v1/projects/{projectId}/files/content', 'put'],
      ['/api/v1/projects/{projectId}/files/content', 'delete'],
      ['/api/v1/projects/{projectId}/files/upload', 'post'],
      ['/api/v1/projects/{projectId}', 'delete']
    ] as const) {
      responseReference(path, method, '409', 'StorageFileConflict');
    }

    const quotaExamples = record(record(record(componentResponse('StorageQuotaExceeded').content, 'quota content')['application/json'], 'quota JSON').examples, 'quota examples');
    const quotaEnvelope = record(record(quotaExamples.quotaExceeded, 'quota example').value, 'quota envelope');
    expect(record(quotaEnvelope.error, 'quota error')).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    const details = records(record(quotaEnvelope.error, 'quota error').details, 'quota details');
    expect(details.map((detail) => detail.field)).toEqual(['usedBytes', 'reservedBytes', 'limitBytes', 'requestedGrowthBytes']);
    details.forEach((detail) => expect(detail.message).toMatch(/^(0|[1-9][0-9]*)$/u));

    const unavailableResponse = componentResponse('StorageWriteUnavailable');
    expect(unavailableResponse.description).toMatch(/accounting-unready state may return 503/iu);
    expect(unavailableResponse.description).toMatch(/over limit alone does not block a zero or negative byte delta/iu);
    const unavailable = JSON.stringify(unavailableResponse);
    expect(unavailable).toContain('STORAGE_ACCOUNTING_UNAVAILABLE');
    expect(unavailable).toContain('STORAGE_RECONCILIATION_PENDING');
    expect(unavailable).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//u);
    const conflict = JSON.stringify(componentResponse('StorageFileConflict'));
    expect(conflict).toContain('STORAGE_OPERATION_CONFLICT');
    expect(conflict).toContain('STORAGE_FILE_STATE_CHANGED');
    expect(conflict).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//u);
  });
});
