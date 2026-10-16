import { z } from 'zod';
import { NEBIUS_PROVIDER_PROFILE, NVIDIA_PROVIDER_PROFILE } from '@/modules/ai-runs/domain/model-provider-profile';

import {
  ConfigurationError,
  type ErrorDetail
} from '@/shared/errors/app-error';

import {
  loadDatabaseConfig,
  type DatabaseConfig
} from '@/infrastructure/config/database-config';

const EXPECTED_NIM_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

const booleanEnvironment = z
  .enum(['true', 'false'])
  .transform((value: 'true' | 'false') => value === 'true');

const appEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z
    .string()
    .default('8443')
    .transform((value: string) => Number(value))
    .refine((value: number) => Number.isInteger(value) && value > 0 && value < 65_536, 'PORT must be a valid TCP port'),
  APP_PROTOCOL: z.enum(['http', 'https']).default('https'),
  ALLOW_INSECURE_HTTP: booleanEnvironment.default('false'),
  TLS_CERT_FILE: z.string().min(1).optional(),
  TLS_KEY_FILE: z.string().min(1).optional(),
  STATIC_DIR: z.string().min(1).default('/app/frontend/dist'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ORIGIN: z.string().url().default('https://127.0.0.1:8443'),
  WORKSPACE_HOST_ROOT: z
    .string()
    .min(3)
    .refine((value: string) => /^[A-Za-z]:\\/.test(value), 'WORKSPACE_HOST_ROOT must be a dedicated Windows path'),
  WORKSPACE_ROOT: z.string().default('/workspace'),
  WORKSPACE_IDENTITY_FILE: z.string().default('/workspace/.personal-ai-workspace-identity'),
  WORKSPACE_IDENTITY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z
    .string()
    .default('12')
    .transform((value: string) => Number(value))
    .refine((value: number) => Number.isInteger(value) && value >= 1 && value <= 168, 'SESSION_TTL_HOURS must be 1..168'),
  LOCAL_USER_PASSWORD: z.string().min(1).max(1024).optional(),
  LOCAL_USER_PASSWORD_FILE: z.string().min(1).optional(),
  LOCAL_USER_DISPLAY_NAME: z.string().min(1).max(120).default('Local user'),
  OPENSHELL_BASE_URL: z.string().url().optional(),
  OPENSHELL_CLIENT_ID: z.string().min(1).optional(),
  OPENSHELL_CLIENT_TOKEN: z.string().min(16).optional(),
  OPENSHELL_NETWORK: z.string().min(1).optional(),
  OPENSHELL_HEALTH_PATH: z.string().startsWith('/').default('/health'),
  OPENSHELL_NIM_READINESS_PATH: z.string().startsWith('/').default('/v1/provider/readiness'),
  OPEN_SHELL_BRIDGE_ENDPOINT: z.string().url().optional(),
  OPEN_SHELL_BRIDGE_CA_FILE: z.string().min(1).optional(),
  OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE: z.string().min(1).optional(),
  OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE: z.string().min(1).optional(),
  OPEN_SHELL_BRIDGE_PROFILE_DIGEST: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(),
  NIM_PROFILE: z.enum([NVIDIA_PROVIDER_PROFILE, NEBIUS_PROVIDER_PROFILE]).default(NVIDIA_PROVIDER_PROFILE),
  NIM_ENDPOINT: z.string().url().default('https://integrate.api.nvidia.com/v1'),
  NIM_MODEL: z.string().default(EXPECTED_NIM_MODEL),
  HOME_PLANNING_TIME_ZONE: z.string().min(1).optional(),
  AGENT_RUNTIME_MODE: z.enum(['fake', 'direct', 'openshell', 'hermes']).default('direct'),
  HERMES_BRIDGE_ENDPOINT: z.string().url().optional(),
  HERMES_BRIDGE_CA_FILE: z.string().optional(),
  HERMES_BRIDGE_CERT_FILE: z.string().optional(),
  HERMES_BRIDGE_KEY_FILE: z.string().optional(),
  STAGING_ROOT: z.string().min(1).default('/var/lib/personal-ai/staging'),
  RECOVERY_ROOT: z.string().min(1).default('/var/lib/personal-ai/recovery'),
  STARTUP_CHECK_TIMEOUT_MS: z
    .string()
    .default('3000')
    .transform((value: string) => Number(value))
    .refine((value: number) => Number.isInteger(value) && value > 0 && value <= 30_000, 'STARTUP_CHECK_TIMEOUT_MS must be 1..30000')
});

