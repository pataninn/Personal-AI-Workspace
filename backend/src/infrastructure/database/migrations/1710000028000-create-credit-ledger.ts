import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates integer credit limits, usage windows, and idempotent per-provider-call reservations. */
export class CreateCreditLedger1710000028000 implements MigrationInterface {
  public readonly name = 'CreateCreditLedger1710000028000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "account_limits" (
        "owner_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "daily_credit_limit_units" bigint NULL CHECK ("daily_credit_limit_units" IS NULL OR "daily_credit_limit_units" >= 0),
        "lifetime_credit_limit_units" bigint NULL CHECK ("lifetime_credit_limit_units" IS NULL OR "lifetime_credit_limit_units" >= 0),
        "credit_timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
        "pending_credit_timezone" text NULL,
        "timezone_effective_at" timestamptz NULL,
        "timezone_started_at" timestamptz NULL,
        "max_concurrent_inference_calls" integer NOT NULL DEFAULT 1 CHECK ("max_concurrent_inference_calls" BETWEEN 1 AND 32),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_account_limits_timezone_change" CHECK (("pending_credit_timezone" IS NULL) = ("timezone_effective_at" IS NULL))
      )
    `);
    await queryRunner.query(`
      INSERT INTO "account_limits" ("owner_id")
      SELECT "id" FROM "users"
      ON CONFLICT ("owner_id") DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_runtime_policy" (
        "id" smallint PRIMARY KEY CHECK ("id" = 1),
        "inference_paused" boolean NOT NULL DEFAULT true,
        "demo_daily_limit_units" bigint NULL CHECK ("demo_daily_limit_units" IS NULL OR "demo_daily_limit_units" >= 0),
        "demo_campaign_limit_units" bigint NULL CHECK ("demo_campaign_limit_units" IS NULL OR "demo_campaign_limit_units" >= 0),
        "demo_campaign_id" text NULL,
        "demo_max_concurrent_calls" integer NOT NULL DEFAULT 1 CHECK ("demo_max_concurrent_calls" BETWEEN 1 AND 32),
        "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_credit_runtime_policy_demo_campaign" CHECK (
          ("demo_campaign_id" IS NULL AND "demo_campaign_limit_units" IS NULL)
          OR ("demo_campaign_id" IS NOT NULL AND "demo_campaign_limit_units" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      INSERT INTO "credit_runtime_policy" ("id", "inference_paused") VALUES (1, true)
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_account_totals" (
        "owner_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "settled_units" bigint NOT NULL DEFAULT 0 CHECK ("settled_units" >= 0),
        "reserved_units" bigint NOT NULL DEFAULT 0 CHECK ("reserved_units" >= 0),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_account_daily_windows" (
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "timezone_name" text NOT NULL,
        "settled_units" bigint NOT NULL DEFAULT 0 CHECK ("settled_units" >= 0),
        "reserved_units" bigint NOT NULL DEFAULT 0 CHECK ("reserved_units" >= 0),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_account_daily_windows" PRIMARY KEY ("owner_id", "window_start"),
        CONSTRAINT "CHK_credit_account_daily_window_bounds" CHECK ("window_end" > "window_start")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_demo_daily_windows" (
        "window_start" timestamptz PRIMARY KEY,
        "window_end" timestamptz NOT NULL,
        "settled_units" bigint NOT NULL DEFAULT 0 CHECK ("settled_units" >= 0),
        "reserved_units" bigint NOT NULL DEFAULT 0 CHECK ("reserved_units" >= 0),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_credit_demo_daily_window_bounds" CHECK ("window_end" > "window_start")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_demo_campaign_usage" (
        "campaign_id" text PRIMARY KEY,
        "settled_units" bigint NOT NULL DEFAULT 0 CHECK ("settled_units" >= 0),
        "reserved_units" bigint NOT NULL DEFAULT 0 CHECK ("reserved_units" >= 0),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_provider_run_budgets" (
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "source_kind" text NOT NULL CHECK ("source_kind" IN ('ai_run', 'home_turn')),
        "source_id" uuid NOT NULL,
        "max_attempts" integer NOT NULL CHECK ("max_attempts" BETWEEN 1 AND 32),
        "admitted_attempts" integer NOT NULL DEFAULT 0 CHECK ("admitted_attempts" >= 0 AND "admitted_attempts" <= "max_attempts"),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_provider_run_budgets" PRIMARY KEY ("owner_id", "source_kind", "source_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "credit_provider_call_reservations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "account_kind" text NOT NULL CHECK ("account_kind" IN ('regular', 'demo')),
        "source_kind" text NOT NULL CHECK ("source_kind" IN ('ai_run', 'home_turn')),
        "source_id" uuid NOT NULL,
        "call_id" text NOT NULL,
        "attempt_id" text NOT NULL,
        "provider_profile" text NOT NULL,
        "provider_model" text NOT NULL,
        "price_version" text NOT NULL,
        "input_units_per_million_tokens" bigint NOT NULL CHECK ("input_units_per_million_tokens" > 0),
        "output_units_per_million_tokens" bigint NOT NULL CHECK ("output_units_per_million_tokens" > 0),
        "input_bounder_version" text NOT NULL,
        "max_input_tokens" bigint NOT NULL CHECK ("max_input_tokens" > 0),
        "max_output_tokens" bigint NOT NULL CHECK ("max_output_tokens" > 0),
        "reserved_units" bigint NOT NULL CHECK ("reserved_units" > 0),
        "account_window_start" timestamptz NOT NULL,
        "demo_window_start" timestamptz NULL,
        "demo_campaign_id" text NULL,
        "status" text NOT NULL CHECK ("status" IN ('in_flight', 'unknown', 'settled', 'released', 'over_bound')),
        "unknown_reason" text NULL,
        "actual_input_tokens" bigint NULL CHECK ("actual_input_tokens" IS NULL OR "actual_input_tokens" >= 0),
        "actual_output_tokens" bigint NULL CHECK ("actual_output_tokens" IS NULL OR "actual_output_tokens" >= 0),
        "charged_units" bigint NULL CHECK ("charged_units" IS NULL OR "charged_units" >= 0),
        "reserved_at" timestamptz NOT NULL DEFAULT now(),
        "settled_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_credit_provider_call_attempt" UNIQUE ("owner_id", "source_kind", "source_id", "call_id", "attempt_id"),
        CONSTRAINT "CHK_credit_provider_call_demo_scope" CHECK (
          ("account_kind" = 'demo' AND "demo_window_start" IS NOT NULL AND "demo_campaign_id" IS NOT NULL)
          OR ("account_kind" = 'regular' AND "demo_window_start" IS NULL AND "demo_campaign_id" IS NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX "IDX_credit_provider_call_reservations_owner_status" ON "credit_provider_call_reservations" ("owner_id", "status")');
    await queryRunner.query(`
      CREATE TABLE "credit_usage_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "reservation_id" uuid NOT NULL UNIQUE REFERENCES "credit_provider_call_reservations"("id") ON DELETE RESTRICT,
        "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "source_kind" text NOT NULL CHECK ("source_kind" IN ('ai_run', 'home_turn')),
        "source_id" uuid NOT NULL,
        "call_id" text NOT NULL,
        "attempt_id" text NOT NULL,
        "input_tokens" bigint NOT NULL CHECK ("input_tokens" >= 0),
        "output_tokens" bigint NOT NULL CHECK ("output_tokens" >= 0),
        "total_tokens" bigint NOT NULL CHECK ("total_tokens" = "input_tokens" + "output_tokens"),
        "price_version" text NOT NULL,
        "input_units_per_million_tokens" bigint NOT NULL CHECK ("input_units_per_million_tokens" > 0),
        "output_units_per_million_tokens" bigint NOT NULL CHECK ("output_units_per_million_tokens" > 0),
        "charged_units" bigint NOT NULL CHECK ("charged_units" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_credit_usage_call_attempt" UNIQUE ("owner_id", "source_kind", "source_id", "call_id", "attempt_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: readonly { has_usage: boolean; has_reservations: boolean; changed_limits: boolean; has_counters: boolean; changed_policy: boolean }[] = await queryRunner.query(`
      SELECT EXISTS (SELECT 1 FROM "credit_usage_entries") AS "has_usage",
             EXISTS (SELECT 1 FROM "credit_provider_call_reservations") AS "has_reservations",
             EXISTS (SELECT 1 FROM "account_limits" WHERE "daily_credit_limit_units" IS NOT NULL OR "lifetime_credit_limit_units" IS NOT NULL OR "credit_timezone" <> 'Asia/Shanghai' OR "pending_credit_timezone" IS NOT NULL OR "timezone_effective_at" IS NOT NULL OR "timezone_started_at" IS NOT NULL OR "max_concurrent_inference_calls" <> 1) AS "changed_limits",
             EXISTS (SELECT 1 FROM "credit_account_totals" WHERE "settled_units" <> 0 OR "reserved_units" <> 0) AS "has_counters",
             EXISTS (SELECT 1 FROM "credit_runtime_policy" WHERE "inference_paused" IS DISTINCT FROM true OR "demo_daily_limit_units" IS NOT NULL OR "demo_campaign_limit_units" IS NOT NULL OR "demo_campaign_id" IS NOT NULL OR "demo_max_concurrent_calls" <> 1 OR "revision" <> 1) AS "changed_policy"
    `);
    if (rows[0]?.has_usage || rows[0]?.has_reservations || rows[0]?.changed_limits || rows[0]?.has_counters || rows[0]?.changed_policy) {
      throw new Error('Credit ledger rollback is blocked after limits, provider reservations, or usage have been written.');
    }
    await queryRunner.query('DROP TABLE "credit_usage_entries"');
    await queryRunner.query('DROP INDEX "IDX_credit_provider_call_reservations_owner_status"');
    await queryRunner.query('DROP TABLE "credit_provider_call_reservations"');
    await queryRunner.query('DROP TABLE "credit_provider_run_budgets"');
    await queryRunner.query('DROP TABLE "credit_demo_campaign_usage"');
    await queryRunner.query('DROP TABLE "credit_demo_daily_windows"');
    await queryRunner.query('DROP TABLE "credit_account_daily_windows"');
    await queryRunner.query('DROP TABLE "credit_account_totals"');
    await queryRunner.query('DROP TABLE "credit_runtime_policy"');
    await queryRunner.query('DROP TABLE "account_limits"');
  }
}
