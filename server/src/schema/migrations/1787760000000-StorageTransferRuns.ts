import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "storage_target_transfer" ADD "runId" uuid;`.execute(db);
  await sql`ALTER TABLE "storage_target_transfer" ADD "skippedCount" integer NOT NULL DEFAULT 0;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "storage_target_transfer" DROP COLUMN "skippedCount";`.execute(db);
  await sql`ALTER TABLE "storage_target_transfer" DROP COLUMN "runId";`.execute(db);
}
