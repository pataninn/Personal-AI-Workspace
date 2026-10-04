import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds calendar scheduling and bounded single-tier checklists. */
export class AddTaskPlanningFields1710000016000 implements MigrationInterface {
  public readonly name = 'AddTaskPlanningFields1710000016000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "project_task_importance" AS ENUM ('low', 'medium', 'high', 'urgent')`);
    await queryRunner.query(`ALTER TABLE "project_tasks"
      ADD COLUMN "importance" "project_task_importance" NOT NULL DEFAULT 'medium',
      ADD COLUMN "deadline" date NULL,
      ADD COLUMN "subtasks" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT "CHK_project_tasks_subtasks_array" CHECK (jsonb_typeof("subtasks") = 'array' AND jsonb_array_length("subtasks") <= 50)`);
    await queryRunner.query(`ALTER TABLE "project_task_suggestions"
      ADD COLUMN "subtasks" jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT "CHK_project_task_suggestions_subtasks_array" CHECK (jsonb_typeof("subtasks") = 'array' AND jsonb_array_length("subtasks") <= 50)`);
    await queryRunner.query(`CREATE INDEX "IDX_project_tasks_owner_open_deadline_importance"
      ON "project_tasks" ("owner_id", "deadline" ASC NULLS LAST, "importance" DESC, "updated_at" DESC, "id")
      WHERE "status" IN ('todo', 'in_progress', 'blocked')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_project_tasks_owner_open_deadline_importance"');
    await queryRunner.query('ALTER TABLE "project_task_suggestions" DROP CONSTRAINT "CHK_project_task_suggestions_subtasks_array", DROP COLUMN "subtasks"');
    await queryRunner.query('ALTER TABLE "project_tasks" DROP CONSTRAINT "CHK_project_tasks_subtasks_array", DROP COLUMN "subtasks", DROP COLUMN "deadline", DROP COLUMN "importance"');
    await queryRunner.query('DROP TYPE "project_task_importance"');
  }
}
