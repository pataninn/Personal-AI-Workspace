import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores bounded task revision references observed by a fenced Home occurrence. */
export class AddAutomationTaskSources1710000039000 implements MigrationInterface {
  public readonly name = 'AddAutomationTaskSources1710000039000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "automation_occurrences"
        ADD COLUMN "task_source_revisions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD CONSTRAINT "CHK_automation_occurrences_task_sources" CHECK (
          jsonb_typeof("task_source_revisions") = 'array'
          AND jsonb_array_length("task_source_revisions") <= 256
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly has_sources: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM "automation_occurrences"
        WHERE "task_source_revisions" <> '[]'::jsonb
      ) AS "has_sources"
    `);
    if (rows[0]?.has_sources) {
      throw new Error('Automation task-source rollback is blocked while source revisions exist.');
    }
    await queryRunner.query('ALTER TABLE "automation_occurrences" DROP CONSTRAINT "CHK_automation_occurrences_task_sources", DROP COLUMN "task_source_revisions"');
  }
}
