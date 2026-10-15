import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { CreateProjectRemovalJobs1710000017000 } from '@/infrastructure/database/migrations/1710000017000-create-project-removal-jobs';
import { AddInboxTaskPersistence1710000018000 } from '@/infrastructure/database/migrations/1710000018000-add-inbox-task-persistence';
import { AddPlanningProjectPersistence1710000019000 } from '@/infrastructure/database/migrations/1710000019000-add-planning-project-persistence';
import { CreateHomeConversationPersistence1710000020000 } from '@/infrastructure/database/migrations/1710000020000-create-home-conversation-persistence';

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
    migrations: [CreateApplicationMetadata1710000000000, CreateUsersAndSessions1710000001000, CreateProjects1710000002000, CreateConversationsAndMessages1710000003000, CreateAiRunsAndEgress1710000004000, CreateSandboxCommands1710000005000, CreateAiRunChat1710000006000, CreateAiRunChangeSets1710000007000, AddConfirmedProviderTransmission1710000008000, CreateProjectFacts1710000009000, CreateProjectTasks1710000010000, AddAiRunProviderUsage1710000011000, AddChangeSetOperationPathIndex1710000012000, CreateProviderPermissions1710000013000, CreateProjectChatContext1710000014000, AddContextFileExclusions1710000015000, AddTaskPlanningFields1710000016000, CreateProjectRemovalJobs1710000017000, AddInboxTaskPersistence1710000018000, AddPlanningProjectPersistence1710000019000, CreateHomeConversationPersistence1710000020000],
    entities: [],
    logging: false
  });
}
