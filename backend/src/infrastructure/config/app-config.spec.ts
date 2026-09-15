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
    expect(config.nimModel).toBe(EXPECTED_NIM_MODEL);
    expect(config.sessionSecret).toBe('a'.repeat(32));
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

  it('never accepts an absent database URL', () => {
    const environment = { ...validEnvironment };
    delete environment.DATABASE_URL;
    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });
});
