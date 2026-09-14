import { Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NODE_SYNC_MAX_ATTEMPTS } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import {
  AssetVisibility,
  ChecksumAlgorithm,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SyncDirection,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { NodeCredentials, RemoteAsset } from 'src/repositories/node-client.repository';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { BaseService } from 'src/services/base.service';
import { INodeSyncAssetJob, INodeSyncPairJob } from 'src/types';
import { updateLockedColumns } from 'src/utils/database';
import { getFilenameExtension } from 'src/utils/file';
import { mimeTypes } from 'src/utils/mime-types';
import { handlePromiseError } from 'src/utils/misc';
import {
  FaceNaming,
  hasMetadataChanges,
  MetadataChanges,
  planFaceNames,
  planMetadataSync,
  SyncedFace,
  SyncedMetadata,
  toSyncedFace,
} from 'src/utils/node-sync-metadata';
import { upsertTags } from 'src/utils/tag';

/** How many local changes one pair run walks through before stopping. */
const PUSH_PAGE_SIZE = 500;
const PULL_PAGE_SIZE = 250;
const RETRY_PAGE_SIZE = 500;
const METADATA_PAGE_SIZE = 500;

type SyncContext = NonNullable<Awaited<ReturnType<SyncEngineService['getContext']>>>;

const asDate = (value: Date | string | null | undefined) => (value ? new Date(value) : null);

const latest = (...dates: Array<Date | null>) => {
  const times = dates.filter((date): date is Date => date !== null).map((date) => date.getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : null;
};

/** Names are matched the way people read them, not byte for byte. */
const isSameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const toRemoteMetadata = (asset: RemoteAsset): SyncedMetadata => {
  const exif = asset.exifInfo ?? {};

  return {
    createdAt: asDate(exif.dateTimeOriginal) ?? asDate(asset.fileCreatedAt),
    modifiedAt: asDate(asset.updatedAt),
    dateTimeOriginal: asDate(exif.dateTimeOriginal),
    timeZone: exif.timeZone ?? null,
    latitude: exif.latitude ?? null,
    longitude: exif.longitude ?? null,
    rating: exif.rating ?? null,
    description: exif.description || null,
    isFavorite: asset.isFavorite,
    visibility:
      (asset.visibility as AssetVisibility | undefined) ??
      (asset.isArchived ? AssetVisibility.Archive : AssetVisibility.Timeline),
    tags: (asset.tags ?? []).map(({ value }) => value),
  };
};

/** A capture time in the zone it was taken in, so the peer keeps the zone as well as the instant. */
const toZonedIso = ({ value, timeZone }: { value: Date; timeZone: string | null }) =>
  (timeZone ? DateTime.fromJSDate(value, { zone: timeZone }).toISO() : null) ?? value.toISOString();

@Injectable()
export class SyncEngineService extends BaseService {
  private syncLock = false;

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig: { nodeSync } }: ArgOf<'ConfigInit'>) {
    // Only one microservices worker should own the schedule, or every replica
    // would kick off the same sync.
    this.syncLock = await this.databaseRepository.tryLock(DatabaseLock.NodeSync);
    if (!this.syncLock) {
      return;
    }

    this.cronRepository.create({
      name: 'nodeSync',
      expression: nodeSync.cronExpression,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.NodeSyncQueueAll, data: {} }), this.logger),
      start: nodeSync.enabled,
    });
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { nodeSync } }: ArgOf<'ConfigUpdate'>) {
    if (!this.syncLock) {
      return;
    }

    this.cronRepository.update({
      name: 'nodeSync',
      expression: nodeSync.cronExpression,
      start: nodeSync.enabled,
    });
  }

  @OnJob({ name: JobName.NodeSyncQueueAll, queue: QueueName.NodeSync })
  async handleQueueAll(): Promise<JobStatus> {
    const pairings = await this.syncNodeRepository.getSyncablePairings();

    for (const { id } of pairings) {
      await this.jobRepository.queue({ name: JobName.NodeSyncPair, data: { pairingId: id } });
    }

    this.logger.log(`Queued ${pairings.length} node sync pairing(s)`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NodeSyncPair, queue: QueueName.NodeSync })
  async handlePair({ pairingId }: INodeSyncPairJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    const { pairing } = context;

    try {
      if (pairing.pushEnabled) {
        await this.push(pairingId);
      }

      if (pairing.pullEnabled) {
        await this.pull(pairingId);
      }

      await this.jobRepository.queue({ name: JobName.NodeSyncAlbums, data: { pairingId } });

      // Anything that failed earlier in this run, or was left over from a previous
      // one, gets another attempt now rather than waiting for the next schedule.
      await this.jobRepository.queue({ name: JobName.NodeSyncRetryFailed, data: { pairingId } });

      await this.syncNodeRepository.updatePairing(pairingId, { lastSyncedAt: new Date(), error: null });
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Sync failed for pairing ${pairingId}: ${error?.message ?? error}`, error?.stack);
      await this.syncNodeRepository.updatePairing(pairingId, { error: error?.message ?? String(error) });
      return JobStatus.Failed;
    }
  }

  /**
   * Local -> remote. Walks local changes in `updateId` order and queues a job per
   * asset, so several transfers run at once under the queue's concurrency rather
   * than one at a time.
   *
   * The cursor advances once a page has been *queued*, not once it has finished.
   * That is safe because every queued item is recorded in the work ledger first,
   * so nothing is forgotten -- and it means one unco-operative asset can no
   * longer pin the cursor and force every later run to re-attempt the same page.
   */
  private async push(pairingId: string): Promise<void> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return;
    }

    const { pairing } = context;
    let cursor = pairing.pushCursor;

    for (;;) {
      const assets = await this.syncNodeRepository.getChangedAssets(pairing.localUserId, cursor, PUSH_PAGE_SIZE);
      if (assets.length === 0) {
        break;
      }

      // Assets with no local bytes are skipped here rather than queued, so they
      // never enter the ledger and never look like outstanding work.
      const transferable = assets.filter((asset) => !asset.isExternal && !asset.isOffline);

      await this.syncNodeRepository.markQueued(
        pairingId,
        SyncDirection.Push,
        transferable.map(({ id }) => id),
      );

      for (const asset of transferable) {
        await this.jobRepository.queue({
          name: JobName.NodeSyncPushAsset,
          data: { pairingId, assetId: asset.id },
        });
      }

      cursor = assets.at(-1)!.updateId;
      await this.syncNodeRepository.updatePairing(pairingId, { pushCursor: cursor });

      if (assets.length < PUSH_PAGE_SIZE) {
        break;
      }
    }
  }

  @OnJob({ name: JobName.NodeSyncPushAsset, queue: QueueName.NodeSync })
  async handlePushAsset({ pairingId, assetId }: INodeSyncAssetJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    const [asset] = await this.syncNodeRepository.getAssetsByIds([assetId]);
    if (!asset) {
      // Deleted outright since being queued; there is nothing left to send.
      await this.syncNodeRepository.markSucceeded(pairingId, SyncDirection.Push, assetId);
      return JobStatus.Skipped;
    }

    try {
      await this.pushOne(context, asset);
      await this.syncNodeRepository.markSucceeded(pairingId, SyncDirection.Push, assetId);
      return JobStatus.Success;
    } catch (error: any) {
      // One difficult asset must not stop the rest. It stays in the ledger and
      // is picked up by the retry pass at the end of the next run.
      const message = error?.message ?? String(error);
      this.logger.warn(`Failed to push ${assetId}, will retry later: ${message}`);
      await this.syncNodeRepository.markFailed(pairingId, SyncDirection.Push, assetId, message);
      return JobStatus.Failed;
    }
  }

  private async pushOne(
    context: SyncContext,
    asset: Awaited<ReturnType<typeof this.syncNodeRepository.getChangedAssets>>[number],
  ): Promise<void> {
    const { pairing, credentials } = context;
    const mapping = await this.syncNodeRepository.getAssetMapping(pairing.id, asset.id);

    if (asset.deletedAt) {
      // Trashed locally. Mirror that on the peer, once.
      if (mapping && !mapping.trashSyncedAt) {
        await this.nodeClientRepository.trashAssets(credentials, [mapping.remoteAssetId]);
        await this.syncNodeRepository.updateAssetMapping(mapping.id, { trashSyncedAt: new Date() });
        this.logger.debug(`Propagated trash of ${asset.id} to ${mapping.remoteAssetId}`);
      }
      return;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return;
    }

    if (mapping) {
      // Already on the peer. Only metadata can have changed.
      if (mapping.metadataUpdateId !== asset.updateId) {
        await this.reconcileMapping(context, mapping);
      }
      return;
    }

    const checksum = asset.checksum.toString('base64');

    // If the peer already holds these exact bytes, adopt its asset rather than
    // uploading a second copy. This is what makes two nodes converge instead of
    // duplicating each other's libraries.
    const existing = await this.nodeClientRepository.bulkUploadCheck(credentials, [{ id: asset.id, checksum }]);
    const duplicate = existing[asset.id];

    if (duplicate?.action === 'reject' && duplicate.assetId) {
      const adopted = await this.syncNodeRepository.upsertAssetMapping({
        nodeUserId: pairing.id,
        localAssetId: asset.id,
        remoteAssetId: duplicate.assetId,
        checksum: asset.checksum,
        origin: 'push-dedupe',
        metadataUpdateId: null,
      });

      // Two copies of the same photo that each lived their own life are exactly
      // where metadata goes missing on one side, so they are compared straight away.
      await this.reconcileMapping(context, adopted);
      return;
    }

    const sidecarPath = `${asset.originalPath}.xmp`;
    const hasSidecar = await this.storageRepository.checkFileExists(sidecarPath);

    const uploaded = await this.nodeClientRepository.uploadAsset(credentials, {
      // Reusing the local id gives the peer a stable per-device identity, so a
      // repeated push is recognised rather than duplicated.
      deviceAssetId: asset.id,
      deviceId: `immich-node-sync`,
      fileCreatedAt: new Date(asset.fileCreatedAt),
      fileModifiedAt: new Date(asset.fileModifiedAt),
      isFavorite: asset.isFavorite,
      filename: asset.originalFileName,
      path: asset.originalPath,
      sidecar: hasSidecar ? { filename: `${asset.originalFileName}.xmp`, path: sidecarPath } : undefined,
    });

    await this.syncNodeRepository.upsertAssetMapping({
      nodeUserId: pairing.id,
      localAssetId: asset.id,
      remoteAssetId: uploaded.id,
      checksum: asset.checksum,
      origin: 'push',
      metadataUpdateId: asset.updateId,
    });
  }

  /**
   * Remote -> local. The peer is queried through its public search API, which
   * filters on `updatedAfter`, so this side advances on a timestamp.
   */
  private async pull(pairingId: string): Promise<void> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return;
    }

    const { pairing, credentials } = context;
    const startedAt = new Date();

    let page = 1;
    for (;;) {
      const { items, nextPage } = await this.nodeClientRepository.searchAssets(credentials, {
        userId: pairing.remoteUserId,
        updatedAfter: pairing.pullCursor ? new Date(pairing.pullCursor) : undefined,
        page,
        size: PULL_PAGE_SIZE,
      });

      if (items.length === 0) {
        break;
      }

      const mappings = await this.syncNodeRepository.getMappingsByRemoteIds(
        pairingId,
        items.map(({ id }) => id),
      );
      const lastCompared = new Map(mappings.map((mapping) => [mapping.remoteAssetId, new Date(mapping.updatedAt)]));

      // Unseen assets are downloaded. One already held here is queued again only if
      // the peer changed it since the two were last compared, and then only its
      // metadata is looked at.
      const outstanding = items.filter((remote) => {
        const comparedAt = lastCompared.get(remote.id);
        return !comparedAt || new Date(remote.updatedAt) > comparedAt;
      });

      await this.syncNodeRepository.markQueued(
        pairingId,
        SyncDirection.Pull,
        outstanding.map(({ id }) => id),
      );

      for (const remote of outstanding) {
        await this.jobRepository.queue({
          name: JobName.NodeSyncPullAsset,
          data: { pairingId, assetId: remote.id },
        });
      }

      if (!nextPage) {
        break;
      }
      page = Number(nextPage);
    }

    // Only advance once the whole page walk succeeded, so a mid-way failure
    // re-examines the same window rather than skipping it.
    await this.syncNodeRepository.updatePairing(pairingId, { pullCursor: startedAt });
  }

  @OnJob({ name: JobName.NodeSyncPullAsset, queue: QueueName.NodeSync })
  async handlePullAsset({ pairingId, assetId }: INodeSyncAssetJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    const { pairing, credentials } = context;

    // Checked here as well as before the walk: pausing a pairing has to stop the
    // downloads already sitting on the queue, not just the ones not yet queued.
    // The push side has always done this; without the same check here, pausing a
    // pull kept transferring for as long as the backlog lasted.
    if (!pairing.pullEnabled) {
      return JobStatus.Skipped;
    }

    const existing = await this.syncNodeRepository.getMappingByRemoteId(pairingId, assetId);
    if (existing) {
      // Already here, so the bytes stay put. What the peer can have changed is the
      // metadata, which is compared instead of downloading the asset again.
      try {
        await this.reconcileMapping(context, existing);
        await this.syncNodeRepository.markSucceeded(pairingId, SyncDirection.Pull, assetId);
        return JobStatus.Success;
      } catch (error: any) {
        const message = error?.message ?? String(error);
        this.logger.warn(`Failed to reconcile metadata for ${assetId}, will retry later: ${message}`);
        await this.syncNodeRepository.markFailed(pairingId, SyncDirection.Pull, assetId, message);
        return JobStatus.Failed;
      }
    }

    const uuid = randomUUID();
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, pairing.localUserId, uuid);
    let localPath = '';

    try {
      const remote = await this.nodeClientRepository.getRemoteAsset(credentials, assetId);
      if (!mimeTypes.isAsset(remote.originalFileName)) {
        return JobStatus.Skipped;
      }

      localPath = join(folder, `${uuid}${getFilenameExtension(remote.originalFileName)}`);
      this.storageRepository.mkdirSync(folder);

      const stream = await this.nodeClientRepository.downloadAsset(credentials, assetId);
      const writeStream = this.storageRepository.createWriteStream(localPath);
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
        stream.pipe(writeStream);
      });

      const checksum = await this.cryptoRepository.hashFile(localPath);

      // Same bytes already here: map the two together and drop the download,
      // which is what stops a pull re-importing what this node pushed earlier.
      const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(pairing.localUserId, checksum);
      if (duplicateId) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [localPath] } });
        const adopted = await this.syncNodeRepository.upsertAssetMapping({
          nodeUserId: pairingId,
          localAssetId: duplicateId,
          remoteAssetId: assetId,
          checksum,
          origin: 'pull-dedupe',
        });

        // The same photo, held on both nodes independently: exactly where one side
        // has lost what the other kept.
        await this.reconcileMapping(context, adopted);

        await this.syncNodeRepository.markSucceeded(pairingId, SyncDirection.Pull, assetId);
        return JobStatus.Skipped;
      }

      const stats = await this.storageRepository.stat(localPath);

      const asset = await this.assetRepository.create({
        ownerId: pairing.localUserId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: localPath,
        fileCreatedAt: new Date(remote.fileCreatedAt),
        fileModifiedAt: new Date(remote.fileModifiedAt),
        localDateTime: new Date(remote.fileCreatedAt),
        type: mimeTypes.assetType(remote.originalFileName),
        isFavorite: remote.isFavorite,
        visibility: AssetVisibility.Timeline,
        originalFileName: remote.originalFileName,
      });

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size, description: remote.description ?? '' },
        lockedPropertiesBehavior: 'override',
      });

      await this.syncNodeRepository.upsertAssetMapping({
        nodeUserId: pairingId,
        localAssetId: asset.id,
        remoteAssetId: assetId,
        checksum,
        origin: 'pull',
      });

      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      await this.syncNodeRepository.markSucceeded(pairingId, SyncDirection.Pull, assetId);
      return JobStatus.Success;
    } catch (error: any) {
      // Recorded rather than rethrown, so the rest of the run carries on and this
      // item is reconsidered by the retry pass.
      const message = error?.message ?? String(error);
      this.logger.warn(`Failed to pull ${assetId}, will retry later: ${message}`);
      if (localPath) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [localPath] } });
      }
      await this.syncNodeRepository.markFailed(pairingId, SyncDirection.Pull, assetId, message);
      return JobStatus.Failed;
    }
  }

  /**
   * Re-queues outstanding work for a pairing: items that failed, and items that
   * were queued but never reported back -- which is what a lost queue looks like.
   *
   * Items past the attempt ceiling are left alone and surfaced in the UI instead,
   * so a genuinely broken asset stops consuming bandwidth on every run but is
   * still visible rather than silently dropped.
   */
  @OnJob({ name: JobName.NodeSyncRetryFailed, queue: QueueName.NodeSync })
  async handleRetryFailed({ pairingId }: INodeSyncPairJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    const items = await this.syncNodeRepository.getRetryableItems(pairingId, NODE_SYNC_MAX_ATTEMPTS, RETRY_PAGE_SIZE);
    if (items.length === 0) {
      return JobStatus.Success;
    }

    for (const item of items) {
      await this.jobRepository.queue({
        name: item.direction === SyncDirection.Push ? JobName.NodeSyncPushAsset : JobName.NodeSyncPullAsset,
        data: { pairingId, assetId: item.assetId },
      });
    }

    this.logger.log(`Re-queued ${items.length} outstanding sync item(s) for pairing ${pairingId}`);
    return JobStatus.Success;
  }

  /**
   * Compare the metadata of every asset a pairing has matched, not only the ones
   * that changed.
   *
   * The peer's change feed only moves when the asset itself does, so edits to a
   * date, a place, a tag or a face name made over there never show up in a pull.
   * This pass is how those arrive, and how a node that lost its metadata gets it
   * back. Each asset goes through the push job, so it lands in the work ledger
   * and a failure is retried and shown like any other.
   */
  @OnJob({ name: JobName.NodeSyncMetadataQueue, queue: QueueName.NodeSync })
  async handleMetadataQueue({ pairingId }: INodeSyncPairJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    let afterId: string | null = null;
    let total = 0;

    for (;;) {
      const page = await this.syncNodeRepository.getAssetMappingPage(pairingId, afterId, METADATA_PAGE_SIZE);
      if (page.length === 0) {
        break;
      }

      const assetIds = page.map(({ localAssetId }) => localAssetId);
      await this.syncNodeRepository.markQueued(pairingId, SyncDirection.Push, assetIds);
      await this.jobRepository.queueAll(
        assetIds.map((assetId) => ({ name: JobName.NodeSyncPushAsset, data: { pairingId, assetId } })),
      );

      total += page.length;
      afterId = page.at(-1)!.id;

      if (page.length < METADATA_PAGE_SIZE) {
        break;
      }
    }

    this.logger.log(`Queued ${total} matched asset(s) for a metadata comparison on pairing ${pairingId}`);
    return JobStatus.Success;
  }

  /**
   * Reconciles albums after assets have moved, so membership can reference
   * assets that already exist on both sides. Albums are matched by name.
   */
  @OnJob({ name: JobName.NodeSyncAlbums, queue: QueueName.NodeSync })
  async handleAlbums({ pairingId }: INodeSyncPairJob): Promise<JobStatus> {
    const context = await this.getContext(pairingId);
    if (!context) {
      return JobStatus.Skipped;
    }

    const { pairing, credentials } = context;
    if (!pairing.pushEnabled) {
      return JobStatus.Skipped;
    }

    try {
      const localAlbums = await this.syncNodeRepository.getAlbumsForOwner(pairing.localUserId);
      const remoteAlbums = await this.nodeClientRepository.getAlbums(credentials);
      const mappings = await this.syncNodeRepository.getAlbumMappings(pairingId);
      const mappedByLocal = new Map(mappings.map((mapping) => [mapping.localAlbumId, mapping]));

      for (const album of localAlbums) {
        let remoteAlbumId = mappedByLocal.get(album.id)?.remoteAlbumId;

        if (!remoteAlbumId) {
          const byName = remoteAlbums.find((remote) => remote.albumName === album.albumName);
          if (byName) {
            remoteAlbumId = byName.id;
          } else {
            const created = await this.nodeClientRepository.createAlbum(credentials, {
              albumName: album.albumName,
              description: album.description ?? undefined,
            });
            remoteAlbumId = created.id;
          }

          await this.syncNodeRepository.upsertAlbumMapping({
            nodeUserId: pairingId,
            localAlbumId: album.id,
            remoteAlbumId,
          });
        }

        const localAssetIds = await this.syncNodeRepository.getAlbumAssetIds(album.id);
        const remoteIds: string[] = [];
        for (const { assetId } of localAssetIds) {
          const mapping = await this.syncNodeRepository.getAssetMapping(pairingId, assetId);
          if (mapping) {
            remoteIds.push(mapping.remoteAssetId);
          }
        }

        if (remoteIds.length > 0) {
          // The peer ignores assets already in the album, so this is idempotent.
          await this.nodeClientRepository.addAssetsToAlbum(credentials, remoteAlbumId, remoteIds);
        }
      }

      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Album sync failed for pairing ${pairingId}: ${error?.message ?? error}`, error?.stack);
      return JobStatus.Failed;
    }
  }

  /**
   * Compare a matched asset's metadata on both nodes and bring each in line, then
   * note the local version it was compared at so an unchanged asset is not
   * compared again on the next push, nor re-pulled on the next pull.
   */
  private async reconcileMapping(
    context: SyncContext,
    mapping: { id: string; localAssetId: string; remoteAssetId: string },
  ): Promise<void> {
    const updateId = await this.reconcileMetadata(context, mapping);
    await this.syncNodeRepository.updateAssetMapping(mapping.id, { metadataUpdateId: updateId, updatedAt: new Date() });
  }

  /**
   * Bring a matched asset's metadata in line on both nodes: the capture date and
   * zone, place, rating, description, favourite, archive state, tags, and the
   * names on faces both nodes have detected.
   *
   * A value one node is missing is filled in from the other. Where both have one
   * and they disagree, the node with the older capture date keeps its value, or,
   * for the same capture date, the node edited more recently -- see
   * `pickMetadataWinner`. Each node is only written in a direction the pairing has
   * enabled, so a push-only pairing never changes this library.
   *
   * Returns the local asset's `updateId` once any local writes are done.
   */
  private async reconcileMetadata(
    { pairing, credentials }: SyncContext,
    mapping: { localAssetId: string; remoteAssetId: string },
  ): Promise<string | null> {
    const local = await this.syncNodeRepository.getAssetMetadata(mapping.localAssetId);
    if (!local) {
      return null;
    }

    const [localTags, remote, localFaces, remoteFaces] = await Promise.all([
      this.syncNodeRepository.getAssetTagValues(local.id),
      this.nodeClientRepository.getRemoteAsset(credentials, mapping.remoteAssetId),
      this.personRepository.getFaces(local.id, { viewingUserId: local.ownerId, isVisible: true }),
      this.nodeClientRepository.getFaces(credentials, mapping.remoteAssetId),
    ]);

    const plan = planMetadataSync(
      {
        createdAt: asDate(local.dateTimeOriginal) ?? asDate(local.fileCreatedAt),
        modifiedAt: latest(asDate(local.updatedAt), asDate(local.exifUpdatedAt)),
        dateTimeOriginal: asDate(local.dateTimeOriginal),
        timeZone: local.timeZone ?? null,
        latitude: local.latitude ?? null,
        longitude: local.longitude ?? null,
        rating: local.rating ?? null,
        description: local.description || null,
        isFavorite: local.isFavorite,
        visibility: local.visibility,
        tags: localTags,
      },
      toRemoteMetadata(remote),
    );

    const faces = planFaceNames(
      localFaces
        .map((face) =>
          toSyncedFace(face, face.personGroupId ? { id: face.personGroupId, name: face.person?.name ?? null } : null),
        )
        .filter((face): face is SyncedFace => face !== null),
      remoteFaces.map((face) => toSyncedFace(face, face.person)).filter((face): face is SyncedFace => face !== null),
    );

    if (pairing.pullEnabled) {
      await this.applyLocalMetadata(local, plan.local);
      await this.applyLocalFaceNames(local.ownerId, faces.local);
    }

    if (pairing.pushEnabled) {
      await this.applyRemoteMetadata(credentials, mapping.remoteAssetId, plan.remote);
      await this.applyRemoteFaceNames(credentials, faces.remote);
    }

    const after = await this.syncNodeRepository.getAssetMetadata(local.id);
    return after?.updateId ?? local.updateId;
  }

  private async applyLocalMetadata(asset: { id: string; ownerId: string }, changes: MetadataChanges) {
    if (!hasMetadataChanges(changes)) {
      return;
    }

    const exif: Record<string, unknown> & { assetId: string } = { assetId: asset.id };

    if (changes.dateTimeOriginal) {
      exif.dateTimeOriginal = changes.dateTimeOriginal.value;
      exif.timeZone = changes.dateTimeOriginal.timeZone;
    }

    if (changes.location) {
      exif.latitude = changes.location.latitude;
      exif.longitude = changes.location.longitude;
    }

    if (changes.rating !== undefined) {
      exif.rating = changes.rating;
    }

    if (changes.description !== undefined) {
      exif.description = changes.description;
    }

    const hasExif = Object.keys(exif).length > 1;
    if (hasExif) {
      // Locked, as an edit made here would be, so re-reading the file does not put
      // back the very value that was missing.
      await this.assetRepository.upsertExif({
        exif: updateLockedColumns(exif) as Insertable<AssetExifTable>,
        lockedPropertiesBehavior: 'append',
      });
    }

    if (changes.isFavorite !== undefined || changes.visibility !== undefined) {
      await this.assetRepository.update({
        id: asset.id,
        isFavorite: changes.isFavorite,
        visibility: changes.visibility,
      });
    }

    if (changes.tags) {
      const tags = await upsertTags(this.tagRepository, { userId: asset.ownerId, tags: changes.tags });
      await this.tagRepository.upsertAssetIds(tags.map((tag) => ({ tagId: tag.id, assetId: asset.id })));
    }

    // The sidecar carries dates, places, ratings, descriptions and tags, so it is
    // rewritten to match rather than left to contradict the database.
    if (hasExif || changes.tags) {
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: asset.id } });
    }
  }

  private async applyRemoteMetadata(credentials: NodeCredentials, remoteAssetId: string, changes: MetadataChanges) {
    if (!hasMetadataChanges(changes)) {
      return;
    }

    const update = {
      dateTimeOriginal: changes.dateTimeOriginal ? toZonedIso(changes.dateTimeOriginal) : undefined,
      latitude: changes.location?.latitude,
      longitude: changes.location?.longitude,
      rating: changes.rating,
      description: changes.description,
      isFavorite: changes.isFavorite,
      visibility: changes.visibility,
    };

    if (Object.values(update).some((value) => value !== undefined)) {
      await this.nodeClientRepository.updateAsset(credentials, remoteAssetId, update);
    }

    if (changes.tags) {
      const tags = await this.nodeClientRepository.upsertTags(credentials, changes.tags);
      await this.nodeClientRepository.tagAssets(
        credentials,
        tags.map(({ id }) => id),
        [remoteAssetId],
      );
    }
  }

  /**
   * Give faces here the names the peer has for them. A person already named that
   * is reused; an unnamed person the face already belongs to is named, so the rest
   * of its cluster comes along; otherwise a person is created for the face.
   */
  private async applyLocalFaceNames(ownerId: string, namings: FaceNaming[]) {
    for (const { faceId, personId, name } of namings) {
      const candidates = await this.personRepository.getByName(ownerId, name, { withHidden: true });
      const named = candidates.find((person) => isSameName(person.name, name));

      if (named) {
        if (named.personGroupId !== personId) {
          await this.personRepository.reassignFace(faceId, named.personGroupId);

          if (!named.faceAssetId) {
            await this.personRepository.update({ ownerId, personGroupId: named.personGroupId, faceAssetId: faceId });
            await this.jobRepository.queue({
              name: JobName.PersonGenerateThumbnail,
              data: { ownerId, personGroupId: named.personGroupId },
            });
          }
        }
        continue;
      }

      if (personId) {
        await this.personRepository.update({ ownerId, personGroupId: personId, name });
        continue;
      }

      const group = await this.personRepository.createGroup(ownerId);
      await this.personRepository.create({ ownerId, personGroupId: group.id, name, faceAssetId: faceId });
      await this.personRepository.reassignFace(faceId, group.id);
      await this.jobRepository.queue({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId, personGroupId: group.id },
      });
    }
  }

  /** The same as {@link applyLocalFaceNames}, through the peer's API. */
  private async applyRemoteFaceNames(credentials: NodeCredentials, namings: FaceNaming[]) {
    for (const { faceId, personId, name } of namings) {
      const candidates = await this.nodeClientRepository.searchPeople(credentials, name);
      const named = candidates.find((person) => isSameName(person.name, name));

      if (named) {
        if (named.id !== personId) {
          await this.nodeClientRepository.reassignFace(credentials, named.id, faceId);
        }
        continue;
      }

      if (personId) {
        await this.nodeClientRepository.updatePerson(credentials, personId, { name });
        continue;
      }

      const created = await this.nodeClientRepository.createPerson(credentials, { name });
      await this.nodeClientRepository.reassignFace(credentials, created.id, faceId);
    }
  }

  private async getContext(pairingId: string) {
    const pairing = await this.syncNodeRepository.getPairing(pairingId);
    if (!pairing) {
      this.logger.warn(`Pairing ${pairingId} no longer exists, skipping`);
      return null;
    }

    const node = await this.syncNodeRepository.get(pairing.nodeId);
    if (!node || !node.isEnabled) {
      return null;
    }

    return {
      pairing,
      node,
      // Asset endpoints act as whoever owns the key, so all data movement uses
      // the paired user's own key. The node-level key is only for admin work.
      credentials: { url: node.url, apiKey: pairing.apiKey } satisfies NodeCredentials,
    };
  }
}
