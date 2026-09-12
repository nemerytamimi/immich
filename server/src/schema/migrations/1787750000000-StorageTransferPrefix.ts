import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "storage_target_transfer" ADD "prefix" character varying;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "storage_target_transfer" DROP COLUMN "prefix";`.execute(db);
}
