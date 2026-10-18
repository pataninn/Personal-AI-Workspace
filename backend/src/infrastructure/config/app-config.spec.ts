import { ConfigurationError } from '@/shared/errors/app-error';
import { EXPECTED_NIM_MODEL, loadConfig } from '@/infrastructure/config/app-config';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  APP_PROTOCOL: 'http',
  ALLOW_INSECURE_HTTP: 'true',
  WORKSPACE_HOST_ROOT: 'C:\\PersonalAIWorkspace',
  WORKSPACE_IDENTITY: 'fixture-identity',
  SESSION_SECRET: 'a'.repeat(32),
  APP_ORIGIN: 'http://127.0.0.1:8443',
  DATABASE_URL: 'postgresql://pai_app:password@localhost:5432/personal_ai',
  OPENSHELL_BASE_URL: 'http://openshell-gateway:8080',
  OPENSHELL_CLIENT_ID: 'test-client',
  OPENSHELL_CLIENT_TOKEN: 'a'.repeat(16),
  OPENSHELL_NETWORK: 'sandbox-control'
};

describe('loadConfig', () => {
  it('returns a strict, normalized configuration', () => {
    const config = loadConfig(validEnvironment);

    expect(config.port).toBe(8443);
    expect(config.workspaceRoot).toBe('/workspace');
    expect(config.accountWorkspacesIdentity).toBeUndefined();
    expect(config.nimModel).toBe(EXPECTED_NIM_MODEL);
    expect(config.agentRuntimeMode).toBe('direct');
    expect(config.sessionSecret).toBe('a'.repeat(32));
  });

  it('accepts direct mode without deferred OpenShell settings', () => {
    const environment: NodeJS.ProcessEnv = { ...validEnvironment };
    delete environment.OPENSHELL_BASE_URL;
    delete environment.OPENSHELL_CLIENT_ID;
    delete environment.OPENSHELL_CLIENT_TOKEN;
    delete environment.OPENSHELL_NETWORK;
    environment.AGENT_RUNTIME_MODE = 'direct';

    const config = loadConfig(environment);

    expect(config.agentRuntimeMode).toBe('direct');
    expect(config.openshellBaseUrl).toBeUndefined();
  });

  it('parses only a complete operator-supplied provider credit profile using integer rates', () => {
    const config = loadConfig({
      ...validEnvironment,
      NIM_CREDIT_PRICE_VERSION: 'nim-price-2026-10',
      NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '1250000',
      NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '2500000',
      NIM_MAX_INPUT_TOKENS: '4096',
      NIM_MAX_OUTPUT_TOKENS: '8192',
      NIM_MAX_PROVIDER_CALLS_PER_RUN: '4'
    });

    expect(config.providerCreditConfiguration).toEqual({
      price: { version: 'nim-price-2026-10', inputUnitsPerMillionTokens: 1_250_000n, outputUnitsPerMillionTokens: 2_500_000n },
      maxInputTokens: 4096,
      maxOutputTokens: 8192,
      maxAttemptsForSource: 4
    });
  });

  it('rejects partial or out-of-range provider credit profiles', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NIM_CREDIT_PRICE_VERSION: 'price-v1'
    })).toThrow(ConfigurationError);
    expect(() => loadConfig({
      ...validEnvironment,
      NIM_CREDIT_PRICE_VERSION: 'price-v1',
      NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '1',
      NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '1',
      NIM_MAX_INPUT_TOKENS: '4096',
      NIM_MAX_OUTPUT_TOKENS: '16385',
      NIM_MAX_PROVIDER_CALLS_PER_RUN: '1'
    })).toThrow(ConfigurationError);
  });

  it('maps the server-side local-user password file without reading its value into config', () => {
    const config = loadConfig({ ...validEnvironment, LOCAL_USER_PASSWORD_FILE: '/run/secrets/local_user_password' });

    expect(config.localUserPassword).toBeUndefined();
    expect(config.localUserPasswordFile).toBe('/run/secrets/local_user_password');
  });

  it('enables managed file storage only when its fixed-mount identity is configured', () => {
    expect(loadConfig({ ...validEnvironment, ACCOUNT_WORKSPACES_IDENTITY: ' managed-fixture ' }).accountWorkspacesIdentity)
      .toBe('managed-fixture');
  });

  it('requires deferred OpenShell settings only when that mode is selected', () => {
    const environment: NodeJS.ProcessEnv = { ...validEnvironment, AGENT_RUNTIME_MODE: 'openshell' };
    delete environment.OPENSHELL_BASE_URL;

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });

  it('accepts a complete HTTPS bridge configuration without exposing its key value', () => {
    const config = loadConfig({
      ...validEnvironment,
      OPEN_SHELL_BRIDGE_ENDPOINT: 'https://host.docker.internal:17871',
      OPEN_SHELL_BRIDGE_CA_FILE: '/run/secrets/bridge-ca',
      OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE: '/run/secrets/bridge-client-cert',
      OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE: '/run/secrets/bridge-client-key',
      OPEN_SHELL_BRIDGE_PROFILE_DIGEST: `sha256:${'b'.repeat(64)}`
    });

    expect(config.openshellBridgeEndpoint).toBe('https://host.docker.internal:17871');
    expect(config.openshellBridgeClientKeyFile).toBe('/run/secrets/bridge-client-key');
  });

  it('rejects partial or plaintext bridge configuration', () => {
    expect(() => loadConfig({ ...validEnvironment, OPEN_SHELL_BRIDGE_ENDPOINT: 'http://host.docker.internal:17871' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnvironment, OPEN_SHELL_BRIDGE_ENDPOINT: 'https://host.docker.internal:17871', OPEN_SHELL_BRIDGE_PROFILE_DIGEST: `sha256:${'b'.repeat(64)}` })).toThrow(ConfigurationError);
  });

  it('rejects an authority mount identity outside /workspace', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      WORKSPACE_IDENTITY_FILE: '/tmp/identity'
    })).toThrow(ConfigurationError);
  });

  it('requires an explicit opt-in for insecure HTTP', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      ALLOW_INSECURE_HTTP: 'false'
    })).toThrow(ConfigurationError);
  });

  it('requires certificates for HTTPS', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      APP_PROTOCOL: 'https',
      ALLOW_INSECURE_HTTP: 'false'
    })).toThrow(ConfigurationError);
  });

  it('rejects insecure HTTP and cookies in production', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production'
    })).toThrow(ConfigurationError);
  });

  it('requires the configured origin protocol to match the app protocol', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      APP_PROTOCOL: 'https',
      APP_ORIGIN: 'http://127.0.0.1:8443',
      TLS_CERT_FILE: '/run/tls/tls.crt',
      TLS_KEY_FILE: '/run/tls/tls.key',
      ALLOW_INSECURE_HTTP: 'false'
    })).toThrow(ConfigurationError);
  });

  it('rejects a model outside the pinned Nemotron profile', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NIM_MODEL: 'other-model'
    })).toThrow(ConfigurationError);
  });

  it('rejects the fake runtime in production', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_PROTOCOL: 'https',
      APP_ORIGIN: 'https://127.0.0.1:8443',
      TLS_CERT_FILE: '/tmp/tls.crt',
      TLS_KEY_FILE: '/tmp/tls.key',
      AGENT_RUNTIME_MODE: 'fake'
    })).toThrow(ConfigurationError);
  });

  it('rejects staging roots that overlap authoritative or recovery areas', () => {
    expect(() => loadConfig({ ...validEnvironment, STAGING_ROOT: '/workspace/runs' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...validEnvironment, STAGING_ROOT: '/var/lib/personal-ai/recovery' })).toThrow(ConfigurationError);
  });

  it('never accepts an absent database URL', () => {
    const environment = { ...validEnvironment };
    delete environment.DATABASE_URL;
    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });
});
