import openApiDocument from '../../openapi.json';

interface OperationRecord {
  readonly operationId?: string;
  readonly requestBody?: unknown;
  readonly security?: unknown;
  readonly parameters?: unknown;
  readonly responses?: Record<string, unknown>;
}

interface AuthOpenApiDocument {
  readonly paths: Record<string, { readonly get?: OperationRecord; readonly post?: OperationRecord }>;
  readonly components: {
    readonly schemas: Record<string, unknown>;
  };
}

describe('authentication OpenAPI document', () => {
  const document = openApiDocument as unknown as AuthOpenApiDocument;

  it('documents identifier-based login and regular/demo principal fields', () => {
    const login = document.paths['/api/v1/auth/login']?.post;
    expect(login?.operationId).toBe('login');
    expect(login?.requestBody).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } }
    });
    expect(login?.responses).toEqual(expect.objectContaining({
      '200': expect.any(Object),
      '400': expect.any(Object),
      '401': expect.any(Object),
      '403': expect.any(Object),
      '429': expect.any(Object),
      '503': expect.any(Object)
    }));
    expect(document.components.schemas.LoginRequest).toMatchObject({
      required: ['identifier', 'password'],
      additionalProperties: false
    });
    const loginRequest = document.components.schemas.LoginRequest as {
      readonly properties: Record<string, { readonly pattern?: string; readonly minLength?: number; readonly maxLength?: number; readonly description?: string }>;
    };
    const identifierSchema = loginRequest.properties.identifier;
    if (!identifierSchema) throw new Error('The OpenAPI login identifier schema is missing.');
    expect(identifierSchema.pattern).toBe(String.raw`^\s*[A-Za-z0-9][A-Za-z0-9._-]{2,63}\s*$`);
    expect(new RegExp(identifierSchema.pattern ?? '').test('  OWNER  ')).toBe(true);
    expect(identifierSchema.maxLength).toBeUndefined();
    expect(identifierSchema.description).toContain('ASCII letters are lowercased');
    const passwordSchema = loginRequest.properties.password;
    if (!passwordSchema) throw new Error('The OpenAPI login password schema is missing.');
    expect(passwordSchema.minLength).toBe(1);
    expect(passwordSchema.maxLength).toBe(1024);
    expect(passwordSchema.description).toContain('at least one non-whitespace character');
    expect(document.components.schemas.AccountPrincipal).toMatchObject({
      required: ['id', 'displayName', 'accountKind', 'role']
    });
  });

  it('documents secure session restoration and Origin/CSRF protected logout', () => {
    const session = document.paths['/api/v1/auth/session']?.get;
    const logout = document.paths['/api/v1/auth/logout']?.post;
    expect(session?.operationId).toBe('getCurrentSession');
    expect(session?.security).toEqual([{ sessionCookie: [] }]);
    expect(logout?.operationId).toBe('logout');
    expect(logout?.security).toEqual([{ sessionCookie: [] }]);
    expect(logout?.parameters).toEqual([
      { $ref: '#/components/parameters/OriginHeader' },
      { $ref: '#/components/parameters/CsrfHeader' }
    ]);
    expect(logout?.responses).toHaveProperty('204');
  });
});
