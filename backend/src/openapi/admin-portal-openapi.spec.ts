import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function resolveRef(document: JsonRecord, reference: string): JsonRecord {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported reference ${reference}`);
  const resolved = reference.slice(2).split('/').reduce<unknown>((value, segment) => record(value, reference)[segment], document);
  return record(resolved, reference);
}

function operation(document: JsonRecord, path: string, method: string): JsonRecord {
  return record(record(record(document.paths, 'paths')[path], path)[method], `${method.toUpperCase()} ${path}`);
}

function response(document: JsonRecord, path: string, method: string, status: string): JsonRecord {
  return record(record(operation(document, path, method).responses, `${method} responses`)[status], `${status} response`);
}

describe('admin portal and account usage OpenAPI contract', () => {
  const document = JSON.parse(readFileSync(resolve(__dirname, '../../openapi.json'), 'utf8')) as JsonRecord;

  it('parses and declares the complete account usage and administration routes', () => {
    expect(document.openapi).toBe('3.0.3');
    const expected: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['/api/v1/account/usage', 'get', ['200', '401', '500', '503']],
      ['/api/v1/admin/accounts', 'get', ['200', '400', '401', '403', '500']],
      ['/api/v1/admin/accounts', 'post', ['201', '400', '401', '403', '409', '500']],
      ['/api/v1/admin/accounts/{accountId}/limits', 'patch', ['200', '400', '401', '403', '404', '409', '500', '503']],
      ['/api/v1/admin/accounts/{accountId}/status', 'patch', ['200', '400', '401', '403', '404', '409', '500']],
      ['/api/v1/admin/accounts/{accountId}/password-resets', 'post', ['200', '400', '401', '403', '404', '500']],
      ['/api/v1/admin/accounts/{accountId}/session-revocations', 'post', ['200', '400', '401', '403', '404', '500']],
      ['/api/v1/admin/demo-settings', 'get', ['200', '401', '403', '500', '503']],
      ['/api/v1/admin/demo-settings', 'put', ['200', '400', '401', '403', '409', '500', '503']],
      ['/api/v1/admin/audit', 'get', ['200', '400', '401', '403', '500']]
    ];

    for (const [path, method, statuses] of expected) {
      const op = operation(document, path, method);
      expect(op.operationId).toBeDefined();
      for (const status of statuses) expect(response(document, path, method, status)).toBeDefined();
    }
  });

  it('documents owner-derived usage and same-origin CSRF protected admin writes with resolvable DTO references', () => {
    const usage = operation(document, '/api/v1/account/usage', 'get');
    expect(usage.security).toEqual([{ sessionCookie: [] }]);
    expect(usage.requestBody).toBeUndefined();
    const usageContent = record(response(document, '/api/v1/account/usage', 'get', '200').content, 'usage content');
    const usageJson = record(usageContent['application/json'], 'usage JSON');
    const usageSchema = record(usageJson.schema, 'usage schema');
    expect(resolveRef(document, String(usageSchema.$ref)).type).toBe('object');

    const paths = [
      ['/api/v1/admin/accounts', 'post', 'AdminCreateAccountRequest'],
      ['/api/v1/admin/accounts/{accountId}/limits', 'patch', 'AdminAccountLimitsRequest'],
      ['/api/v1/admin/accounts/{accountId}/status', 'patch', 'AdminAccountStatusRequest'],
      ['/api/v1/admin/accounts/{accountId}/password-resets', 'post', 'AdminPasswordResetRequest'],
      ['/api/v1/admin/accounts/{accountId}/session-revocations', 'post', 'AdminEmptyRequest'],
      ['/api/v1/admin/demo-settings', 'put', 'AdminDemoSettingsUpdateRequest']
    ] as const;

    for (const [path, method, requestSchema] of paths) {
      const op = operation(document, path, method);
      expect(op.security).toEqual([{ sessionCookie: [] }]);
      expect(op.parameters).toEqual(expect.arrayContaining([
        { $ref: '#/components/parameters/OriginHeader' },
        { $ref: '#/components/parameters/CsrfHeader' }
      ]));
      expect(record(record(record(op.requestBody, 'request body').content, 'request content')['application/json'], 'request JSON').schema).toEqual({ $ref: `#/components/schemas/${requestSchema}` });
      expect(resolveRef(document, `#/components/schemas/${requestSchema}`).type).toBe('object');
    }

    for (const [path, method, status, schema] of [
      ['/api/v1/admin/accounts', 'get', '200', 'AdminAccountsEnvelope'],
      ['/api/v1/admin/accounts', 'post', '201', 'AdminAccountCreatedEnvelope'],
      ['/api/v1/admin/accounts/{accountId}/limits', 'patch', '200', 'AdminAccountLimitsEnvelope'],
      ['/api/v1/admin/accounts/{accountId}/status', 'patch', '200', 'AdminAccountStatusEnvelope'],
      ['/api/v1/admin/accounts/{accountId}/password-resets', 'post', '200', 'AdminPasswordResetEnvelope'],
      ['/api/v1/admin/accounts/{accountId}/session-revocations', 'post', '200', 'AdminSessionRevocationEnvelope'],
      ['/api/v1/admin/demo-settings', 'get', '200', 'AdminDemoSettingsEnvelope'],
      ['/api/v1/admin/demo-settings', 'put', '200', 'AdminDemoSettingsEnvelope'],
      ['/api/v1/admin/audit', 'get', '200', 'AdminAuditEnvelope']
    ] as const) {
      const content = record(response(document, path, method, status).content, `${status} content`);
      const json = record(content['application/json'], `${status} JSON`);
      expect(record(json.schema, `${status} schema`).$ref).toBe(`#/components/schemas/${schema}`);
      expect(resolveRef(document, `#/components/schemas/${schema}`).type).toBe('object');
    }
  });

  it('records CAS, null-unlimited and zero-limit semantics, and immutable configured campaign IDs', () => {
    const schemas = record(record(document.components, 'components').schemas, 'schemas');
    const limits = record(schemas.AdminAccountLimitsRequest, 'limits request');
    const limitsProperties = record(limits.properties, 'limits properties');
    expect(limits.required).toEqual(['expectedRevision', 'dailyCreditLimitUnits', 'lifetimeCreditLimitUnits', 'storageLimitBytes']);
    expect(record(limitsProperties.expectedRevision, 'expectedRevision').minimum).toBe(1);
    for (const field of ['dailyCreditLimitUnits', 'lifetimeCreditLimitUnits', 'storageLimitBytes']) {
      const property = record(limitsProperties[field], field);
      expect(property.nullable).toBe(true);
      expect(property.pattern).toBe('^(0|[1-9][0-9]*)$');
    }

    const demo = record(schemas.AdminDemoSettingsUpdateRequest, 'demo settings update request');
    const demoProperties = record(demo.properties, 'demo settings properties');
    expect(demo.required).toEqual(expect.arrayContaining(['expectedRevision', 'campaignId', 'campaignLimitUnits']));
    expect(record(demoProperties.campaignId, 'campaignId').description).toMatch(/initialize from null.*HTTP 409 DEMO_CAMPAIGN_ID_IMMUTABLE/iu);
    expect(String(demo.description)).toMatch(/Null limits are unlimited.*string "0" is a zero limit.*compare-and-swap/iu);
    expect(String(operation(document, '/api/v1/admin/demo-settings', 'put').description)).toMatch(/preserves its settled and reserved counters and usage ledger/iu);
    expect(String(operation(document, '/api/v1/admin/demo-settings', 'put').description)).toMatch(/emergency pause for all accounts/iu);

    const schemasRecord = record(record(document.components, 'components').schemas, 'schemas');
    const apiError = record(schemasRecord.ApiError, 'ApiError');
    expect(record(apiError.properties, 'ApiError properties').code).toEqual({ type: 'string' });
    const conflict = response(document, '/api/v1/admin/demo-settings', 'put', '409');
    expect(String(conflict.description)).toContain('DEMO_CAMPAIGN_ID_IMMUTABLE');
    expect(record(record(record(conflict.content, '409 content')['application/json'], '409 JSON').schema, '409 schema').$ref).toBe('#/components/schemas/ErrorEnvelope');
  });
});
