import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD "offloadedAt" timestamp with time zone;`.execute(db);
  // Offloaded assets are a small slice of the library but every serve path and
  // the cache-cleanup sweep filters on them, so the index is partial.
  await sql`CREATE INDEX "asset_offloadedAt_idx" ON "asset" ("offloadedAt") WHERE "offloadedAt" IS NOT NULL;`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_offloadedAt_idx";`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "offloadedAt";`.execute(db);
}
