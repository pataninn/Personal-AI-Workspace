import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable cleanup intent survives crashes on either side of database commit. */
export class CreateProjectRemovalJobs1710000017000 implements MigrationInterface {
  public readonly name = 'CreateProjectRemovalJobs1710000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Deliberately no project FK: cleanup must survive deletion of the project.
    await queryRunner.query(`CREATE TABLE "project_removal_jobs" (
      "project_id" uuid PRIMARY KEY,
      "run_ids" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "CHK_project_removal_jobs_run_ids" CHECK (jsonb_typeof("run_ids") = 'array')
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "project_removal_jobs"');
  }
}
