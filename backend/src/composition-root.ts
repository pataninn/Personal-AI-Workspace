import type { Express } from 'express';
import type { DataSource } from 'typeorm';

import { createApp } from '@/app';
import { loadConfig, type AppConfig } from '@/infrastructure/config/app-config';
import { createDataSource } from '@/infrastructure/database/data-source';
import { BcryptPasswordHasher } from '@/infrastructure/auth/bcrypt-password-hasher';
import { InMemoryLoginRateLimiter } from '@/infrastructure/auth/login-rate-limiter';
import { OpaqueTokenProvider } from '@/infrastructure/auth/opaque-token-provider';
import { SystemClock } from '@/infrastructure/auth/system-clock';
import { TypeOrmSessionRepository, TypeOrmUserRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import { OpenShellGatewayClient } from '@/infrastructure/sandbox/openshell-gateway-client';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { UnsupportedOpenShellAgentRuntime } from '@/infrastructure/sandbox/unsupported-openshell-agent-runtime';
import { LocalStagingGateway } from '@/infrastructure/staging/local-staging-gateway';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { runStartupChecks } from '@/infrastructure/startup/startup-checks';
import { GetReadinessUseCase } from '@/modules/health';
import { BootstrapLocalUserUseCase, clearSessionCookie, GetSessionUseCase, LoginUseCase, LogoutUseCase } from '@/modules/auth';
import { CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase } from '@/modules/projects';
import { AddUserMessageUseCase, CreateConversationUseCase, GetConversationUseCase, ListConversationsUseCase } from '@/modules/conversations';
import { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files';
import { StartupChecksError } from '@/shared/errors/app-error';
import { createLogger, type AppLogger } from '@/shared/logging/logger';

export interface Application {
  readonly app: Express;
  readonly config: AppConfig;
  readonly dataSource: DataSource;
  readonly logger: AppLogger;
  readonly readiness: InMemoryReadinessState;
}

export async function createApplication(
  environment: NodeJS.ProcessEnv = process.env
): Promise<Application> {
  const config = loadConfig(environment);
  const logger = createLogger(config.logLevel);
  const dataSource = createDataSource(config.database);
  const readiness = new InMemoryReadinessState();
  const gatewayClient = new OpenShellGatewayClient({
    baseUrl: config.openshellBaseUrl,
    clientId: config.openshellClientId,
    clientToken: config.openshellClientToken,
    healthPath: config.openshellHealthPath,
    nimReadinessPath: config.openshellNimReadinessPath,
    timeoutMs: config.startupCheckTimeoutMs
  });

  try {
    await dataSource.initialize();
    await runStartupChecks({
      dataSource,
      workspaceRoot: config.workspaceRoot,
      workspaceIdentityFile: config.workspaceIdentityFile,
      workspaceIdentity: config.workspaceIdentity,
      gatewayClient,
      nimProfile: config.nimProfile,
      nimModel: config.nimModel,
      agentRuntimeMode: config.agentRuntimeMode
    });
    readiness.markReady();
    const userRepository = new TypeOrmUserRepository(dataSource);
    const sessionRepository = new TypeOrmSessionRepository(dataSource);
    const projectRepository = new TypeOrmProjectRepository(dataSource);
    const conversationRepository = new TypeOrmConversationRepository(dataSource);
    const aiRunRepository = new TypeOrmAiRunRepository(dataSource);
    const workspaceBoundary = new WorkspaceBoundaryAdapter({
      containerRoot: config.workspaceRoot,
      identityFile: config.workspaceIdentityFile,
      expectedIdentity: config.workspaceIdentity
    });
    const workspaceGateway = new WorkspaceGatewayAdapter({
      containerRoot: config.workspaceRoot,
      workspaceBoundary
    });
    const agentRuntime = config.agentRuntimeMode === 'fake' ? new FakeAgentRuntime() : new UnsupportedOpenShellAgentRuntime();
    const stagingGateway = new LocalStagingGateway({ stagingRoot: config.stagingRoot });
    const createAiRun = new CreateAiRunUseCase(projectRepository, conversationRepository, workspaceGateway, aiRunRepository, config.nimProfile, config.nimModel);
    const passwordHasher = new BcryptPasswordHasher();
    const tokenProvider = new OpaqueTokenProvider(config.sessionSecret);
    const clock = new SystemClock();
    if (config.localUserPassword) {
      await new BootstrapLocalUserUseCase(userRepository, passwordHasher).execute({
        password: config.localUserPassword,
        displayName: config.localUserDisplayName
      });
    }
    const login = new LoginUseCase(
      userRepository,
      sessionRepository,
      passwordHasher,
      tokenProvider,
      clock,
      { sessionLifetimeMs: config.sessionLifetimeMs }
    );
    const getSession = new GetSessionUseCase(sessionRepository, tokenProvider, clock);
    return {
      app: createApp({
        logger,
        readiness: new GetReadinessUseCase(readiness),
        appVersion: config.appVersion,
        staticDirectory: config.staticDirectory,
        auth: {
          login,
          getSession,
          logout: new LogoutUseCase(sessionRepository),
          appOrigin: config.appOrigin,
          cookieSecure: config.protocol === 'https',
          sessionLifetimeMs: config.sessionLifetimeMs,
          rateLimiter: new InMemoryLoginRateLimiter()
        },
        projects: {
          getSession,
          createProject: new CreateProjectUseCase(projectRepository, workspaceBoundary),
          listProjects: new ListProjectsUseCase(projectRepository, workspaceBoundary),
          getProject: new GetProjectUseCase(projectRepository, workspaceBoundary),
          updateProjectStatus: new UpdateProjectStatusUseCase(projectRepository, workspaceBoundary),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        conversations: {
          getSession,
          listConversations: new ListConversationsUseCase(projectRepository, conversationRepository),
          createConversation: new CreateConversationUseCase(projectRepository, conversationRepository),
          getConversation: new GetConversationUseCase(projectRepository, conversationRepository),
          addUserMessage: new AddUserMessageUseCase(projectRepository, conversationRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        workspace: {
          getSession,
          listWorkspaceFiles: new ListWorkspaceFilesUseCase(projectRepository, workspaceGateway),
          treeWorkspaceFiles: new TreeWorkspaceFilesUseCase(projectRepository, workspaceGateway),
          readWorkspaceText: new ReadWorkspaceTextUseCase(projectRepository, workspaceGateway),
          searchWorkspaceText: new SearchWorkspaceTextUseCase(projectRepository, workspaceGateway),
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        aiRuns: {
          getSession,
          createAiRun,
          getAiRun: new GetAiRunUseCase(aiRunRepository),
          decideEgress: new DecideEgressUseCase(aiRunRepository, conversationRepository, workspaceGateway, stagingGateway, agentRuntime, config.workspaceRoot),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        }
      }),
      config,
      dataSource,
      logger,
      readiness
    };
  } catch (error: unknown) {
    if (error instanceof StartupChecksError) {
      readiness.markFailed(error.failures);
      logger.error({ failures: error.failures }, 'Startup checks failed');
    }
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
    throw error;
  }
}