export interface AppConfig {
  readonly nodeEnvironment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly protocol: 'http' | 'https';
  readonly allowInsecureHttp: boolean;
  readonly tlsCertFile?: string;
  readonly tlsKeyFile?: string;
  readonly staticDirectory: string;
  readonly appVersion: string;
  readonly logLevel: string;
  readonly appOrigin: string;
  readonly workspaceHostRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceIdentityFile: string;
  readonly workspaceIdentity: string;
  readonly sessionSecret: string;
  readonly sessionLifetimeMs: number;
  readonly localUserPassword?: string;
  readonly localUserPasswordFile?: string;
  readonly localUserDisplayName: string;
  readonly openshellBaseUrl?: string;
  readonly openshellClientId?: string;
  readonly openshellClientToken?: string;
  readonly openshellNetwork?: string;
  readonly openshellHealthPath: string;
  readonly openshellNimReadinessPath: string;
  readonly openshellBridgeEndpoint?: string;
  readonly openshellBridgeCaFile?: string;
  readonly openshellBridgeClientCertFile?: string;
  readonly openshellBridgeClientKeyFile?: string;
  readonly openshellBridgeProfileDigest?: string;
  readonly nimProfile: string;
  readonly nimEndpoint: string;
  readonly nimModel: string;
  readonly homePlanningTimeZone?: string;
  readonly agentRuntimeMode: 'fake' | 'direct' | 'openshell' | 'hermes';
  readonly hermesBridgeEndpoint?: string;
  readonly hermesBridgeCaFile?: string;
  readonly hermesBridgeCertFile?: string;
  readonly hermesBridgeKeyFile?: string;
  readonly stagingRoot: string;
  readonly recoveryRoot: string;
  readonly startupCheckTimeoutMs: number;
  readonly database: DatabaseConfig;
}

function configurationDetails(error: z.ZodError): readonly ErrorDetail[] {
  return error.issues.map((issue: z.ZodIssue) => ({
    field: issue.path.join('.') || 'environment',
    message: issue.message
  }));
}

function validateCrossFieldConfiguration(value: z.infer<typeof appEnvironmentSchema>): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];
  const appOrigin = new URL(value.APP_ORIGIN);
  if (value.HOME_PLANNING_TIME_ZONE) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.HOME_PLANNING_TIME_ZONE });
    } catch {
      details.push({ field: 'HOME_PLANNING_TIME_ZONE', message: 'Use a valid IANA timezone identifier.' });
    }
  }
  if (value.WORKSPACE_ROOT !== '/workspace') {
    details.push({ field: 'WORKSPACE_ROOT', message: 'WORKSPACE_ROOT must be exactly /workspace' });
  }
  if (!value.WORKSPACE_IDENTITY_FILE.startsWith(`${value.WORKSPACE_ROOT}/`)) {
    details.push({ field: 'WORKSPACE_IDENTITY_FILE', message: 'Identity marker must be inside WORKSPACE_ROOT' });
  }
  if (isSameOrNestedPath(value.STAGING_ROOT, value.WORKSPACE_ROOT)) {
    details.push({ field: 'STAGING_ROOT', message: 'STAGING_ROOT must not overlap the authoritative workspace.' });
  }
  if (isSameOrNestedPath(value.STAGING_ROOT, value.RECOVERY_ROOT) || isSameOrNestedPath(value.RECOVERY_ROOT, value.STAGING_ROOT) || isSameOrNestedPath(value.STAGING_ROOT, '/var/log/personal-ai')) {
    details.push({ field: 'STAGING_ROOT', message: 'STAGING_ROOT must remain separate from recovery and log areas.' });
  }
  if (isSameOrNestedPath(value.RECOVERY_ROOT, value.WORKSPACE_ROOT) || isSameOrNestedPath(value.RECOVERY_ROOT, '/var/log/personal-ai')) {
    details.push({ field: 'RECOVERY_ROOT', message: 'RECOVERY_ROOT must remain separate from the authoritative workspace and log area.' });
  }
  if (value.APP_PROTOCOL === 'https' && (!value.TLS_CERT_FILE || !value.TLS_KEY_FILE)) {
    details.push({ field: 'TLS_CERT_FILE', message: 'HTTPS requires TLS_CERT_FILE and TLS_KEY_FILE' });
  }
  if (value.APP_PROTOCOL === 'http' && !value.ALLOW_INSECURE_HTTP) {
    details.push({ field: 'ALLOW_INSECURE_HTTP', message: 'HTTP requires explicit ALLOW_INSECURE_HTTP=true' });
  }
  if (appOrigin.protocol !== `${value.APP_PROTOCOL}:`) {
    details.push({ field: 'APP_ORIGIN', message: 'APP_ORIGIN protocol must match APP_PROTOCOL' });
  }
  if (value.NODE_ENV === 'production' && value.APP_PROTOCOL !== 'https') {
    details.push({ field: 'APP_PROTOCOL', message: 'Production deployments must use HTTPS' });
  }
  if (value.NODE_ENV === 'production' && value.ALLOW_INSECURE_HTTP) {
    details.push({ field: 'ALLOW_INSECURE_HTTP', message: 'ALLOW_INSECURE_HTTP must be false in production' });
  }
  if (value.NIM_MODEL !== EXPECTED_NIM_MODEL) {
    details.push({ field: 'NIM_MODEL', message: `NIM_MODEL must be ${EXPECTED_NIM_MODEL}` });
  }
  if (value.NIM_PROFILE === NEBIUS_PROVIDER_PROFILE && (value.AGENT_RUNTIME_MODE !== 'hermes' || value.NIM_ENDPOINT !== 'https://api.tokenfactory.nebius.com/v1')) {
    details.push({ field: 'NIM_PROFILE', message: 'Nebius Token Factory requires Hermes mode and https://api.tokenfactory.nebius.com/v1.' });
  }
  if (value.AGENT_RUNTIME_MODE === 'openshell') {
    validateOpenShellConfiguration(value, details);
  }
  validateBridgeConfiguration(value, details);
  if (value.AGENT_RUNTIME_MODE === 'hermes' && (!value.HERMES_BRIDGE_ENDPOINT || new URL(value.HERMES_BRIDGE_ENDPOINT).protocol !== 'https:' || !value.HERMES_BRIDGE_CA_FILE || !value.HERMES_BRIDGE_CERT_FILE || !value.HERMES_BRIDGE_KEY_FILE)) {
    details.push({ field: 'HERMES_BRIDGE_ENDPOINT', message: 'Hermes mode requires an HTTPS bridge and dedicated mTLS files.' });
  }
  if (value.NODE_ENV === 'production' && value.AGENT_RUNTIME_MODE === 'fake') {
    details.push({ field: 'AGENT_RUNTIME_MODE', message: 'Production deployments must use the direct provider or a verified deferred runtime.' });
  }
  return details;
}

