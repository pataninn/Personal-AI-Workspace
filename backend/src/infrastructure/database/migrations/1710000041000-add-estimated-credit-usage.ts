import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEstimatedCreditUsage1710000041000 implements MigrationInterface {
  public readonly name = 'AddEstimatedCreditUsage1710000041000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "credit_usage_entries" ADD COLUMN "is_estimated" boolean NOT NULL DEFAULT false');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly exists: boolean }[] = await queryRunner.query('SELECT EXISTS (SELECT 1 FROM "credit_usage_entries" WHERE "is_estimated") AS "exists"');
    if (rows[0]?.exists) throw new Error('Estimated usage history must retain its provenance.');
    await queryRunner.query('ALTER TABLE "credit_usage_entries" DROP COLUMN "is_estimated"');
  }
}
