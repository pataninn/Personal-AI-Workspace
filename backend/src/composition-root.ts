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
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmCreditLedgerRepository } from '@/infrastructure/database/repositories/typeorm-credit-ledger-repository';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeChangeProposalRepository } from '@/infrastructure/database/repositories/typeorm-home-change-proposal-repository';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { CreateHomeConversationUseCase } from '@/modules/home-assistant/use-cases/create-home-conversation';
import { GetHomeConversationUseCase } from '@/modules/home-assistant/use-cases/get-home-conversation';
import { ListHomeConversationsUseCase } from '@/modules/home-assistant/use-cases/list-home-conversations';
import { ListHomeTurnsUseCase } from '@/modules/home-assistant/use-cases/list-home-turns';
import { SubmitHomeTurnUseCase } from '@/modules/home-assistant/use-cases/submit-home-turn';
import { DecideHomeConsentUseCase } from '@/modules/home-assistant/use-cases/decide-home-consent';
import { HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import { HomeChangeProposalUseCases } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import { ListHomeMessagesUseCase } from '@/modules/home-assistant/use-cases/list-home-messages';
import { ListHomeEventsUseCase } from '@/modules/home-assistant/use-cases/list-home-events';
import { RecoverInterruptedHomeTurnsUseCase } from '@/modules/home-assistant/use-cases/recover-interrupted-home-turns';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import { readSecretFile } from '@/infrastructure/auth/read-secret-file';
import { NvidiaHostedNimProvider } from '@/infrastructure/ai-provider/nvidia-hosted-nim-provider';
import { ProviderCallCreditAdmission } from '@/modules/credits/use-cases/provider-call-credit-admission';
import { DirectProviderAgentRuntime } from '@/infrastructure/ai-provider/direct-provider-agent-runtime';
import { HermesAgentRuntime } from '@/infrastructure/hermes/hermes-agent-runtime';
import { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';
import { HermesHomePlanningRuntime, HOME_PLANNING_TOOL_NAMES } from '@/infrastructure/hermes/hermes-home-planning-runtime';
import { ApprovedContextReader } from '@/infrastructure/hermes/approved-context-reader';
import { HermesProjectTaskTools } from '@/infrastructure/hermes/hermes-project-task-tools';
import type { IModelProvider } from '@/modules/ai-runs/repositories/model-provider';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { HomePlanningProvider } from '@/modules/home-assistant/repositories/home-planning-runtime';
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
import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';
import { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';
import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import { TypeOrmProjectOverviewRepository } from '@/infrastructure/database/repositories/typeorm-project-overview-repository';
import { ProjectRecoveryCleaner } from '@/infrastructure/workspace/project-recovery-cleaner';
import { DeleteProjectUseCase } from '@/modules/projects/use-cases/delete-project';
import { GetProjectOverviewUseCase } from '@/modules/projects/use-cases/get-project-overview';
import { ProjectFileActions } from '@/modules/files/use-cases/project-file-actions';
import { MarkItDownDocumentConverter } from '@/infrastructure/files/markitdown-document-converter';
import { DEFAULT_WORKSPACE_INSPECTION_POLICY } from '@/modules/files/domain/workspace-policy';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { runStartupChecks } from '@/infrastructure/startup/startup-checks';
import { startPeriodicMaintenance, type PeriodicMaintenanceHandle } from '@/infrastructure/startup/periodic-maintenance';
import { StorageQuotaStartupReconciler } from '@/infrastructure/startup/storage-quota-startup-reconciler';
import { PhysicalStorageSpaceMonitor } from '@/infrastructure/startup/physical-storage-space-monitor';
import { GetReadinessUseCase } from '@/modules/health';
import { BootstrapLocalUserUseCase, clearSessionCookie, GetSessionUseCase, LoginUseCase, LogoutUseCase } from '@/modules/auth';
import { PrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import { CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase, WorkspacePlanningUseCases } from '@/modules/projects';
import { AddUserMessageUseCase, CreateConversationUseCase, GetConversationUseCase, ListConversationsUseCase } from '@/modules/conversations';
import { CancelAiRunUseCase, CancelSandboxCommandUseCase, CollectProposedChangeSetUseCase, CreateAiRunUseCase, DecideEgressUseCase, DecideProposedChangeSetUseCase, DecideSandboxCommandUseCase, GetAiRunUseCase, GetProposedChangeSetUseCase, GetSandboxCommandUseCase, ListProviderPermissionsUseCase, ListSandboxCommandsUseCase, ProposeSandboxCommandUseCase, RecoverInterruptedAiRunsUseCase, RevokeProviderPermissionUseCase, StartAiRunUseCase } from '@/modules/ai-runs';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files';
import { StartupChecksError } from '@/shared/errors/app-error';
import { createLogger, type AppLogger } from '@/shared/logging/logger';
import { CreateProjectFactUseCase, DeleteProjectFactUseCase, ListProjectFactsUseCase, ReviewProjectFactUseCase, UpdateProjectFactUseCase } from '@/modules/memory';
import { CountInboxTasksUseCase, CreateProjectTaskUseCase, DeleteProjectTaskUseCase, GetGlobalTaskUseCase, ListGlobalTasksUseCase, ListProjectTaskSuggestionsUseCase, ListProjectTasksUseCase, ReorderProjectTaskUseCase, ResolveProjectTaskSuggestionUseCase, TaskMutationUseCases, UpdateProjectTaskUseCase } from '@/modules/tasks';
import { GetAiRunActivityUseCase, ListAiRunActivityUseCase } from '@/modules/ai-runs/use-cases/activity-use-cases';
import { ListProjectFileHistoryUseCase } from '@/modules/ai-runs/use-cases/file-history-use-cases';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaFileMutation } from '@/infrastructure/workspace/storage-quota-file-mutation';
import { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';
import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { TypeOrmDemoStorageBootstrap } from '@/infrastructure/database/typeorm-demo-storage-bootstrap';
import { CreateDemoSessionUseCase } from '@/modules/demo/use-cases/create-demo-session';
import { TypeOrmAssistantScopePolicyRepository } from '@/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository';
import { GetAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/get-assistant-execution-policy';
import { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import { RuntimeCapabilityAdapter } from '@/infrastructure/assistant-policy/runtime-capability-adapter';
import { TypeOrmShowcaseRepository } from '@/infrastructure/database/repositories/typeorm-showcase-repository';
import { TypeOrmDemoShowcaseCopyManager } from '@/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager';
import { BuildShowcasePreviewUseCase, PublishShowcaseUseCase } from '@/modules/showcases/use-cases/showcase-use-cases';

export interface Application {
  readonly app: Express;
  readonly config: AppConfig;
  readonly dataSource: DataSource;
  readonly logger: AppLogger;
  readonly readiness: InMemoryReadinessState;
  stopMaintenance(): Promise<void>;
}

const STORAGE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export async function createApplication(
  environment: NodeJS.ProcessEnv = process.env
): Promise<Application> {
  const config = loadConfig(environment);
  const logger = createLogger(config.logLevel);
  const dataSource = createDataSource(config.database);
  const readiness = new InMemoryReadinessState();
  let maintenanceHandle: PeriodicMaintenanceHandle | undefined;
  const providerCallCreditAdmission = new ProviderCallCreditAdmission(new TypeOrmCreditLedgerRepository(dataSource));
  const modelProvider = config.agentRuntimeMode === 'direct'
    ? await createModelProvider(config, environment, providerCallCreditAdmission)
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
      ...(config.agentRuntimeMode === 'hermes' ? { providerCheck: async () => { await createHermesBridge(config).call('probe', undefined, undefined, { providerProfile: config.nimProfile, model: config.nimModel, endpoint: config.nimEndpoint }); } } : {})
    });
    const assistantScopePolicyRepository = new TypeOrmAssistantScopePolicyRepository(dataSource);
    await assistantScopePolicyRepository.synchronizeProviderConfiguration({
      providerProfile: config.nimProfile,
      model: config.nimModel
    });
    const storageQuotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    const storageRootMappingRepository = new TypeOrmStorageRootMappingRepository(dataSource);
    const storageContentAccounting = new TypeOrmStorageContentAccounting(dataSource, storageQuotaRepository);
    const storageFileMutation = new StorageQuotaFileMutation(storageQuotaRepository);
    const demoAdmissionRepository = new TypeOrmDemoAdmissionRepository(dataSource, config.demoAbuseLimits);
    const userRepository = new TypeOrmUserRepository(dataSource);
    const localUserPassword = config.localUserPassword ?? await readSecretFile(config.localUserPasswordFile);
    if (localUserPassword) {
      await new BootstrapLocalUserUseCase(userRepository, new BcryptPasswordHasher()).execute({
        password: localUserPassword,
        displayName: config.localUserDisplayName
      });
    }
    const clock = new SystemClock();
    const principalAuthorization = new PrincipalAuthorization(userRepository, clock);
    const sessionRepository = new TypeOrmSessionRepository(dataSource);
    const projectRepository = new TypeOrmProjectRepository(dataSource, storageContentAccounting);
    const homeConversationRepository = new TypeOrmHomeConversationRepository(dataSource, storageContentAccounting);
    const homeChangeProposalRepository = new TypeOrmHomeChangeProposalRepository(dataSource, storageContentAccounting);
    const actionLedgerRepository = new TypeOrmActionLedgerRepository(dataSource, new TypeOrmHomeActionEventRecorder(), storageContentAccounting);
    const projectFactRepository = new TypeOrmProjectFactRepository(dataSource, storageContentAccounting);
    const projectTaskRepository = new TypeOrmProjectTaskRepository(dataSource, storageContentAccounting);
    const taskMutationUseCases = new TaskMutationUseCases(actionLedgerRepository, projectTaskRepository, projectTaskRepository);
    const taskSuggestionRepository = new TypeOrmTaskSuggestionRepository(dataSource);
    const conversationRepository = new TypeOrmConversationRepository(dataSource, storageContentAccounting);
    const aiRunRepository = new TypeOrmAiRunRepository(dataSource, taskSuggestionRepository, storageContentAccounting);
    const recoveredRunCount = await new RecoverInterruptedAiRunsUseCase(aiRunRepository).execute();
    if (recoveredRunCount > 0) {
      logger.warn({ recoveredRunCount }, 'Interrupted AI runs require manual review after startup.');
    }
    const recoveredHomeTurnCount = await new RecoverInterruptedHomeTurnsUseCase(homeConversationRepository).execute();
    if (recoveredHomeTurnCount > 0) {
      logger.warn({ recoveredHomeTurnCount }, 'Interrupted Home turns were marked for review after startup.');
    }
    const projectRemovalRepository = new TypeOrmProjectRemovalRepository(
      dataSource,
      new ProjectRecoveryCleaner(config.recoveryRoot),
      storageContentAccounting,
      storageQuotaRepository,
      storageRootMappingRepository
    );
    await projectRemovalRepository.cleanupPending();
    const workspaceBoundary = new WorkspaceBoundaryAdapter({
      containerRoot: config.workspaceRoot,
      identityFile: config.workspaceIdentityFile,
      expectedIdentity: config.workspaceIdentity,
      legacyOwnerId: () => userRepository.findBootstrapOwnerId(),
      ...(config.accountWorkspacesIdentity ? {
        managedContainerRoot: '/account-workspaces',
        managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
        managedExpectedIdentity: config.accountWorkspacesIdentity
      } : {})
    });
    const storageReconciliation = await new StorageQuotaStartupReconciler(
      dataSource,
      storageQuotaRepository,
      storageRootMappingRepository,
      storageContentAccounting,
      workspaceBoundary,
      config.recoveryRoot
    ).reconcile();
    if (storageReconciliation.unavailableOwnerIds.length > 0) {
      logger.warn(
        { unavailableOwnerCount: storageReconciliation.unavailableOwnerIds.length },
        'Storage accounting remains unavailable for accounts whose retained content could not be verified.'
      );
    }
    const projectFileAccess = new TypeOrmProjectFileAccess(dataSource, storageRootMappingRepository);
    const projectFileGateway = new ProjectFileGateway({ containerRoot: config.workspaceRoot, workspaceBoundary });
    const projectFileActions = new ProjectFileActions(projectFileAccess, projectFileGateway, new MarkItDownDocumentConverter(), storageFileMutation);
    const showcaseRepository = new TypeOrmShowcaseRepository(dataSource);
    const buildShowcasePreview = new BuildShowcasePreviewUseCase(projectRepository, projectTaskRepository, projectFactRepository, projectFileActions, config.showcaseLimits);
    const publishShowcase = new PublishShowcaseUseCase(buildShowcasePreview, showcaseRepository, config.showcaseLimits);
    const demoShowcaseCopy = new TypeOrmDemoShowcaseCopyManager(
      dataSource, showcaseRepository, projectRepository, workspaceBoundary, projectFileAccess, projectFileGateway,
      storageFileMutation, storageQuotaRepository, storageContentAccounting, config.showcaseLimits
    );
    const managedStorageReady = async (): Promise<boolean> => Boolean(config.accountWorkspacesIdentity)
      && (await workspaceBoundary.getManagedSnapshot()).status === 'ready';
    const providerPermissionRepository = new TypeOrmProviderPermissionRepository(dataSource);
    const commandRepository = new TypeOrmSandboxCommandRepository(dataSource, storageContentAccounting);
    const changeSetRepository = new TypeOrmProposedChangeSetRepository(dataSource, storageContentAccounting);
    const workspacePlanning = new WorkspacePlanningUseCases(projectRepository, projectRepository, actionLedgerRepository, workspaceBoundary);
    const workspaceGateway = new WorkspaceGatewayAdapter({
      containerRoot: config.workspaceRoot,
      workspaceBoundary,
      policy: { ...DEFAULT_WORKSPACE_INSPECTION_POLICY, allowedExtensions: ['*'] }
    });
    const workspaceMutationGateway = new WorkspaceMutationGatewayAdapter({
      containerRoot: config.workspaceRoot,
      workspaceBoundary,
      recoveryRoot: config.recoveryRoot,
      storageMutations: storageFileMutation,
      rootMappings: storageRootMappingRepository
    });
    const taskTools = new HermesProjectTaskTools({ runs: aiRunRepository, principalAuthorization, list: new ListProjectTasksUseCase(projectRepository, projectTaskRepository), create: new CreateProjectTaskUseCase(projectRepository, projectTaskRepository, taskMutationUseCases), update: new UpdateProjectTaskUseCase(projectRepository, projectTaskRepository, taskMutationUseCases) });
    const agentRuntime = createAgentRuntime(config, modelProvider, workspaceGateway, conversationRepository, projectFactRepository, logger, taskTools);
    const homePlanningProvider: HomePlanningProvider = { profile: config.nimProfile, model: config.nimModel, endpoint: config.nimEndpoint };
    const homePlanningRuntime = config.agentRuntimeMode === 'hermes'
      ? new HermesHomePlanningRuntime(createHermesBridge(config), homePlanningProvider, {
        registeredToolNames: HOME_PLANNING_TOOL_NAMES,
        providerEgressAdmissionEnforced: false
      })
      : undefined;
    const assistantRuntimeCapability = new RuntimeCapabilityAdapter(agentRuntime, homePlanningRuntime);
    const assistantExecutionPolicy = new AssertAssistantExecutionPolicyUseCase(
      assistantScopePolicyRepository, projectRepository, principalAuthorization, assistantRuntimeCapability
    );
    const homeToolResultConsentGate = new HomeToolResultConsentGate(homeConversationRepository, homePlanningProvider);
    const homeChangeProposals = new HomeChangeProposalUseCases(
      homeConversationRepository, homeChangeProposalRepository, new GetGlobalTaskUseCase(projectTaskRepository),
      taskMutationUseCases, workspacePlanning, actionLedgerRepository, config.homePlanningTimeZone
    );
    const homePlanningToolHandler = new HomePlanningToolRequestHandler({
      principalAuthorization,
      executionPolicy: assistantExecutionPolicy,
      provider: { profile: homePlanningProvider.profile, model: homePlanningProvider.model },
      conversations: homeConversationRepository,
      listTasks: new ListGlobalTasksUseCase(projectTaskRepository),
      getTask: new GetGlobalTaskUseCase(projectTaskRepository),
      taskMutations: taskMutationUseCases,
      workspaces: workspacePlanning,
      undo: new ActionUndoUseCases(actionLedgerRepository, projectTaskRepository, projectRepository),
      ...(config.homePlanningTimeZone ? { timeZone: config.homePlanningTimeZone } : {})
    });
    const stagingGateway = config.agentRuntimeMode === 'openshell'
      ? new LocalStagingGateway({ stagingRoot: config.stagingRoot })
      : undefined;
    const runEvents = new InMemoryRunEventPublisher();
    const chatContextRepository = new TypeOrmProjectChatContextRepository(dataSource);
    const projectChatContext = new ProjectChatContextUseCases(projectRepository, chatContextRepository, projectFactRepository, workspaceGateway);
    const createAiRun = new CreateAiRunUseCase(projectRepository, conversationRepository, workspaceGateway, aiRunRepository, config.nimProfile, config.nimModel, projectFactRepository, assistantExecutionPolicy);
    const proposeSandboxCommand = new ProposeSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger, assistantExecutionPolicy);
    const decideSandboxCommand = new DecideSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger, assistantExecutionPolicy);
    const collectProposedChangeSet = new CollectProposedChangeSetUseCase(aiRunRepository, projectRepository, workspaceMutationGateway, changeSetRepository);
    const decideProposedChangeSet = new DecideProposedChangeSetUseCase(aiRunRepository, projectRepository, changeSetRepository, workspaceMutationGateway, chatContextRepository, principalAuthorization, assistantExecutionPolicy);
    const startAiRun = new StartAiRunUseCase(aiRunRepository, conversationRepository, agentRuntime, runEvents, demoAdmissionRepository, proposeSandboxCommand, projectRepository, collectProposedChangeSet, providerPermissionRepository, decideProposedChangeSet, principalAuthorization, stagingGateway, assistantExecutionPolicy, decideSandboxCommand);
    const decideEgress = new DecideEgressUseCase(aiRunRepository, projectRepository, conversationRepository, workspaceGateway, stagingGateway, agentRuntime, config.workspaceRoot, projectFactRepository, providerPermissionRepository, assistantExecutionPolicy);
    const sendChatMessage = new SendChatMessageUseCase(projectChatContext, projectFactRepository, createAiRun, decideEgress, startAiRun);
    const cancelAiRun = new CancelAiRunUseCase(aiRunRepository, agentRuntime, runEvents, projectRepository, commandRepository, stagingGateway);
    const passwordHasher = new BcryptPasswordHasher();
    const tokenProvider = new OpaqueTokenProvider(config.sessionSecret);
    const login = new LoginUseCase(
      userRepository,
      sessionRepository,
      passwordHasher,
      tokenProvider,
      clock,
      { sessionLifetimeMs: config.sessionLifetimeMs }
    );
    const getSession = new GetSessionUseCase(sessionRepository, tokenProvider, clock);
    const createDemoSession = new CreateDemoSessionUseCase(
      demoAdmissionRepository,
      new TypeOrmDemoStorageBootstrap(dataSource, storageContentAccounting, storageQuotaRepository),
      tokenProvider,
      {
        ...(config.demoAbuseLimits ? { limits: config.demoAbuseLimits } : {}),
        ...(config.demoNetworkHashSecret ? { networkHashSecret: config.demoNetworkHashSecret } : {}),
        lifetimeMs: config.demoSessionLifetimeMs,
        isShowcaseAvailable: async () => {
          if (!config.showcaseLimits) return false;
          const current = await showcaseRepository.getCurrentSummary();
          return Boolean(current) && (current?.fileCount === 0 || await managedStorageReady());
        },
        provisionShowcaseCopy: (admissionId, ownerId) => demoShowcaseCopy.provision(admissionId, ownerId)
      }
    );
    const app = createApp({
        logger,
        readiness: new GetReadinessUseCase(readiness),
        appVersion: config.appVersion,
        staticDirectory: config.staticDirectory,
        ...(config.trustedProxyCidrs ? { trustedProxyCidrs: config.trustedProxyCidrs } : {}),
        demoAdmission: {
          createSession: createDemoSession,
          getSession,
          appOrigin: config.appOrigin,
          cookieSecure: config.protocol === 'https',
          showcaseCopy: demoShowcaseCopy
        },
        showcases: {
          repository: showcaseRepository,
          buildPreview: buildShowcasePreview,
          publish: publishShowcase,
          getSession,
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https'),
          ...(config.showcaseLimits ? { limits: config.showcaseLimits } : {}),
          admissionConfigurationReady: () => Boolean(config.demoAbuseLimits && config.demoNetworkHashSecret
            && Buffer.byteLength(config.demoNetworkHashSecret, 'utf8') >= 32),
          managedStorageReady
        },
        demoCopyGate: { getSession, isReady: (ownerId) => demoShowcaseCopy.isReady(ownerId) },
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
          deleteProject: new DeleteProjectUseCase(projectRemovalRepository),
          getOverview: new GetProjectOverviewUseCase(new TypeOrmProjectOverviewRepository(dataSource)),
          getSession,
          createProject: new CreateProjectUseCase(projectRepository, workspaceBoundary),
          listProjects: new ListProjectsUseCase(projectRepository),
          getProject: new GetProjectUseCase(projectRepository),
          updateProjectStatus: new UpdateProjectStatusUseCase(projectRepository, workspaceBoundary),
          workspacePlanning,
          workspaceBoundary,
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
        homeConversations: {
          getSession,
          listConversations: new ListHomeConversationsUseCase(homeConversationRepository),
          createConversation: new CreateHomeConversationUseCase(homeConversationRepository),
          getConversation: new GetHomeConversationUseCase(homeConversationRepository),
          listTurns: new ListHomeTurnsUseCase(homeConversationRepository),
          submitTurn: new SubmitHomeTurnUseCase(homeConversationRepository, {
            mode: config.agentRuntimeMode,
            provider: homePlanningProvider,
            ...(homePlanningRuntime ? { runtime: homePlanningRuntime } : {})
          }, { executionPolicy: assistantExecutionPolicy, providerProfile: config.nimProfile, model: config.nimModel }),
          decideConsent: new DecideHomeConsentUseCase(homeConversationRepository, homePlanningRuntime, homePlanningProvider, homeToolResultConsentGate),
          getTurn: new GetHomeTurnUseCase(homeConversationRepository, homePlanningRuntime, homeToolResultConsentGate, homePlanningToolHandler, { executionPolicy: assistantExecutionPolicy, providerProfile: config.nimProfile, model: config.nimModel }),
          cancelTurn: new CancelHomeTurnUseCase(homeConversationRepository, homePlanningRuntime),
          listMessages: new ListHomeMessagesUseCase(homeConversationRepository),
          listEvents: new ListHomeEventsUseCase(homeConversationRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        homeProposals: {
          getSession,
          proposals: homeChangeProposals,
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        accountStorage: {
          getSession,
          getStorageUsage: new GetStorageUsage(storageQuotaRepository),
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        assistantExecutionPolicy: {
          getSession,
          getExecutionPolicy: new GetAssistantExecutionPolicyUseCase(
            assistantScopePolicyRepository, projectRepository, principalAuthorization, projectChatContext, assistantRuntimeCapability
          ),
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        workspace: {
          appOrigin: config.appOrigin,
          fileActions: new ProjectFileActions(new TypeOrmProjectFileAccess(dataSource, storageRootMappingRepository), new ProjectFileGateway({ containerRoot: config.workspaceRoot, workspaceBoundary }), new MarkItDownDocumentConverter(), storageFileMutation),
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
          getAiRun: new GetAiRunUseCase(aiRunRepository, projectRepository),
          decideEgress,
          startAiRun,
          getProposedChangeSet: new GetProposedChangeSetUseCase(aiRunRepository, projectRepository, changeSetRepository),
          decideProposedChangeSet,
          taskSuggestionsForRun: taskSuggestionRepository,
          listActivity: new ListAiRunActivityUseCase(projectRepository, aiRunRepository),
          getActivity: new GetAiRunActivityUseCase(aiRunRepository, changeSetRepository, conversationRepository, projectRepository),
          listFileHistory: new ListProjectFileHistoryUseCase(projectRepository, changeSetRepository),
          listProviderPermissions: new ListProviderPermissionsUseCase(providerPermissionRepository),
          revokeProviderPermission: new RevokeProviderPermissionUseCase(providerPermissionRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        sandboxCommands: {
          getSession,
          listCommands: new ListSandboxCommandsUseCase(aiRunRepository, commandRepository, projectRepository),
           getCommand: new GetSandboxCommandUseCase(aiRunRepository, commandRepository, projectRepository),
           decideCommand: decideSandboxCommand,
           cancelCommand: new CancelSandboxCommandUseCase(aiRunRepository, commandRepository, agentRuntime, projectRepository, logger),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        aiRunChat: {
          getSession,
          principalAuthorization,
          getAiRun: new GetAiRunUseCase(aiRunRepository, projectRepository),
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
          deleteTask: new DeleteProjectTaskUseCase(projectRepository, projectTaskRepository, taskMutationUseCases),
          getSession,
          listTasks: new ListProjectTasksUseCase(projectRepository, projectTaskRepository),
          createTask: new CreateProjectTaskUseCase(projectRepository, projectTaskRepository, taskMutationUseCases),
          updateTask: new UpdateProjectTaskUseCase(projectRepository, projectTaskRepository, taskMutationUseCases),
          reorderTask: new ReorderProjectTaskUseCase(projectRepository, projectTaskRepository),
          listSuggestions: new ListProjectTaskSuggestionsUseCase(projectRepository, projectTaskRepository),
          resolveSuggestion: new ResolveProjectTaskSuggestionUseCase(projectRepository, projectTaskRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        globalTasks: {
          getSession,
          countInboxTasks: new CountInboxTasksUseCase(projectTaskRepository),
          listTasks: new ListGlobalTasksUseCase(projectTaskRepository),
          getTask: new GetGlobalTaskUseCase(projectTaskRepository),
          mutations: taskMutationUseCases,
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        },
        actionUndo: {
          getSession,
          undoAction: new ActionUndoUseCases(actionLedgerRepository, projectTaskRepository, projectRepository),
          appOrigin: config.appOrigin,
          clearSessionCookie: (response) => clearSessionCookie(response, config.protocol === 'https')
        }
      });
    const physicalStorageMonitor = new PhysicalStorageSpaceMonitor({
      roots: [
        {
          volume: 'legacy_workspace', path: config.workspaceRoot,
          isTrusted: async () => (await workspaceBoundary.getSnapshot()).status === 'ready'
        },
        ...(config.accountWorkspacesIdentity ? [{
          volume: 'managed_workspaces' as const,
          path: '/account-workspaces',
          isTrusted: async () => (await workspaceBoundary.getManagedSnapshot()).status === 'ready'
        }] : []),
        { volume: 'recovery', path: config.recoveryRoot }
      ],
      ...(config.storageDiskWarningFreeBytes !== undefined ? { warningFreeBytes: config.storageDiskWarningFreeBytes } : {}),
      logger
    });
    maintenanceHandle = await startPeriodicMaintenance({
      task: { run: async () => {
        const [cleanedStagingCount] = await Promise.all([
          stagingGateway?.cleanupExpired() ?? Promise.resolve(0),
          physicalStorageMonitor.observe()
        ]);
        return cleanedStagingCount;
      } },
      logger,
      intervalMs: STORAGE_MAINTENANCE_INTERVAL_MS,
      operationName: 'storage maintenance'
    });
    readiness.markReady();
    return {
      app,
      config,
      dataSource,
      logger,
      readiness,
      stopMaintenance: async () => await maintenanceHandle?.stop()
    };
  } catch (error: unknown) {
    if (maintenanceHandle) await maintenanceHandle.stop();
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

async function createModelProvider(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  creditAdmission: ProviderCallCreditAdmission
): Promise<IModelProvider> {
  const apiKey = await readProviderKey(environment);
  return new NvidiaHostedNimProvider({
    endpoint: config.nimEndpoint,
    model: config.nimModel,
    apiKey,
    timeoutMs: config.startupCheckTimeoutMs * 30,
    creditAdmission,
    ...(config.providerCreditConfiguration ? { creditConfiguration: config.providerCreditConfiguration } : {})
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
  logger: AppLogger,
  taskTools: HermesProjectTaskTools
): IAgentRuntime {
  if (config.agentRuntimeMode === 'hermes') {
    return new HermesAgentRuntime(createHermesBridge(config), new ApprovedContextReader(workspaceGateway, projectFactRepository), {
      taskTools,
      providerProfile: config.nimProfile, model: config.nimModel, endpoint: config.nimEndpoint,
      providerEgressAdmissionEnforced: false,
      diagnose: (detail) => logger.error(detail, 'Hermes runtime operation could not be confirmed.')
    });
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
