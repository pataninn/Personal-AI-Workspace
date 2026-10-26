import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Retains runtime-only disposal evidence independently of uncertain provider spending. */
export class RecordHomeRuntimeDisposal1710000043000 implements MigrationInterface {
  public readonly name = 'RecordHomeRuntimeDisposal1710000043000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "home_turns" ADD COLUMN "runtime_disposed_at" timestamptz NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const result: readonly { readonly exists: boolean }[] = await queryRunner.query(
      'SELECT EXISTS (SELECT 1 FROM "home_turns" WHERE "runtime_disposed_at" IS NOT NULL) AS "exists"');
    if (result[0]?.exists) throw new Error('Home runtime disposal evidence must retain its provenance.');
    await queryRunner.query('ALTER TABLE "home_turns" DROP COLUMN "runtime_disposed_at"');
  }
}