function validateOpenShellConfiguration(
  value: z.infer<typeof appEnvironmentSchema>,
  details: ErrorDetail[]
): void {
  const requiredFields: readonly [keyof typeof value, string][] = [
    ['OPENSHELL_BASE_URL', 'OPENSHELL_BASE_URL'],
    ['OPENSHELL_CLIENT_ID', 'OPENSHELL_CLIENT_ID'],
    ['OPENSHELL_CLIENT_TOKEN', 'OPENSHELL_CLIENT_TOKEN'],
    ['OPENSHELL_NETWORK', 'OPENSHELL_NETWORK']
  ];
  for (const [field, label] of requiredFields) {
    if (!value[field]) {
      details.push({ field: label, message: `${label} is required when AGENT_RUNTIME_MODE=openshell` });
    }
  }
}

function validateBridgeConfiguration(
  value: z.infer<typeof appEnvironmentSchema>,
  details: ErrorDetail[]
): void {
  const bridgeValues = [
    value.OPEN_SHELL_BRIDGE_ENDPOINT,
    value.OPEN_SHELL_BRIDGE_CA_FILE,
    value.OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE,
    value.OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE,
    value.OPEN_SHELL_BRIDGE_PROFILE_DIGEST
  ];
  const configuredCount = bridgeValues.filter((item) => item !== undefined).length;
  if (configuredCount > 0 && configuredCount < bridgeValues.length) {
    details.push({ field: 'OPEN_SHELL_BRIDGE_ENDPOINT', message: 'Bridge endpoint, mTLS files, and profile digest must be configured together.' });
  }
  if (value.OPEN_SHELL_BRIDGE_ENDPOINT && new URL(value.OPEN_SHELL_BRIDGE_ENDPOINT).protocol !== 'https:') {
    details.push({ field: 'OPEN_SHELL_BRIDGE_ENDPOINT', message: 'The private bridge endpoint must use HTTPS.' });
  }
}

