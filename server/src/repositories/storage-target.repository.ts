import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, SelectQueryBuilder, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { StorageTransferScope } from 'src/types.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetVisibility, StorageTransferScopeType, StorageTransferStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  StorageTargetObjectTable,
  StorageTargetTable,
  StorageTargetTransferTable,
} from 'src/schema/tables/storage-target.table.js';

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
   * Update a transfer only while it is still on the given run. A queueing walk
   * that a pause and resume overtook would otherwise write its stale totals over
   * the new run's. Resolves to undefined once the run has moved on.
   */
  updateTransferRun(id: string, runId: string | null | undefined, dto: Updateable<StorageTargetTransferTable>) {
    return this.db
      .updateTable('storage_target_transfer')
      .set(dto)
      .where('id', '=', id)
      .where((eb) => (runId ? eb('runId', '=', runId) : eb('runId', 'is', null)))
      .returningAll()
      .executeTakeFirst();
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
   *
   * Only the run the job belongs to is counted. A job already in flight when its
   * transfer was paused and resumed finishes into nothing rather than into a run
   * that did not queue it. Resolves to undefined in that case.
   */
  async incrementTransferProgress(
    id: string,
    runId: string | null | undefined,
    { completed = 0, failed = 0 }: { completed?: number; failed?: number },
  ) {
    const transfer = await this.db
      .updateTable('storage_target_transfer')
      .set((eb) => ({
        completedCount: eb('completedCount', '+', completed),
        failedCount: eb('failedCount', '+', failed),
      }))
      .where('id', '=', id)
      .where((eb) => (runId ? eb('runId', '=', runId) : eb('runId', 'is', null)))
      .returningAll()
      .executeTakeFirst();

    if (!transfer) {
      return;
    }

    if (
      transfer.status === StorageTransferStatus.Running &&
      transfer.totalCount > 0 &&
      transfer.completedCount + transfer.failedCount >= transfer.totalCount
    ) {
      return this.updateTransferRun(id, runId, {
        status: transfer.failedCount > 0 ? StorageTransferStatus.Failed : StorageTransferStatus.Completed,
        finishedAt: new Date(),
      });
    }

    return transfer;
  }

  /** Remove transfers from the history. Their failure records go with them. */
  async deleteTransfers(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.db.deleteFrom('storage_target_transfer').where('id', 'in', ids).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /** Remove a target's transfers in any of the given statuses from the history. */
  async deleteTransfersByStatus(targetId: string, statuses: StorageTransferStatus[]): Promise<number> {
    const result = await this.db
      .deleteFrom('storage_target_transfer')
      .where('targetId', '=', targetId)
      .where('status', 'in', statuses)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  // -- transfer failures --

  /** Record a failed item, or count another attempt against one that has failed before. */
  async recordTransferFailure(item: Insertable<DB['storage_target_transfer_item']>) {
    await this.db
      .insertInto('storage_target_transfer_item')
      .values(item)
      .onConflict((oc) =>
        oc.columns(['transferId', 'itemKey']).doUpdateSet((eb) => ({
          attempts: eb('storage_target_transfer_item.attempts', '+', 1),
          error: eb.ref('excluded.error'),
          fileName: eb.ref('excluded.fileName'),
          remoteKey: eb.ref('excluded.remoteKey'),
          size: eb.ref('excluded.size'),
          updatedAt: new Date(),
        })),
      )
      .execute();
  }

  /** Forget a failure once its item has gone through. */
  async clearTransferFailure(transferId: string, itemKey: string) {
    await this.db
      .deleteFrom('storage_target_transfer_item')
      .where('transferId', '=', transferId)
      .where('itemKey', '=', itemKey)
      .execute();
  }

  async clearTransferFailures(transferId: string) {
    await this.db.deleteFrom('storage_target_transfer_item').where('transferId', '=', transferId).execute();
  }

  /** One page of a transfer's failures, most recent first. */
  getTransferFailures(transferId: string, { take, skip }: { take: number; skip: number }) {
    return this.db
      .selectFrom('storage_target_transfer_item')
      .selectAll('storage_target_transfer_item')
      .where('transferId', '=', transferId)
      .orderBy('updatedAt desc')
      .limit(take)
      .offset(skip)
      .execute();
  }

  async getTransferFailureTotal(transferId: string): Promise<number> {
    const row = await this.db
      .selectFrom('storage_target_transfer_item')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('transferId', '=', transferId)
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  }

  /** The failures to hand back for another try: the given ones, or all of them. */
  getTransferFailuresForRetry(transferId: string, itemIds?: string[]) {
    return this.db
      .selectFrom('storage_target_transfer_item')
      .selectAll('storage_target_transfer_item')
      .where('transferId', '=', transferId)
      .$if(itemIds !== undefined, (qb) => qb.where('id', 'in', itemIds!))
      .execute();
  }

  /**
   * Take failures back for another try. They come off the failed count, since
   * each one reports again as it finishes, and a transfer that had already closed
   * opens again so that those reports can close it.
   */
  reopenTransferForRetry(id: string, count: number) {
    return this.db
      .updateTable('storage_target_transfer')
      .set((eb) => ({
        status: StorageTransferStatus.Running,
        finishedAt: null,
        error: null,
        failedCount: eb.fn<number>('greatest', [eb('failedCount', '-', count), eb.lit(0)]),
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
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

  /**
   * Offload candidates that {@link streamAssetsForOffload} leaves out only because
   * a thumbnail or preview has not been generated yet. They stay local until one
   * has, and counting them is what stops a run that skipped everything from
   * reading as nothing to do.
   */
  @GenerateSql({ params: [DummyValue.UUID, { type: StorageTransferScopeType.All }] })
  async countAssetsMissingPreviews(ownerId: string, scope: StorageTransferScope): Promise<number> {
    const candidates = this.scoped(this.exportableAssetQuery(ownerId), scope)
      .where('asset.offloadedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Thumbnail),
            ),
          ),
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Preview),
            ),
          ),
        ]),
      );

    const { count } = await this.db
      .selectFrom(candidates.as('candidate'))
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    return Number(count);
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
