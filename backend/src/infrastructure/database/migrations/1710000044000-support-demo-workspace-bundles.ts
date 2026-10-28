import type { MigrationInterface, QueryRunner } from 'typeorm';

/** One admission can provision at most three independently fenced workspace copies. */
export class SupportDemoWorkspaceBundles1710000044000 implements MigrationInterface {
  public readonly name = 'SupportDemoWorkspaceBundles1710000044000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "showcase_publication_workspaces" (
        "position" smallint PRIMARY KEY CHECK ("position" BETWEEN 1 AND 2),
        "version_id" uuid NOT NULL UNIQUE REFERENCES "showcase_versions"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" ADD COLUMN "copy_id" uuid');
    await queryRunner.query('UPDATE "demo_showcase_copies" SET "copy_id" = "admission_id"');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" ALTER COLUMN "copy_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" DROP CONSTRAINT "demo_showcase_copies_pkey"');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" ADD PRIMARY KEY ("copy_id")');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" ADD CONSTRAINT "UQ_demo_copy_identity" UNIQUE ("copy_id", "admission_id", "owner_id")');
    await queryRunner.query('CREATE INDEX "IDX_demo_copy_admission" ON "demo_showcase_copies" ("admission_id")');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" ADD COLUMN "copy_id" uuid');
    await queryRunner.query('UPDATE "demo_copy_effect_receipts" SET "copy_id" = "admission_id"');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" ALTER COLUMN "copy_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" DROP CONSTRAINT "demo_copy_effect_receipts_pkey"');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" ADD PRIMARY KEY ("copy_id")');
    await queryRunner.query(`ALTER TABLE "demo_copy_effect_receipts" ADD CONSTRAINT "FK_demo_effect_copy"
      FOREIGN KEY ("copy_id", "admission_id", "owner_id") REFERENCES "demo_showcase_copies" ("copy_id", "admission_id", "owner_id") ON DELETE RESTRICT`);
    // Existing single-copy callers can continue omitting the new identity.
    await queryRunner.query(`CREATE FUNCTION "default_demo_copy_identity"() RETURNS trigger AS $$
      BEGIN NEW."copy_id" := COALESCE(NEW."copy_id", NEW."admission_id"); RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    for (const table of ['demo_showcase_copies', 'demo_copy_effect_receipts']) {
      await queryRunner.query(`CREATE TRIGGER "TRG_default_demo_copy_identity" BEFORE INSERT ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION "default_demo_copy_identity"()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { readonly occupied: boolean }[] = await queryRunner.query(`SELECT
      EXISTS(SELECT 1 FROM "showcase_publication_workspaces") OR
      EXISTS(SELECT 1 FROM "demo_showcase_copies" WHERE "copy_id" <> "admission_id") AS "occupied"`);
    if (rows[0]?.occupied) throw new Error('Remove bundle publication and additional demo copies before reverting bundle support.');
    for (const table of ['demo_copy_effect_receipts', 'demo_showcase_copies']) {
      await queryRunner.query(`DROP TRIGGER "TRG_default_demo_copy_identity" ON "${table}"`);
    }
    await queryRunner.query('DROP FUNCTION "default_demo_copy_identity"()');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" DROP CONSTRAINT "FK_demo_effect_copy"');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" DROP CONSTRAINT "demo_copy_effect_receipts_pkey"');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" ADD PRIMARY KEY ("admission_id")');
    await queryRunner.query('ALTER TABLE "demo_copy_effect_receipts" DROP COLUMN "copy_id"');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" DROP CONSTRAINT "UQ_demo_copy_identity"');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" DROP CONSTRAINT "demo_showcase_copies_pkey"');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" ADD PRIMARY KEY ("admission_id")');
    await queryRunner.query('ALTER TABLE "demo_showcase_copies" DROP COLUMN "copy_id"');
    await queryRunner.query('DROP INDEX "IDX_demo_copy_admission"');
    await queryRunner.query('DROP TABLE "showcase_publication_workspaces"');
  }
}
