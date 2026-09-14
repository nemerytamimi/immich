import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "sync_node_user" ADD "forceSyncOffloaded" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "sync_node_user" DROP COLUMN "forceSyncOffloaded";`.execute(db);
}
