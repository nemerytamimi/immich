import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, SelectQueryBuilder, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetFileType, AssetVisibility, StorageTransferScopeType, StorageTransferStatus } from 'src/enum';
import { DB } from 'src/schema';
import {
  StorageTargetObjectTable,
  StorageTargetTable,
  StorageTargetTransferTable,
} from 'src/schema/tables/storage-target.table';
import { StorageTransferScope } from 'src/types';

@Injectable()
export class StorageTargetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [] })
  getAll() {
    return this.db.selectFrom('storage_target').selectAll('storage_target').orderBy('name asc').execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('storage_target').selectAll('storage_target').where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByName(name: string) {
    return this.db.selectFrom('storage_target').selectAll('storage_target').where('name', '=', name).executeTakeFirst();
  }

  create(dto: Insertable<StorageTargetTable>) {
    return this.db.insertInto('storage_target').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<StorageTargetTable>) {
    return this.db.updateTable('storage_target').set(dto).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  async delete(id: string) {
    await this.db.deleteFrom('storage_target').where('id', '=', id).execute();
  }

  // -- transfers --

  createTransfer(dto: Insertable<StorageTargetTransferTable>) {
    return this.db.insertInto('storage_target_transfer').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getTransfer(id: string) {
    return this.db
      .selectFrom('storage_target_transfer')
      .selectAll('storage_target_transfer')
      .where('id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getTransfers(targetId: string) {
    return this.db
      .selectFrom('storage_target_transfer')
      .selectAll('storage_target_transfer')
      .where('targetId', '=', targetId)
      .orderBy('createdAt desc')
      .limit(100)
      .execute();
  }

  updateTransfer(id: string, dto: Updateable<StorageTargetTransferTable>) {
    return this.db
      .updateTable('storage_target_transfer')
      .set(dto)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Atomically bump the progress counters so concurrent workers do not clobber each other,
   * and close the transfer out once every queued item has reported back.
   *
   * `totalCount` is only known after the whole stream has been queued, so it stays
   * at zero while jobs are still going out. Workers must not close the transfer
   * during that window -- the first one to finish would otherwise see `1 >= 0` and
   * mark a still-running transfer complete. The queueing job reconciles once the
   * real total is written.
   */
  async incrementTransferProgress(id: string, { completed = 0, failed = 0 }: { completed?: number; failed?: number }) {
    const transfer = await this.db
      .updateTable('storage_target_transfer')
      .set((eb) => ({
        completedCount: eb('completedCount', '+', completed),
        failedCount: eb('failedCount', '+', failed),
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (
      transfer.status === StorageTransferStatus.Running &&
      transfer.totalCount > 0 &&
      transfer.completedCount + transfer.failedCount >= transfer.totalCount
    ) {
      return this.updateTransfer(id, {
        status: transfer.failedCount > 0 ? StorageTransferStatus.Failed : StorageTransferStatus.Completed,
        finishedAt: new Date(),
      });
    }

    return transfer;
  }

  // -- asset enumeration --

  /**
   * Assets eligible for export: owned by the user, not deleted, and physically
   * present locally. External-library and offline assets are excluded because we
   * have no local bytes to upload for them.
   */
  private exportableAssetQuery(ownerId: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isExternal', '=', false)
      .where('asset.isOffline', '=', false)
      .where('asset.visibility', '!=', AssetVisibility.Hidden);
  }

  /** Narrow an asset query to the transfer's scope. Shared by every direction. */
  private scoped<T extends SelectQueryBuilder<DB, 'asset', { id: string }>>(query: T, scope: StorageTransferScope): T {
    if (scope.type === StorageTransferScopeType.Assets) {
      return query.where('asset.id', 'in', scope.assetIds) as T;
    }

    if (scope.type === StorageTransferScopeType.Albums) {
      return query.where('asset.id', 'in', (eb) =>
        eb.selectFrom('album_asset').select('album_asset.assetId').where('album_asset.albumId', 'in', scope.albumIds),
      ) as T;
    }

    return query;
  }

  @GenerateSql({ params: [DummyValue.UUID, { type: StorageTransferScopeType.All }], stream: true })
  streamAssetsForExport(ownerId: string, scope: StorageTransferScope) {
    return this.scoped(this.exportableAssetQuery(ownerId), scope).stream();
  }

  /**
   * Assets eligible to have their local original dropped. On top of the export
   * rules, an asset must already be offloadable *without* the original: its
   * thumbnail and preview have to exist locally, otherwise offloading would leave
   * a blank tile in the timeline, which is exactly what this feature promises not
   * to do. Assets already offloaded are skipped so re-running is cheap.
   */
  @GenerateSql({ params: [DummyValue.UUID, { type: StorageTransferScopeType.All }], stream: true })
  streamAssetsForOffload(ownerId: string, scope: StorageTransferScope) {
    return this.scoped(this.exportableAssetQuery(ownerId), scope)
      .where('asset.offloadedAt', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .select('asset_file.id')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Thumbnail),
        ),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .select('asset_file.id')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .stream();
  }

  /** The inverse of {@link streamAssetsForOffload}: assets whose bytes are remote-only. */
  @GenerateSql({ params: [DummyValue.UUID, { type: StorageTransferScopeType.All }], stream: true })
  streamAssetsForRestore(ownerId: string, scope: StorageTransferScope) {
    return this.scoped(
      this.db
        .selectFrom('asset')
        .select(['asset.id'])
        .where('asset.ownerId', '=', ownerId)
        .where('asset.deletedAt', 'is', null)
        .where('asset.offloadedAt', 'is not', null),
      scope,
    ).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getAssetForExport(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.checksum',
        'asset.type',
        'asset.offloadedAt',
        'asset_exif.fileSizeInByte',
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  // -- offload --

  /**
   * Where an offloaded asset's bytes actually live. Disabled targets are excluded
   * so an admin can take a target offline without the serve path hammering it;
   * the asset then reads as unavailable rather than hanging.
   *
   * An asset can sit on more than one target (exported to a backup, then
   * offloaded to another). The most recently synced enabled target wins, which
   * keeps the choice deterministic.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getOffloadLocation(assetId: string) {
    return this.db
      .selectFrom('storage_target_object')
      .innerJoin('storage_target', 'storage_target.id', 'storage_target_object.targetId')
      .select([
        'storage_target.id',
        'storage_target.updatedAt',
        'storage_target.config',
        'storage_target.secret',
        'storage_target.name',
        'storage_target_object.remoteKey',
        'storage_target_object.size',
      ])
      .where('storage_target_object.assetId', '=', assetId)
      .where('storage_target.isEnabled', '=', true)
      .orderBy('storage_target_object.syncedAt desc')
      .executeTakeFirst();
  }

  async setOffloadedAt(assetId: string, offloadedAt: Date | null) {
    await this.db.updateTable('asset').set({ offloadedAt }).where('id', '=', assetId).execute();
  }

  /**
   * Guards target deletion: the ledger cascades away with the target, so deleting
   * one that still holds the only copy of an original would strand those assets.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async countOffloadedAssets(targetId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('storage_target_object')
      .innerJoin('asset', 'asset.id', 'storage_target_object.assetId')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('storage_target_object.targetId', '=', targetId)
      .where('asset.offloadedAt', 'is not', null)
      .executeTakeFirstOrThrow();

    return Number(count);
  }

  async deleteObject(targetId: string, remoteKey: string) {
    await this.db
      .deleteFrom('storage_target_object')
      .where('targetId', '=', targetId)
      .where('remoteKey', '=', remoteKey)
      .execute();
  }

  // -- object ledger --

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getObjectByAsset(targetId: string, assetId: string) {
    return this.db
      .selectFrom('storage_target_object')
      .selectAll('storage_target_object')
      .where('targetId', '=', targetId)
      .where('assetId', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async filterNewRemoteKeys(targetId: string, remoteKeys: string[]): Promise<string[]> {
    if (remoteKeys.length === 0) {
      return [];
    }

    const known = await this.db
      .selectFrom('storage_target_object')
      .select('remoteKey')
      .where('targetId', '=', targetId)
      .where('remoteKey', 'in', remoteKeys)
      .execute();

    const knownKeys = new Set(known.map(({ remoteKey }) => remoteKey));
    return remoteKeys.filter((key) => !knownKeys.has(key));
  }

  upsertObject(dto: Insertable<StorageTargetObjectTable>) {
    return this.db
      .insertInto('storage_target_object')
      .values(dto)
      .onConflict((oc) =>
        oc.columns(['targetId', 'remoteKey']).doUpdateSet({
          assetId: (eb) => eb.ref('excluded.assetId'),
          size: (eb) => eb.ref('excluded.size'),
          checksum: (eb) => eb.ref('excluded.checksum'),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
