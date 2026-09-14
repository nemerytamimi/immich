import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "storage_target_transfer_item" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "transferId" uuid NOT NULL,
  "itemKey" character varying NOT NULL,
  "assetId" uuid,
  "remoteKey" character varying,
  "fileName" character varying,
  "size" bigint,
  "attempts" integer NOT NULL DEFAULT 1,
  "error" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "storage_target_transfer_item_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "storage_target_transfer" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "storage_target_transfer_item_transferId_itemKey_uq" UNIQUE ("transferId", "itemKey"),
  CONSTRAINT "storage_target_transfer_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "storage_target_transfer_item";`.execute(db);
}
