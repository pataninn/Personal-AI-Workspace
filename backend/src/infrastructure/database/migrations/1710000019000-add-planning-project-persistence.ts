import type { MigrationInterface, QueryRunner } from 'typeorm';

function queryRow(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== 'object' || result[0] === null || Array.isArray(result[0])) {
    throw new Error('The planning project migration could not read its rollback safety check.');
  }
  return result[0] as Record<string, unknown>;
}

function readFlag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error('The planning project migration could not read its rollback safety check.');
  }
  return value;
}

export class AddPlanningProjectPersistence1710000019000 implements MigrationInterface {
  public readonly name = 'AddPlanningProjectPersistence1710000019000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects"
      ADD COLUMN "objective" text NULL,
      ALTER COLUMN "relative_root" DROP NOT NULL,
      ALTER COLUMN "relative_root_key" DROP NOT NULL,
      ADD CONSTRAINT "CHK_projects_root_pair" CHECK (
        ("relative_root" IS NULL AND "relative_root_key" IS NULL)
        OR ("relative_root" IS NOT NULL AND "relative_root_key" IS NOT NULL)
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const state = queryRow(await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM "projects" WHERE "relative_root" IS NULL OR "relative_root_key" IS NULL) AS "has_planning_projects",
        EXISTS (SELECT 1 FROM "projects" WHERE "objective" IS NOT NULL) AS "has_project_objectives"
    `));
    if (readFlag(state, 'has_planning_projects') || readFlag(state, 'has_project_objectives')) {
      throw new Error('Cannot revert planning project persistence while rootless projects or objectives exist. Preserve those records before retrying.');
    }

    await queryRunner.query(`ALTER TABLE "projects"
      DROP CONSTRAINT "CHK_projects_root_pair",
      ALTER COLUMN "relative_root" SET NOT NULL,
      ALTER COLUMN "relative_root_key" SET NOT NULL,
      DROP COLUMN "objective"`);
  }
}
