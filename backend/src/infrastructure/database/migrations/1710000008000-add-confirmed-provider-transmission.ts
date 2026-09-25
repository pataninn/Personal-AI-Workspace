import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConfirmedProviderTransmission1710000008000 implements MigrationInterface {
  public readonly name = 'AddConfirmedProviderTransmission1710000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TYPE "ai_run_provider_transmission" RENAME TO "ai_run_provider_transmission_legacy"');
    await queryRunner.query(`CREATE TYPE "ai_run_provider_transmission" AS ENUM ('not_started', 'not_started_confirmed', 'transmitted_confirmed', 'unknown')`);
    await queryRunner.query('ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" DROP DEFAULT');
    await queryRunner.query('ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" TYPE "ai_run_provider_transmission" USING "provider_transmission"::text::"ai_run_provider_transmission"');
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" SET DEFAULT 'not_started_confirmed'`);
    await queryRunner.query('DROP TYPE "ai_run_provider_transmission_legacy"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('UPDATE "ai_runs" SET "provider_transmission" = \'unknown\' WHERE "provider_transmission" = \'transmitted_confirmed\'');
    await queryRunner.query('ALTER TYPE "ai_run_provider_transmission" RENAME TO "ai_run_provider_transmission_current"');
    await queryRunner.query(`CREATE TYPE "ai_run_provider_transmission" AS ENUM ('not_started', 'not_started_confirmed', 'unknown')`);
    await queryRunner.query('ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" DROP DEFAULT');
    await queryRunner.query('ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" TYPE "ai_run_provider_transmission" USING "provider_transmission"::text::"ai_run_provider_transmission"');
    await queryRunner.query(`ALTER TABLE "ai_runs" ALTER COLUMN "provider_transmission" SET DEFAULT 'not_started_confirmed'`);
    await queryRunner.query('DROP TYPE "ai_run_provider_transmission_current"');
  }
}
