import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChangeSetOperationPathIndex1710000012000 implements MigrationInterface {
  public readonly name = 'AddChangeSetOperationPathIndex1710000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "ai_run_change_sets" ADD COLUMN "operation_paths" text[] NOT NULL DEFAULT ARRAY[]::text[]');
    await queryRunner.query(`UPDATE "ai_run_change_sets" AS change_set
      SET "operation_paths" = COALESCE((
        SELECT array_agg(DISTINCT path_value)
        FROM jsonb_array_elements(change_set."operations") AS operation(item)
        CROSS JOIN LATERAL (VALUES (operation.item->>'path'), (operation.item->>'destinationPath')) AS paths(path_value)
        WHERE path_value IS NOT NULL
      ), ARRAY[]::text[])`);
    await queryRunner.query('CREATE INDEX "IDX_ai_run_change_sets_operation_paths" ON "ai_run_change_sets" USING GIN ("operation_paths")');
    await queryRunner.query('CREATE INDEX "IDX_ai_run_change_sets_owner_project_created" ON "ai_run_change_sets" ("owner_id", "project_id", "created_at" DESC, "id" ASC)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_ai_run_change_sets_owner_project_created"');
    await queryRunner.query('DROP INDEX "IDX_ai_run_change_sets_operation_paths"');
    await queryRunner.query('ALTER TABLE "ai_run_change_sets" DROP COLUMN "operation_paths"');
  }
}
