import 'reflect-metadata';

import { DataSource } from 'typeorm';

import type { DatabaseConfig } from '@/infrastructure/config/database-config';
import { CreateApplicationMetadata1710000000000 } from '@/infrastructure/database/migrations/1710000000000-create-application-metadata';
import { CreateUsersAndSessions1710000001000 } from '@/infrastructure/database/migrations/1710000001000-create-users-and-sessions';
import { CreateProjects1710000002000 } from '@/infrastructure/database/migrations/1710000002000-create-projects';
import { CreateConversationsAndMessages1710000003000 } from '@/infrastructure/database/migrations/1710000003000-create-conversations-and-messages';
import { CreateAiRunsAndEgress1710000004000 } from '@/infrastructure/database/migrations/1710000004000-create-ai-runs-and-egress';
import { CreateSandboxCommands1710000005000 } from '@/infrastructure/database/migrations/1710000005000-create-sandbox-commands';
import { CreateAiRunChat1710000006000 } from '@/infrastructure/database/migrations/1710000006000-create-ai-run-chat';

export function createDataSource(config: DatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    url: config.url,
    synchronize: false,
    migrationsRun: false,
    migrations: [CreateApplicationMetadata1710000000000, CreateUsersAndSessions1710000001000, CreateProjects1710000002000, CreateConversationsAndMessages1710000003000, CreateAiRunsAndEgress1710000004000, CreateSandboxCommands1710000005000, CreateAiRunChat1710000006000],
    entities: [],
    logging: false
  });
}
