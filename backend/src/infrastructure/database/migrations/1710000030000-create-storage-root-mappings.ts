import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Retains immutable trusted locators after a project row is removed. */
export class CreateStorageRootMappings1710000030000 implements MigrationInterface {
  public readonly name = 'CreateStorageRootMappings1710000030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_removal_jobs"
      ADD COLUMN "owner_id" uuid NULL,
      ADD COLUMN "storage_root_key" text NULL CHECK ("storage_root_key" IS NULL OR length("storage_root_key") BETWEEN 1 AND 2048)`);
    await queryRunner.query(`UPDATE "project_removal_jobs" j
      SET "owner_id" = p."owner_id", "storage_root_key" = p."relative_root_key"
      FROM "projects" p WHERE p."id" = j."project_id"`);
    const unmappedJobs: readonly { readonly has_unmapped_jobs: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "project_removal_jobs" WHERE "owner_id" IS NULL) AS "has_unmapped_jobs"
    `);
    if (unmappedJobs[0]?.has_unmapped_jobs) {
      throw new Error('Storage root migration is blocked by a pending project-removal job without a recoverable owner mapping.');
    }
    await queryRunner.query(`ALTER TABLE "project_removal_jobs"
      ALTER COLUMN "owner_id" SET NOT NULL,
      ADD CONSTRAINT "FK_project_removal_jobs_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT`);
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "projects" WHERE "relative_root" IS NOT NULL
          GROUP BY "owner_id", "relative_root_key" HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION 'storage root mappings require unique persisted owner/root keys';
        END IF;
      END $$`);
    await queryRunner.query(`
      CREATE TABLE "storage_root_mappings" (
        "owner_id" uuid NOT NULL,
        "project_id" uuid NULL,
        "locator_project_id" uuid NOT NULL,
        "root_key" text NOT NULL CHECK (length("root_key") BETWEEN 1 AND 2048),
        "storage_kind" text NOT NULL CHECK ("storage_kind" IN ('legacy', 'managed')),
        "relative_root" text NOT NULL CHECK (length("relative_root") BETWEEN 1 AND 2048),
        "state" text NOT NULL CHECK ("state" IN ('active', 'retained')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_root_mappings" PRIMARY KEY ("owner_id", "root_key"),
        CONSTRAINT "FK_storage_root_mappings_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_storage_root_mappings_project_owner" FOREIGN KEY ("owner_id", "project_id") REFERENCES "projects"("owner_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_storage_root_mappings_lifecycle" CHECK (
          ("state" = 'active' AND "project_id" IS NOT NULL AND "project_id" = "locator_project_id")
          OR ("state" = 'retained' AND "project_id" IS NULL)
        ),
        CONSTRAINT "CHK_storage_root_mappings_managed_locator" CHECK (
          "storage_kind" <> 'managed' OR "relative_root" = 'projects/' || "locator_project_id"::text
        )
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_storage_root_mappings_owner_project" ON "storage_root_mappings" ("owner_id", "project_id") WHERE "project_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_storage_root_mappings_state" ON "storage_root_mappings" ("owner_id", "state")`);
    await queryRunner.query(`
      INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
      SELECT "owner_id", "id", "id", "relative_root_key", "storage_kind", "relative_root", 'active'
      FROM "projects"
      WHERE "relative_root" IS NOT NULL AND "relative_root_key" IS NOT NULL AND "storage_kind" IS NOT NULL
      ORDER BY "owner_id", "relative_root_key"
    `);
    await queryRunner.query(`CREATE FUNCTION "guard_storage_root_mapping"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW."state" = 'active' AND NEW."project_id" IS NOT NULL AND EXISTS (
            SELECT 1 FROM "projects" p
            WHERE p."owner_id" = NEW."owner_id" AND p."id" = NEW."project_id"
              AND p."relative_root_key" = NEW."root_key"
              AND p."relative_root" = NEW."relative_root"
              AND p."storage_kind" = NEW."storage_kind"
              AND NEW."locator_project_id" = NEW."project_id"
          ) THEN
            RETURN NEW;
          END IF;
          IF NEW."state" = 'retained' AND NEW."project_id" IS NULL AND NEW."storage_kind" = 'managed'
            AND NEW."relative_root" = 'projects/' || NEW."locator_project_id"::text
            AND NEW."root_key" = lower(NEW."relative_root")
            AND current_setting('app.storage_retained_orphan_registration', true) =
              (NEW."owner_id"::text || ':' || NEW."locator_project_id"::text || ':' || NEW."root_key")
            AND NOT EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = NEW."locator_project_id") THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'storage root mappings must match an attached project or verified managed orphan';
        END IF;
        IF TG_OP = 'DELETE' THEN
          IF OLD."state" <> 'retained' OR current_setting('app.storage_root_removal_verified', true) IS DISTINCT FROM (OLD."owner_id"::text || ':' || OLD."root_key") THEN
            RAISE EXCEPTION 'a retained storage root may be removed only after verified filesystem deletion';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
          OR NEW."root_key" IS DISTINCT FROM OLD."root_key"
          OR NEW."locator_project_id" IS DISTINCT FROM OLD."locator_project_id"
          OR NEW."storage_kind" IS DISTINCT FROM OLD."storage_kind"
          OR NEW."relative_root" IS DISTINCT FROM OLD."relative_root"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
          RAISE EXCEPTION 'storage root mapping identity is immutable';
        END IF;
        IF OLD."state" = 'active' AND NEW."state" = 'retained'
          AND OLD."project_id" IS NOT NULL AND NEW."project_id" IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW."state" IS DISTINCT FROM OLD."state" OR NEW."project_id" IS DISTINCT FROM OLD."project_id" THEN
          RAISE EXCEPTION 'storage root mappings may only transition from active to retained';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE TRIGGER "TRG_storage_root_mapping_guard" BEFORE INSERT OR UPDATE OR DELETE ON "storage_root_mappings" FOR EACH ROW EXECUTE FUNCTION "guard_storage_root_mapping"()`);
    await queryRunner.query(`ALTER TABLE "project_removal_jobs"
      ADD CONSTRAINT "FK_project_removal_jobs_storage_root" FOREIGN KEY ("owner_id", "storage_root_key") REFERENCES "storage_root_mappings"("owner_id", "root_key") ON DELETE RESTRICT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_mappings: boolean }[] = await queryRunner.query('SELECT EXISTS (SELECT 1 FROM "storage_root_mappings") AS "has_mappings"');
    if (rows[0]?.has_mappings) throw new Error('Storage root mapping rollback is blocked while any trusted or retained root exists.');
    const jobs: readonly { has_jobs: boolean }[] = await queryRunner.query('SELECT EXISTS (SELECT 1 FROM "project_removal_jobs" WHERE "owner_id" IS NOT NULL) AS "has_jobs"');
    if (jobs[0]?.has_jobs) throw new Error('Storage root mapping rollback is blocked while owner-scoped removal jobs exist.');
    await queryRunner.query('DROP TRIGGER "TRG_storage_root_mapping_guard" ON "storage_root_mappings"');
    await queryRunner.query('DROP FUNCTION "guard_storage_root_mapping"()');
    await queryRunner.query('DROP INDEX "IDX_storage_root_mappings_state"');
    await queryRunner.query('DROP INDEX "UQ_storage_root_mappings_owner_project"');
    await queryRunner.query('DROP TABLE "storage_root_mappings"');
    await queryRunner.query('ALTER TABLE "project_removal_jobs" DROP CONSTRAINT "FK_project_removal_jobs_storage_root", DROP CONSTRAINT "FK_project_removal_jobs_owner", DROP COLUMN "storage_root_key", DROP COLUMN "owner_id"');
  }
}
