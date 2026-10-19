import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores immutable sanitized showcase versions and their durable demo-copy pins. */
export class CreateShowcaseAndDemoCopies1710000033000 implements MigrationInterface {
  public readonly name = 'CreateShowcaseAndDemoCopies1710000033000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "showcase_versions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "project_display" jsonb NOT NULL CHECK (jsonb_typeof("project_display") = 'object'),
        "tasks" jsonb NOT NULL CHECK (jsonb_typeof("tasks") = 'array'),
        "facts" jsonb NOT NULL CHECK (jsonb_typeof("facts") = 'array'),
        "content_digest" text NOT NULL CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
        "snapshot_bytes" bigint NOT NULL CHECK ("snapshot_bytes" >= 0),
        "item_count" integer NOT NULL CHECK ("item_count" >= 0),
        "file_count" integer NOT NULL CHECK ("file_count" >= 0),
        "published_at" timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "showcase_files" (
        "version_id" uuid NOT NULL REFERENCES "showcase_versions"("id") ON DELETE CASCADE,
        "file_id" uuid NOT NULL,
        "name" text NOT NULL CHECK (length("name") BETWEEN 1 AND 2048),
        "media_type" text NOT NULL CHECK ("media_type" IN ('application/octet-stream', 'application/pdf', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'text/csv', 'text/plain')),
        "content" bytea NOT NULL,
        "sha256" text NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
        "byte_length" integer NOT NULL CHECK ("byte_length" >= 0),
        CONSTRAINT "PK_showcase_files" PRIMARY KEY ("version_id", "file_id"),
        CONSTRAINT "CHK_showcase_file_length" CHECK (octet_length("content") = "byte_length")
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_showcase_files_version_name" ON "showcase_files" ("version_id", "name")');
    await queryRunner.query(`
      CREATE TABLE "showcase_publication" (
        "singleton_id" boolean PRIMARY KEY DEFAULT true CHECK ("singleton_id" = true),
        "current_version_id" uuid NULL REFERENCES "showcase_versions"("id") ON DELETE RESTRICT,
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await queryRunner.query('INSERT INTO "showcase_publication" ("singleton_id") VALUES (true)');
    await queryRunner.query(`
      CREATE TABLE "showcase_publish_idempotency" (
        "admin_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "key_digest" text NOT NULL CHECK ("key_digest" ~ '^[a-f0-9]{64}$'),
        "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[a-f0-9]{64}$'),
        "version_id" uuid NOT NULL,
        "published_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_showcase_publish_idempotency" PRIMARY KEY ("admin_id", "key_digest")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "demo_showcase_copies" (
        "admission_id" uuid PRIMARY KEY REFERENCES "demo_admissions"("id") ON DELETE CASCADE,
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "pinned_version_id" uuid NULL REFERENCES "showcase_versions"("id") ON DELETE RESTRICT,
        "target_project_id" uuid NOT NULL UNIQUE,
        "state" text NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'ready', 'failed')),
        "phase" text NOT NULL DEFAULT 'queued' CHECK ("phase" IN ('queued', 'root_pending', 'root_created', 'database_created', 'files_pending', 'complete', 'unknown')),
        "claim_token" uuid NULL,
        "claim_expires_at" timestamptz NULL,
        "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
        "retry_allowed" boolean NOT NULL DEFAULT true,
        "failure_code" text NULL CHECK ("failure_code" IS NULL OR "failure_code" IN ('quota', 'storage', 'source_changed', 'unknown_side_effect', 'expired')),
        "workspace_mode" text NULL CHECK ("workspace_mode" IS NULL OR "workspace_mode" IN ('planning', 'file_backed')),
        "file_access" boolean NULL,
        "id_map" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("id_map") = 'object'),
        "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_demo_showcase_copy_ready" CHECK (("state" = 'ready') = ("phase" = 'complete')),
        CONSTRAINT "CHK_demo_showcase_copy_capabilities" CHECK (("workspace_mode" IS NULL) = ("file_access" IS NULL))
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_demo_showcase_copies_owner_state" ON "demo_showcase_copies" ("owner_id", "state", "updated_at")');
    await queryRunner.query(`
      CREATE FUNCTION "reject_showcase_version_update"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'published showcase versions are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query('CREATE TRIGGER "TRG_showcase_versions_immutable" BEFORE UPDATE ON "showcase_versions" FOR EACH ROW EXECUTE FUNCTION "reject_showcase_version_update"()');
    await queryRunner.query('CREATE TRIGGER "TRG_showcase_files_immutable" BEFORE UPDATE ON "showcase_files" FOR EACH ROW EXECUTE FUNCTION "reject_showcase_version_update"()');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_versions: boolean; readonly has_copies: boolean; readonly has_publication: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "showcase_versions") AS "has_versions",
             EXISTS (SELECT 1 FROM "demo_showcase_copies") AS "has_copies",
             EXISTS (SELECT 1 FROM "showcase_publication" WHERE "current_version_id" IS NOT NULL) AS "has_publication"
    `);
    if (rows[0]?.has_versions || rows[0]?.has_copies || rows[0]?.has_publication) {
      throw new Error('Showcase rollback is blocked while versions, publication state, or demo copies exist.');
    }
    await queryRunner.query('DROP TRIGGER "TRG_showcase_files_immutable" ON "showcase_files"');
    await queryRunner.query('DROP TRIGGER "TRG_showcase_versions_immutable" ON "showcase_versions"');
    await queryRunner.query('DROP FUNCTION "reject_showcase_version_update"()');
    await queryRunner.query('DROP INDEX "IDX_demo_showcase_copies_owner_state"');
    await queryRunner.query('DROP TABLE "demo_showcase_copies"');
    await queryRunner.query('DROP TABLE "showcase_publish_idempotency"');
    await queryRunner.query('DROP TABLE "showcase_publication"');
    await queryRunner.query('DROP INDEX "IDX_showcase_files_version_name"');
    await queryRunner.query('DROP TABLE "showcase_files"');
    await queryRunner.query('DROP TABLE "showcase_versions"');
  }
}
