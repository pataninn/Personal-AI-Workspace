import { ConfigurationError } from '@/shared/errors/app-error';
import { EXPECTED_NIM_MODEL, loadConfig } from '@/infrastructure/config/app-config';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  AGENT_RUNTIME_MODE: 'fake',
  APP_PROTOCOL: 'http',
  ALLOW_INSECURE_HTTP: 'true',
  WORKSPACE_HOST_ROOT: 'C:\\PersonalAIWorkspace',
  WORKSPACE_IDENTITY: 'fixture-identity',
  SESSION_SECRET: 'a'.repeat(32),
  APP_ORIGIN: 'http://127.0.0.1:8443',
  DATABASE_URL: 'postgresql://pai_app:password@localhost:5432/personal_ai',
};

describe('loadConfig', () => {
  it.each(['/srv/pai-data/legacy', '/a', 'C:\\PersonalAIWorkspace', 'C:/PersonalAIWorkspace'])('accepts an absolute host workspace path: %s', (workspaceHostRoot) => {
    expect(loadConfig({ ...validEnvironment, WORKSPACE_HOST_ROOT: workspaceHostRoot }).workspaceHostRoot).toBe(workspaceHostRoot);
  });

  it.each(['', '/', '/srv/..', '/srv/../etc', '/srv/./workspace', 'C:\\', 'C:/', 'C:\\workspace\\..', 'C:\\workspace\\..\\Windows', 'C:/workspace/./data', 'workspace', './workspace', '../workspace', 'C:workspace', '\\\\server\\share', '//server/share', '/srv\\workspace', '/srv/\u0000workspace'])('rejects a non-dedicated or invalid host workspace path: %s', (workspaceHostRoot) => {
    expect(() => loadConfig({ ...validEnvironment, WORKSPACE_HOST_ROOT: workspaceHostRoot })).toThrow(ConfigurationError);
  });

  it('requires explicit opt-in for estimated Home token accounting', () => {
    expect(loadConfig(validEnvironment).allowEstimatedHomeUsage).toBe(false);
    expect(loadConfig({ ...validEnvironment, NIM_ALLOW_ESTIMATED_HOME_USAGE: 'true' }).allowEstimatedHomeUsage).toBe(true);
    expect(() => loadConfig({ ...validEnvironment, NIM_ALLOW_ESTIMATED_HOME_USAGE: 'yes' })).toThrow(ConfigurationError);
  });

  it('returns a strict, normalized configuration', () => {
    const config = loadConfig(validEnvironment);

    expect(config.port).toBe(8443);
    expect(config.workspaceRoot).toBe('/workspace');
    expect(config.accountWorkspacesIdentity).toBeUndefined();
    expect(config.nimModel).toBe(EXPECTED_NIM_MODEL);
    expect(config.agentRuntimeMode).toBe('fake');
    expect(config.providerCreditConfiguration).toBeUndefined();
    expect(config.sessionSecret).toBe('a'.repeat(32));
    expect(config.demoSessionLifetimeMs).toBe(24 * 60 * 60 * 1_000);
    expect(config.demoAbuseLimits).toBeUndefined();
    expect(config.trustedProxyCidrs).toBeUndefined();
    expect(loadConfig({ ...validEnvironment, TRUSTED_PROXY_CIDRS: '' }).trustedProxyCidrs).toBeUndefined();
    expect(config.storageDiskWarningFreeBytes).toBeUndefined();
  });

  it('treats empty Compose provider-credit values as absent and rejects a partial profile', () => {
    const creditFields = [
      'NIM_CREDIT_PRICE_VERSION',
      'NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS',
      'NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS',
      'NIM_MAX_INPUT_TOKENS',
      'NIM_MAX_OUTPUT_TOKENS',
      'NIM_MAX_PROVIDER_CALLS_PER_RUN'
    ];
    const emptyProfile = Object.fromEntries(creditFields.map((field) => [field, '']));

    expect(loadConfig({ ...validEnvironment, ...emptyProfile }).providerCreditConfiguration).toBeUndefined();
    expect(() => loadConfig({
      ...validEnvironment,
      ...emptyProfile,
      NIM_CREDIT_PRICE_VERSION: 'price-v1'
    })).toThrow(ConfigurationError);
  });

  it('parses complete demo abuse settings and validated proxy CIDRs', () => {
    const config = loadConfig({
      ...validEnvironment,
      DEMO_GLOBAL_ADMISSION_MAX: '30',
      DEMO_GLOBAL_ADMISSION_WINDOW_SECONDS: '3600',
      DEMO_NETWORK_ADMISSION_MAX: '3',
      DEMO_NETWORK_ADMISSION_WINDOW_SECONDS: '900',
      DEMO_RUN_START_MAX: '4',
      DEMO_RUN_START_WINDOW_SECONDS: '3600',
      DEMO_NETWORK_HASH_SECRET: 'd'.repeat(32),
      DEMO_SESSION_TTL_HOURS: '12',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32'
    });

    expect(config.demoSessionLifetimeMs).toBe(12 * 60 * 60 * 1_000);
    expect(config.demoAbuseLimits).toEqual({
      globalAdmissionMax: 30,
      globalAdmissionWindowSeconds: 3600,
      networkAdmissionMax: 3,
      networkAdmissionWindowSeconds: 900,
      runStartMax: 4,
      runStartWindowSeconds: 3600
    });
    expect(config.demoNetworkHashSecret).toBe('d'.repeat(32));
    expect(config.trustedProxyCidrs).toEqual(['10.0.0.0/8', '2001:db8::/32']);
  });

  it('keeps new demo admission closed when abuse settings are partial or invalid', () => {
    const complete = {
      DEMO_GLOBAL_ADMISSION_MAX: '30',
      DEMO_GLOBAL_ADMISSION_WINDOW_SECONDS: '3600',
      DEMO_NETWORK_ADMISSION_MAX: '3',
      DEMO_NETWORK_ADMISSION_WINDOW_SECONDS: '900',
      DEMO_RUN_START_MAX: '4',
      DEMO_RUN_START_WINDOW_SECONDS: '3600',
      DEMO_NETWORK_HASH_SECRET: 'd'.repeat(32)
    };
    expect(loadConfig({ ...validEnvironment, ...complete, DEMO_NETWORK_HASH_SECRET: 'short' }).demoAbuseLimits).toBeUndefined();
    expect(loadConfig({ ...validEnvironment, DEMO_GLOBAL_ADMISSION_MAX: '0' }).demoAbuseLimits).toBeUndefined();
    const partial = { ...complete };
    delete (partial as Partial<typeof partial>).DEMO_RUN_START_MAX;
    expect(loadConfig({ ...validEnvironment, ...partial }).demoAbuseLimits).toBeUndefined();
    expect(loadConfig({ ...validEnvironment, ...complete, DEMO_NETWORK_ADMISSION_WINDOW_SECONDS: '7200' }).demoAbuseLimits).toBeUndefined();
  });

  it('rejects invalid trusted proxy entries and refuses to treat a host list as CIDRs', () => {
    for (const value of ['true', '1', 'proxy.internal', '10.0.0.0/33', '10.0.0.0/8,']) {
      expect(() => loadConfig({ ...validEnvironment, TRUSTED_PROXY_CIDRS: value })).toThrow(ConfigurationError);
    }
  });

  it('accepts only a positive decimal process-visible disk warning threshold', () => {
    expect(loadConfig({ ...validEnvironment, STORAGE_DISK_WARNING_FREE_BYTES: '' }).storageDiskWarningFreeBytes)
      .toBeUndefined();
    expect(loadConfig({ ...validEnvironment, STORAGE_DISK_WARNING_FREE_BYTES: '536870912' }).storageDiskWarningFreeBytes)
      .toBe(536_870_912n);
    for (const invalid of ['0', '-1', '1.5', ' 10', '01', 'x']) {
      expect(() => loadConfig({ ...validEnvironment, STORAGE_DISK_WARNING_FREE_BYTES: invalid })).toThrow(ConfigurationError);
    }
  });

  it('rejects retired direct and OpenShell modes instead of advertising a nonfunctional fallback', () => {
    for (const mode of ['direct', 'openshell']) {
      expect(() => loadConfig({ ...validEnvironment, AGENT_RUNTIME_MODE: mode })).toThrow(ConfigurationError);
    }
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

  it('requires the full Nemotron context reservation for configured Nebius Hermes Home inference', () => {
    const nebiusHermesEnvironment = {
      ...validEnvironment,
      NIM_PROFILE: 'nebius-token-factory',
      NIM_ENDPOINT: 'https://api.tokenfactory.nebius.com/v1',
      NIM_CREDIT_PRICE_VERSION: 'price-v1',
      NIM_INPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '300000',
      NIM_OUTPUT_CREDIT_UNITS_PER_MILLION_TOKENS: '900000',
      NIM_MAX_INPUT_TOKENS: '262143',
      NIM_MAX_OUTPUT_TOKENS: '512',
      NIM_MAX_PROVIDER_CALLS_PER_RUN: '1',
      AGENT_RUNTIME_MODE: 'hermes',
      HERMES_BRIDGE_ENDPOINT: 'https://host.docker.internal:17871',
      HERMES_BRIDGE_CA_FILE: '/run/hermes/ca.crt',
      HERMES_BRIDGE_CERT_FILE: '/run/hermes/client.crt',
      HERMES_BRIDGE_KEY_FILE: '/run/hermes/client.key'
    };

    expect(() => loadConfig(nebiusHermesEnvironment)).toThrow(ConfigurationError);
    expect(loadConfig({ ...nebiusHermesEnvironment, NIM_MAX_INPUT_TOKENS: '262144' }).providerCreditConfiguration?.maxInputTokens)
      .toBe(262_144);
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

  it('requires dedicated TLS credentials for the supported Hermes runtime', () => {
    expect(() => loadConfig({ ...validEnvironment, AGENT_RUNTIME_MODE: 'hermes' })).toThrow(ConfigurationError);
    const config = loadConfig({ ...validEnvironment, AGENT_RUNTIME_MODE: 'hermes',
      HERMES_BRIDGE_ENDPOINT: 'https://localhost:17871', HERMES_BRIDGE_CA_FILE: '/run/hermes/ca.crt',
      HERMES_BRIDGE_CERT_FILE: '/run/hermes/client.crt', HERMES_BRIDGE_KEY_FILE: '/run/hermes/client.key' });
    expect(config.agentRuntimeMode).toBe('hermes');
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

  it('normalizes the configured origin to match the browser Origin header', () => {
    expect(loadConfig({ ...validEnvironment, APP_ORIGIN: 'http://Example.COM:80/' }).appOrigin)
      .toBe('http://example.com');
  });

  it('rejects URLs that contain more than a browser origin', () => {
    for (const invalid of ['http://example.com/path', 'http://example.com/?query=1', 'http://example.com/#fragment', 'http://user:password@example.com', 'file:///', 'ftp://example.com/', 'not-a-url']) {
      expect(() => loadConfig({ ...validEnvironment, APP_ORIGIN: invalid })).toThrow(ConfigurationError);
    }
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
