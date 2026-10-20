import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { CreateProjectRemovalJobs1710000017000 } from '@/infrastructure/database/migrations/1710000017000-create-project-removal-jobs';
import { AddInboxTaskPersistence1710000018000 } from '@/infrastructure/database/migrations/1710000018000-add-inbox-task-persistence';
import { AddPlanningProjectPersistence1710000019000 } from '@/infrastructure/database/migrations/1710000019000-add-planning-project-persistence';
import { CreateHomeConversationPersistence1710000020000 } from '@/infrastructure/database/migrations/1710000020000-create-home-conversation-persistence';
import { CreateActionLedgerPersistence1710000021000 } from '@/infrastructure/database/migrations/1710000021000-create-action-ledger-persistence';
import { IncreaseActionLedgerReversibleFieldsCap1710000022000 } from '@/infrastructure/database/migrations/1710000022000-increase-action-ledger-reversible-fields-cap';
import { AddHomeConversationEvents1710000023000 } from '@/infrastructure/database/migrations/1710000023000-add-home-conversation-events';
import { AddHomeConsentDisclosures1710000024000 } from '@/infrastructure/database/migrations/1710000024000-add-home-consent-disclosures';
import { CreateHomeChangeProposals1710000025000 } from '@/infrastructure/database/migrations/1710000025000-create-home-change-proposals';
import { AddAccountIdentity1710000026000 } from '@/infrastructure/database/migrations/1710000026000-add-account-identity';
import { EnforceProjectOwnershipBoundaries1710000027000 } from '@/infrastructure/database/migrations/1710000027000-enforce-project-ownership-boundaries';
import { CreateCreditLedger1710000028000 } from '@/infrastructure/database/migrations/1710000028000-create-credit-ledger';
import { AddAccountStorageLimit1710000029000 } from '@/infrastructure/database/migrations/1710000029000-add-account-storage-limit';
import { CreateStorageRootMappings1710000030000 } from '@/infrastructure/database/migrations/1710000030000-create-storage-root-mappings';
import { CreateDemoAdmission1710000031000 } from '@/infrastructure/database/migrations/1710000031000-create-demo-admission';
import { CreateAssistantScopePolicies1710000032000 } from '@/infrastructure/database/migrations/1710000032000-create-assistant-scope-policies';
import { CreateShowcaseAndDemoCopies1710000033000 } from '@/infrastructure/database/migrations/1710000033000-create-showcase-and-demo-copies';
import { CreateDemoExpiryCleanup1710000034000 } from '@/infrastructure/database/migrations/1710000034000-create-demo-expiry-cleanup';
import { CreateSkills1710000035000 } from '@/infrastructure/database/migrations/1710000035000-create-skills';
import { CanonicalTaskDelete1710000036000 } from '@/infrastructure/database/migrations/1710000036000-canonical-task-delete';
import { AdminDemoPolicy1710000037000 } from '@/infrastructure/database/migrations/1710000037000-admin-demo-policy';
import { CreateAutomations1710000038000 } from '@/infrastructure/database/migrations/1710000038000-create-automations';

import type { DatabaseConfig } from '@/infrastructure/config/database-config';
import { CreateApplicationMetadata1710000000000 } from '@/infrastructure/database/migrations/1710000000000-create-application-metadata';
import { CreateUsersAndSessions1710000001000 } from '@/infrastructure/database/migrations/1710000001000-create-users-and-sessions';
import { CreateProjects1710000002000 } from '@/infrastructure/database/migrations/1710000002000-create-projects';
import { CreateConversationsAndMessages1710000003000 } from '@/infrastructure/database/migrations/1710000003000-create-conversations-and-messages';
import { CreateAiRunsAndEgress1710000004000 } from '@/infrastructure/database/migrations/1710000004000-create-ai-runs-and-egress';
import { CreateSandboxCommands1710000005000 } from '@/infrastructure/database/migrations/1710000005000-create-sandbox-commands';
import { CreateAiRunChat1710000006000 } from '@/infrastructure/database/migrations/1710000006000-create-ai-run-chat';
import { CreateAiRunChangeSets1710000007000 } from '@/infrastructure/database/migrations/1710000007000-create-ai-run-change-sets';
import { AddConfirmedProviderTransmission1710000008000 } from '@/infrastructure/database/migrations/1710000008000-add-confirmed-provider-transmission';
import { CreateProjectFacts1710000009000 } from '@/infrastructure/database/migrations/1710000009000-create-project-facts';
import { CreateProjectTasks1710000010000 } from '@/infrastructure/database/migrations/1710000010000-create-project-tasks';
import { AddAiRunProviderUsage1710000011000 } from '@/infrastructure/database/migrations/1710000011000-add-ai-run-provider-usage';
import { AddChangeSetOperationPathIndex1710000012000 } from '@/infrastructure/database/migrations/1710000012000-add-change-set-operation-path-index';
import { CreateProviderPermissions1710000013000 } from '@/infrastructure/database/migrations/1710000013000-create-provider-permissions';
import { CreateProjectChatContext1710000014000 } from '@/infrastructure/database/migrations/1710000014000-create-project-chat-context';
import { AddContextFileExclusions1710000015000 } from '@/infrastructure/database/migrations/1710000015000-add-context-file-exclusions';
import { AddTaskPlanningFields1710000016000 } from '@/infrastructure/database/migrations/1710000016000-add-task-planning-fields';

export function createDataSource(config: DatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    url: config.url,
    synchronize: false,
    migrationsRun: false,
    migrations: [CreateApplicationMetadata1710000000000, CreateUsersAndSessions1710000001000, CreateProjects1710000002000, CreateConversationsAndMessages1710000003000, CreateAiRunsAndEgress1710000004000, CreateSandboxCommands1710000005000, CreateAiRunChat1710000006000, CreateAiRunChangeSets1710000007000, AddConfirmedProviderTransmission1710000008000, CreateProjectFacts1710000009000, CreateProjectTasks1710000010000, AddAiRunProviderUsage1710000011000, AddChangeSetOperationPathIndex1710000012000, CreateProviderPermissions1710000013000, CreateProjectChatContext1710000014000, AddContextFileExclusions1710000015000, AddTaskPlanningFields1710000016000, CreateProjectRemovalJobs1710000017000, AddInboxTaskPersistence1710000018000, AddPlanningProjectPersistence1710000019000, CreateHomeConversationPersistence1710000020000, CreateActionLedgerPersistence1710000021000, IncreaseActionLedgerReversibleFieldsCap1710000022000, AddHomeConversationEvents1710000023000, AddHomeConsentDisclosures1710000024000, CreateHomeChangeProposals1710000025000, AddAccountIdentity1710000026000, EnforceProjectOwnershipBoundaries1710000027000, CreateCreditLedger1710000028000, AddAccountStorageLimit1710000029000, CreateStorageRootMappings1710000030000, CreateDemoAdmission1710000031000, CreateAssistantScopePolicies1710000032000, CreateShowcaseAndDemoCopies1710000033000, CreateDemoExpiryCleanup1710000034000, CreateSkills1710000035000, CanonicalTaskDelete1710000036000, AdminDemoPolicy1710000037000, CreateAutomations1710000038000],
    entities: [],
    logging: false
  });
}
