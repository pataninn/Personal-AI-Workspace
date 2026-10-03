import type { Express } from 'express';
import type { DataSource } from 'typeorm';

import { createApp } from '@/app';
import { TypeOrmProjectChatContextRepository } from '@/infrastructure/database/repositories/typeorm-project-chat-context-repository';
import { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import { SendChatMessageUseCase } from '@/modules/ai-runs/use-cases/send-chat-message-use-case';
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
import { readSecretFile } from '@/infrastructure/auth/read-secret-file';
import { NvidiaHostedNimProvider } from '@/infrastructure/ai-provider/nvidia-hosted-nim-provider';
import { DirectProviderAgentRuntime } from '@/infrastructure/ai-provider/direct-provider-agent-runtime';
import { HermesAgentRuntime } from '@/infrastructure/hermes/hermes-agent-runtime';
import { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import { ApprovedContextReader } from '@/infrastructure/hermes/approved-context-reader';
import type { IModelProvider } from '@/modules/ai-runs/repositories/model-provider';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import { OpenShellGatewayClient } from '@/infrastructure/sandbox/openshell-gateway-client';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { UnsupportedOpenShellAgentRuntime } from '@/infrastructure/sandbox/unsupported-openshell-agent-runtime';
import { LocalStagingGateway } from '@/infrastructure/staging/local-staging-gateway';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmProviderPermissionRepository } from '@/infrastructure/database/repositories/typeorm-provider-permission-repository';
import { TypeOrmSandboxCommandRepository } from '@/infrastructure/database/repositories/typeorm-sandbox-command-repository';
import { TypeOrmProposedChangeSetRepository } from '@/infrastructure/database/repositories/typeorm-change-set-repository';
import { TypeOrmProjectFactRepository } from '@/infrastructure/database/repositories/typeorm-project-fact-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { TypeOrmTaskSuggestionRepository } from '@/infrastructure/database/repositories/task-suggestion-completion-writer';
import { WorkspaceMutationGatewayAdapter } from '@/infrastructure/workspace/workspace-mutation-gateway';
import { DEFAULT_WORKSPACE_INSPECTION_POLICY } from '@/modules/files/domain/workspace-policy';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { runStartupChecks } from '@/infrastructure/startup/startup-checks';
import { GetReadinessUseCase } from '@/modules/health';
import { BootstrapLocalUserUseCase, clearSessionCookie, GetSessionUseCase, LoginUseCase, LogoutUseCase } from '@/modules/auth';
import { CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase } from '@/modules/projects';
import { AddUserMessageUseCase, CreateConversationUseCase, GetConversationUseCase, ListConversationsUseCase } from '@/modules/conversations';
import { CancelAiRunUseCase, CancelSandboxCommandUseCase, CollectProposedChangeSetUseCase, CreateAiRunUseCase, DecideEgressUseCase, DecideProposedChangeSetUseCase, DecideSandboxCommandUseCase, GetAiRunUseCase, GetProposedChangeSetUseCase, GetSandboxCommandUseCase, ListProviderPermissionsUseCase, ListSandboxCommandsUseCase, ProposeSandboxCommandUseCase, RecoverInterruptedAiRunsUseCase, RevokeProviderPermissionUseCase, StartAiRunUseCase } from '@/modules/ai-runs';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files';
import { StartupChecksError } from '@/shared/errors/app-error';
import { createLogger, type AppLogger } from '@/shared/logging/logger';
import { CreateProjectFactUseCase, DeleteProjectFactUseCase, ListProjectFactsUseCase, ReviewProjectFactUseCase, UpdateProjectFactUseCase } from '@/modules/memory';
import { CreateProjectTaskUseCase, ListProjectTaskSuggestionsUseCase, ListProjectTasksUseCase, ReorderProjectTaskUseCase, ResolveProjectTaskSuggestionUseCase, UpdateProjectTaskUseCase } from '@/modules/tasks';
import { GetAiRunActivityUseCase, ListAiRunActivityUseCase } from '@/modules/ai-runs/use-cases/activity-use-cases';
import { ListProjectFileHistoryUseCase } from '@/modules/ai-runs/use-cases/file-history-use-cases';

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
  const modelProvider = config.agentRuntimeMode === 'direct'
    ? await createModelProvider(config, environment)
    : undefined;
  const gatewayClient = config.agentRuntimeMode === 'openshell'
    ? createOpenShellGateway(config)
    : undefined;

  try {
    await dataSource.initialize();
    await runStartupChecks({
      dataSource,
      workspaceRoot: config.workspaceRoot,
      workspaceIdentityFile: config.workspaceIdentityFile,
      workspaceIdentity: config.workspaceIdentity,
      ...(gatewayClient ? { gatewayClient } : {}),
      nimProfile: config.nimProfile,
      nimModel: config.nimModel,
      agentRuntimeMode: config.agentRuntimeMode,
      ...(modelProvider ? { providerCheck: () => modelProvider.checkAvailability() } : {}),
      ...(config.agentRuntimeMode === 'hermes' ? { providerCheck: async () => { await createHermesBridge(config).call('probe'); } } : {})
    });
    const userRepository = new TypeOrmUserRepository(dataSource);
    const sessionRepository = new TypeOrmSessionRepository(dataSource);
    const projectRepository = new TypeOrmProjectRepository(dataSource);
    const projectFactRepository = new TypeOrmProjectFactRepository(dataSource);
    const projectTaskRepository = new TypeOrmProjectTaskRepository(dataSource);
    const taskSuggestionRepository = new TypeOrmTaskSuggestionRepository(dataSource);
    const conversationRepository = new TypeOrmConversationRepository(dataSource);
    const aiRunRepository = new TypeOrmAiRunRepository(dataSource, taskSuggestionRepository);
    const recoveredRunCount = await new RecoverInterruptedAiRunsUseCase(aiRunRepository).execute();
    if (recoveredRunCount > 0) {
      logger.warn({ recoveredRunCount }, 'Interrupted AI runs require manual review after startup.');
    }
    readiness.markReady();
    const providerPermissionRepository = new TypeOrmProviderPermissionRepository(dataSource);
    const commandRepository = new TypeOrmSandboxCommandRepository(dataSource);
    const changeSetRepository = new TypeOrmProposedChangeSetRepository(dataSource);
    const workspaceBoundary = new WorkspaceBoundaryAdapter({
      containerRoot: config.workspaceRoot,
      identityFile: config.workspaceIdentityFile,
      expectedIdentity: config.workspaceIdentity
    });
    const workspaceGateway = new WorkspaceGatewayAdapter({
      containerRoot: config.workspaceRoot,
      workspaceBoundary,
      policy: { ...DEFAULT_WORKSPACE_INSPECTION_POLICY, allowedExtensions: ['*'] }
    });
    const workspaceMutationGateway = new WorkspaceMutationGatewayAdapter({
      containerRoot: config.workspaceRoot,
      workspaceBoundary,
      recoveryRoot: config.recoveryRoot
    });
    const agentRuntime = createAgentRuntime(config, modelProvider, workspaceGateway, conversationRepository, projectFactRepository, logger);
    const stagingGateway = config.agentRuntimeMode === 'openshell'
      ? new LocalStagingGateway({ stagingRoot: config.stagingRoot })
      : undefined;
    const runEvents = new InMemoryRunEventPublisher();
    const chatContextRepository = new TypeOrmProjectChatContextRepository(dataSource);
    const projectChatContext = new ProjectChatContextUseCases(projectRepository, chatContextRepository, projectFactRepository, workspaceGateway);
    const createAiRun = new CreateAiRunUseCase(projectRepository, conversationRepository, workspaceGateway, aiRunRepository, config.nimProfile, config.nimModel, projectFactRepository);
    const proposeSandboxCommand = new ProposeSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger);
    const collectProposedChangeSet = new CollectProposedChangeSetUseCase(aiRunRepository, projectRepository, workspaceMutationGateway, changeSetRepository);
    const decideProposedChangeSet = new DecideProposedChangeSetUseCase(aiRunRepository, projectRepository, changeSetRepository, workspaceMutationGateway, chatContextRepository);
    const startAiRun = new StartAiRunUseCase(aiRunRepository, conversationRepository, agentRuntime, runEvents, proposeSandboxCommand, projectRepository, collectProposedChangeSet, providerPermissionRepository, decideProposedChangeSet);
    const decideEgress = new DecideEgressUseCase(aiRunRepository, conversationRepository, workspaceGateway, stagingGateway, agentRuntime, config.workspaceRoot, projectFactRepository, providerPermissionRepository);
    const sendChatMessage = new SendChatMessageUseCase(chatContextRepository, projectFactRepository, createAiRun, decideEgress, startAiRun);
    const cancelAiRun = new CancelAiRunUseCase(aiRunRepository, agentRuntime, runEvents, projectRepository, commandRepository);
    const passwordHasher = new BcryptPasswordHasher();
    const tokenProvider = new OpaqueTokenProvider(config.sessionSecret);
    const clock = new SystemClock();
    const localUserPassword = config.localUserPassword ?? await readSecretFile(config.localUserPasswordFile);
    if (localUserPassword) {
      await new BootstrapLocalUserUseCase(userRepository, passwordHasher).execute({
        password: localUserPassword,
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
          projectChatContext,
          sendChatMessage,
          getSession,
          createAiRun,
          getAiRun: new GetAiRunUseCase(aiRunRepository),
          decideEgress,
          getProposedChangeSet: new GetProposedChangeSetUseCase(changeSetRepository),
          decideProposedChangeSet,
          taskSuggestionsForRun: taskSuggestionRepository,
          listActivity: new ListAiRunActivityUseCase(projectRepository, aiRunRepository),
          getActivity: new GetAiRunActivityUseCase(aiRunRepository, changeSetRepository, conversationRepository),
          listFileHistory: new ListProjectFileHistoryUseCase(projectRepository, changeSetRepository),
          listProviderPermissions: new ListProviderPermissionsUseCase(providerPermissionRepository),
          revokeProviderPermission: new RevokeProviderPermissionUseCase(providerPermissionRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        sandboxCommands: {
          getSession,
          listCommands: new ListSandboxCommandsUseCase(aiRunRepository, commandRepository),
           getCommand: new GetSandboxCommandUseCase(aiRunRepository, commandRepository),
           decideCommand: new DecideSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger),
           cancelCommand: new CancelSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        aiRunChat: {
          getSession,
          getAiRun: new GetAiRunUseCase(aiRunRepository),
          startAiRun,
          cancelAiRun,
          events: runEvents,
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        projectFacts: {
          getSession,
          listFacts: new ListProjectFactsUseCase(projectRepository, projectFactRepository),
          createFact: new CreateProjectFactUseCase(projectRepository, projectFactRepository),
          updateFact: new UpdateProjectFactUseCase(projectRepository, projectFactRepository),
          reviewFact: new ReviewProjectFactUseCase(projectRepository, projectFactRepository),
          deleteFact: new DeleteProjectFactUseCase(projectRepository, projectFactRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        projectTasks: {
          getSession,
          listTasks: new ListProjectTasksUseCase(projectRepository, projectTaskRepository),
          createTask: new CreateProjectTaskUseCase(projectRepository, projectTaskRepository),
          updateTask: new UpdateProjectTaskUseCase(projectRepository, projectTaskRepository),
          reorderTask: new ReorderProjectTaskUseCase(projectRepository, projectTaskRepository),
          listSuggestions: new ListProjectTaskSuggestionsUseCase(projectRepository, projectTaskRepository),
          resolveSuggestion: new ResolveProjectTaskSuggestionUseCase(projectRepository, projectTaskRepository),
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

async function createModelProvider(config: AppConfig, environment: NodeJS.ProcessEnv): Promise<IModelProvider> {
  const apiKey = await readProviderKey(environment);
  return new NvidiaHostedNimProvider({
    endpoint: config.nimEndpoint,
    model: config.nimModel,
    apiKey,
    timeoutMs: config.startupCheckTimeoutMs * 30
  });
}

function createOpenShellGateway(config: AppConfig): OpenShellGatewayClient {
  if (!config.openshellBaseUrl || !config.openshellClientId || !config.openshellClientToken || !config.openshellNetwork) {
    throw new StartupChecksError([{
      check: 'openshell',
      code: 'OPENSHELL_CONFIGURATION_INVALID',
      message: 'The deferred runtime configuration is incomplete.'
    }]);
  }
  return new OpenShellGatewayClient({
    baseUrl: config.openshellBaseUrl,
    clientId: config.openshellClientId,
    clientToken: config.openshellClientToken,
    healthPath: config.openshellHealthPath,
    nimReadinessPath: config.openshellNimReadinessPath,
    timeoutMs: config.startupCheckTimeoutMs
  });
}

function createAgentRuntime(
  config: AppConfig,
  modelProvider: IModelProvider | undefined,
  workspaceGateway: WorkspaceGatewayAdapter,
  conversationRepository: TypeOrmConversationRepository,
  projectFactRepository: TypeOrmProjectFactRepository,
  logger: AppLogger
): IAgentRuntime {
  if (config.agentRuntimeMode === 'hermes') {
    return new HermesAgentRuntime(createHermesBridge(config), new ApprovedContextReader(workspaceGateway, projectFactRepository), (detail) => logger.error(detail, 'Hermes runtime operation could not be confirmed.'));
  }
  if (config.agentRuntimeMode === 'fake') {
    return new FakeAgentRuntime();
  }
  if (config.agentRuntimeMode === 'openshell') {
    return new UnsupportedOpenShellAgentRuntime();
  }
  if (!modelProvider) {
    throw new StartupChecksError([{
      check: 'nim',
      code: 'NIM_PROVIDER_UNAVAILABLE',
      message: 'The configured NVIDIA hosted provider is unavailable.'
    }]);
  }
  return new DirectProviderAgentRuntime({ provider: modelProvider, workspaceGateway, conversationRepository, projectFactRepository });
}

async function readProviderKey(environment: NodeJS.ProcessEnv): Promise<string> {
  return readSecretFile(environment.NVIDIA_API_KEY_FILE);
}

function createHermesBridge(config: AppConfig): HermesBridgeClient {
  return new HermesBridgeClient({ endpoint: config.hermesBridgeEndpoint ?? '', caFile: config.hermesBridgeCaFile ?? '', certFile: config.hermesBridgeCertFile ?? '', keyFile: config.hermesBridgeKeyFile ?? '' });
}