function isSameOrNestedPath(candidate: string, parent: string): boolean {
  const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/\/+$/u, '') || '/';
  const normalizedParent = parent.replaceAll('\\', '/').replace(/\/+$/u, '') || '/';
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = appEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError('Application configuration is invalid.', configurationDetails(parsed.error));
  }

  const crossFieldDetails = validateCrossFieldConfiguration(parsed.data);
  if (crossFieldDetails.length > 0) {
    throw new ConfigurationError('Application configuration is invalid.', crossFieldDetails);
  }

  const database = loadDatabaseConfig(environment);
  return {
    nodeEnvironment: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    protocol: parsed.data.APP_PROTOCOL,
    allowInsecureHttp: parsed.data.ALLOW_INSECURE_HTTP,
    ...(parsed.data.TLS_CERT_FILE ? { tlsCertFile: parsed.data.TLS_CERT_FILE } : {}),
    ...(parsed.data.TLS_KEY_FILE ? { tlsKeyFile: parsed.data.TLS_KEY_FILE } : {}),
    staticDirectory: parsed.data.STATIC_DIR,
    appVersion: parsed.data.APP_VERSION,
    logLevel: parsed.data.LOG_LEVEL,
    appOrigin: parsed.data.APP_ORIGIN,
    workspaceHostRoot: parsed.data.WORKSPACE_HOST_ROOT,
    workspaceRoot: parsed.data.WORKSPACE_ROOT,
    workspaceIdentityFile: parsed.data.WORKSPACE_IDENTITY_FILE,
    workspaceIdentity: parsed.data.WORKSPACE_IDENTITY,
    sessionSecret: parsed.data.SESSION_SECRET,
    sessionLifetimeMs: parsed.data.SESSION_TTL_HOURS * 60 * 60 * 1_000,
    ...(parsed.data.LOCAL_USER_PASSWORD ? { localUserPassword: parsed.data.LOCAL_USER_PASSWORD } : {}),
    ...(parsed.data.LOCAL_USER_PASSWORD_FILE ? { localUserPasswordFile: parsed.data.LOCAL_USER_PASSWORD_FILE } : {}),
    localUserDisplayName: parsed.data.LOCAL_USER_DISPLAY_NAME,
    ...(parsed.data.OPENSHELL_BASE_URL ? { openshellBaseUrl: parsed.data.OPENSHELL_BASE_URL } : {}),
    ...(parsed.data.OPENSHELL_CLIENT_ID ? { openshellClientId: parsed.data.OPENSHELL_CLIENT_ID } : {}),
    ...(parsed.data.OPENSHELL_CLIENT_TOKEN ? { openshellClientToken: parsed.data.OPENSHELL_CLIENT_TOKEN } : {}),
    ...(parsed.data.OPENSHELL_NETWORK ? { openshellNetwork: parsed.data.OPENSHELL_NETWORK } : {}),
    openshellHealthPath: parsed.data.OPENSHELL_HEALTH_PATH,
    openshellNimReadinessPath: parsed.data.OPENSHELL_NIM_READINESS_PATH,
    ...(parsed.data.OPEN_SHELL_BRIDGE_ENDPOINT ? { openshellBridgeEndpoint: parsed.data.OPEN_SHELL_BRIDGE_ENDPOINT } : {}),
    ...(parsed.data.OPEN_SHELL_BRIDGE_CA_FILE ? { openshellBridgeCaFile: parsed.data.OPEN_SHELL_BRIDGE_CA_FILE } : {}),
    ...(parsed.data.OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE ? { openshellBridgeClientCertFile: parsed.data.OPEN_SHELL_BRIDGE_CLIENT_CERT_FILE } : {}),
    ...(parsed.data.OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE ? { openshellBridgeClientKeyFile: parsed.data.OPEN_SHELL_BRIDGE_CLIENT_KEY_FILE } : {}),
    ...(parsed.data.OPEN_SHELL_BRIDGE_PROFILE_DIGEST ? { openshellBridgeProfileDigest: parsed.data.OPEN_SHELL_BRIDGE_PROFILE_DIGEST } : {}),
    nimProfile: parsed.data.NIM_PROFILE,
    nimEndpoint: parsed.data.NIM_ENDPOINT,
    nimModel: parsed.data.NIM_MODEL,
    ...(parsed.data.HOME_PLANNING_TIME_ZONE ? { homePlanningTimeZone: parsed.data.HOME_PLANNING_TIME_ZONE } : {}),
    agentRuntimeMode: parsed.data.AGENT_RUNTIME_MODE,
    ...(parsed.data.HERMES_BRIDGE_ENDPOINT ? { hermesBridgeEndpoint: parsed.data.HERMES_BRIDGE_ENDPOINT } : {}),
    ...(parsed.data.HERMES_BRIDGE_CA_FILE ? { hermesBridgeCaFile: parsed.data.HERMES_BRIDGE_CA_FILE } : {}),
    ...(parsed.data.HERMES_BRIDGE_CERT_FILE ? { hermesBridgeCertFile: parsed.data.HERMES_BRIDGE_CERT_FILE } : {}),
    ...(parsed.data.HERMES_BRIDGE_KEY_FILE ? { hermesBridgeKeyFile: parsed.data.HERMES_BRIDGE_KEY_FILE } : {}),
    stagingRoot: parsed.data.STAGING_ROOT,
    recoveryRoot: parsed.data.RECOVERY_ROOT,
    startupCheckTimeoutMs: parsed.data.STARTUP_CHECK_TIMEOUT_MS,
    database
  };
}

export { EXPECTED_NIM_MODEL };
