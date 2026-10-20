import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores private temporary export lifecycle metadata and exact cleanup references. */
export class CreateWorkspaceExports1710000040000 implements MigrationInterface {
  public readonly name = 'CreateWorkspaceExports1710000040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workspace_exports" (
        "id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "workspace_id" uuid NOT NULL,
        "state" text NOT NULL CHECK ("state" IN ('building','ready','failed','unavailable','expired')),
        "idempotency_key_digest" text NOT NULL CHECK ("idempotency_key_digest" ~ '^[0-9a-f]{64}$'),
        "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
        "demo_cleanup_generation" uuid NULL,
        "builder_process_id" integer NULL,
        "builder_start_ticks" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "expires_at" timestamptz NULL,
        "byte_count" integer NULL,
        CONSTRAINT "PK_workspace_exports" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workspace_exports_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_workspace_exports_workspace" FOREIGN KEY ("owner_id", "workspace_id") REFERENCES "projects"("owner_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_workspace_exports_owner_key" UNIQUE ("owner_id", "idempotency_key_digest"),
        CONSTRAINT "CHK_workspace_exports_builder_identity" CHECK (("builder_process_id" IS NULL) = ("builder_start_ticks" IS NULL)),
        CONSTRAINT "CHK_workspace_exports_ready_metadata" CHECK ("state" <> 'ready' OR ("expires_at" IS NOT NULL AND "byte_count" IS NOT NULL)),
        CONSTRAINT "CHK_workspace_exports_build_identity" CHECK ("state" <> 'building' OR "builder_process_id" IS NOT NULL)
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_workspace_exports_owner_state_expiry" ON "workspace_exports" ("owner_id", "state", "expires_at")');
    await queryRunner.query('CREATE INDEX "IDX_workspace_exports_workspace" ON "workspace_exports" ("owner_id", "workspace_id", "state")');
    await queryRunner.query(`ALTER TABLE "project_removal_jobs" ADD COLUMN "export_ids" jsonb NOT NULL DEFAULT '[]'::jsonb
      CONSTRAINT "CHK_project_removal_jobs_export_ids" CHECK (jsonb_typeof("export_ids") = 'array')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_exports: boolean; readonly has_removal_ids: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "workspace_exports") AS "has_exports",
        EXISTS (SELECT 1 FROM "project_removal_jobs" WHERE "export_ids" <> '[]'::jsonb) AS "has_removal_ids"
    `);
    if (rows[0]?.has_exports || rows[0]?.has_removal_ids) {
      throw new Error('Workspace export rollback is blocked while exports or removal references exist.');
    }
    await queryRunner.query('ALTER TABLE "project_removal_jobs" DROP CONSTRAINT "CHK_project_removal_jobs_export_ids", DROP COLUMN "export_ids"');
    await queryRunner.query('DROP INDEX "IDX_workspace_exports_workspace"');
    await queryRunner.query('DROP INDEX "IDX_workspace_exports_owner_state_expiry"');
    await queryRunner.query('DROP TABLE "workspace_exports"');
  }
}
