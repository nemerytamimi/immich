import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import {
  AssetFileType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  QueueName,
  STORAGE_TRANSFER_STOPPED,
  StorageFolder,
  StorageTransferStatus,
} from 'src/enum.js';
import { describeRemoteError } from 'src/repositories/remote-storage/driver.js';
import { StorageTargetRef } from 'src/repositories/remote-storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  type IBaseJob,
  type IStorageTargetObjectDeleteJob,
  type IStorageTransferAssetJob,
  type IStorageTransferJob,
  type IStorageTransferObjectJob,
  StorageTransferScope,
} from 'src/types.js';
import { getFilenameExtension } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { getRemoteCachePath } from 'src/utils/remote-cache.js';

/** How long a cached remote original survives without being read. */
const REMOTE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a queueing walk re-reads its transfer to notice a pause or cancel. */
const QUEUE_STOP_CHECK_INTERVAL = 500;

/** Long enough for a stack of provider detail, short enough that one row stays small. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Every remote key prefix a user's objects can sit under.
 *
 * An exported original keeps its library-relative path, whose first segment is
 * the user's storage label, or their id when they have none. Assets that never
 * went through the storage template fall back to an id-prefixed key instead, so
 * a user who has a storage label can own objects under both. Missing the second
 * one would silently skip exactly those assets on the way back in.
 *
 * Kept next to `getRemoteKey`, which is what decides those two shapes: if one
 * changes, so must the other.
 */
const getOwnerPrefixes = (user: { id: string; storageLabel: string | null }): string[] => [
  ...new Set([user.storageLabel || user.id, user.id]),
];

/**
 * Whether a job may act for its transfer: the transfer is neither paused nor
 * cancelled, and is still on the run that queued the job.
 *
 * A paused or cancelled transfer leaves its queued jobs in place, and they drain
 * without acting and without touching the counters. Resuming starts a new run,
 * so those same jobs keep draining afterwards instead of waking up and counting
 * toward a run that re-queues their assets anyway. A job queued before runs
 * existed carries none, and matches only a transfer that has none either.
 */
const isCurrentRun = (transfer: { status: StorageTransferStatus; runId: string | null }, runId?: string) =>
  !STORAGE_TRANSFER_STOPPED.has(transfer.status) && transfer.runId === (runId ?? null);

/** bigint columns come back from the driver as strings. */
const asSize = (value: string | number | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

type TransferWalk = { ownerId: string; scope: StorageTransferScope };

/** What is known about an item, kept with its failure so it can be looked at and retried. */
type TransferItemRef = {
  assetId?: string;
  remoteKey?: string;
  fileName?: string | null;
  size?: number | null;
};

@Injectable()
export class StorageTransferService extends BaseService {
  @OnJob({ name: JobName.StorageTargetExportQueue, queue: QueueName.StorageTarget })
  handleExportQueue({ transferId }: IStorageTransferJob): Promise<JobStatus> {
    return this.queueAssetTransfer(transferId, JobName.StorageTargetExportAsset, (transfer) =>
      this.storageTargetRepository.streamAssetsForExport(transfer.ownerId, transfer.scope),
    );
  }

  @OnJob({ name: JobName.StorageTargetExportAsset, queue: QueueName.StorageTarget })
  async handleExportAsset({ transferId, runId, assetId }: IStorageTransferAssetJob): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer || !isCurrentRun(transfer, runId)) {
      return JobStatus.Skipped;
    }

    const target = await this.storageTargetRepository.get(transfer.targetId);
    if (!target) {
      this.logger.warn(`Storage target ${transfer.targetId} no longer exists, skipping export`);
      return JobStatus.Skipped;
    }

    const asset = await this.storageTargetRepository.getAssetForExport(assetId);
    if (!asset) {
      await this.fail(transferId, runId, { assetId }, 'The asset no longer exists');
      return JobStatus.Skipped;
    }

    // Already on the target from an earlier run: nothing to do, which is what
    // makes re-running an export cheap.
    const existing = await this.storageTargetRepository.getObjectByAsset(target.id, assetId);
    if (existing) {
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Skipped;
    }

    const remoteKey = this.getRemoteKey(asset.ownerId, asset.originalPath);
    const item = { assetId, remoteKey, fileName: asset.originalFileName, size: asSize(asset.fileSizeInByte) };

    try {
      await this.uploadOriginal(target, asset, remoteKey);
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Success;
    } catch (error: any) {
      // One bad object must not abort the whole transfer, so failures are counted
      // and the run continues.
      this.logger.error(`Failed to export asset ${assetId} to ${remoteKey}: ${error}`, error?.stack);
      await this.fail(transferId, runId, item, error);
      return JobStatus.Failed;
    }
  }

  @OnJob({ name: JobName.StorageTargetImportScan, queue: QueueName.StorageTarget })
  async handleImportScan({ transferId }: IStorageTransferJob): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer) {
      this.logger.warn(`Transfer ${transferId} no longer exists, skipping`);
      return JobStatus.Skipped;
    }

    const target = await this.storageTargetRepository.get(transfer.targetId);
    if (!target) {
      this.logger.warn(`Storage target ${transfer.targetId} no longer exists, skipping import`);
      return JobStatus.Skipped;
    }

    if (STORAGE_TRANSFER_STOPPED.has(transfer.status)) {
      this.logger.debug(`Transfer ${transferId} is ${transfer.status}, not queueing work`);
      return JobStatus.Skipped;
    }

    const { runId } = transfer;
    // Imported keys are in the ledger, so a resumed scan leaves them out: what the
    // earlier run finished stays counted and the scan adds only what is left.
    const baseline = transfer.completedCount;

    const started = await this.storageTargetRepository.updateTransferRun(transferId, runId, {
      status: StorageTransferStatus.Running,
      startedAt: new Date(),
    });
    if (!started) {
      return JobStatus.Skipped;
    }

    // Objects on a target are laid out per user, so a scan that walked the whole
    // target would hand one user every other user's originals. Scanning only the
    // owner's own prefixes is what keeps an import as user-scoped as an export.
    const owner = await this.userRepository.get(transfer.ownerId, {});
    if (!owner) {
      this.logger.warn(`Owner ${transfer.ownerId} no longer exists, skipping import`);
      return JobStatus.Skipped;
    }

    const prefixes = transfer.prefix === null ? getOwnerPrefixes(owner) : [transfer.prefix];

    let queued = 0;

    try {
      for await (const batch of this.listPrefixes(target, prefixes)) {
        const candidates = batch.filter(({ key }) => mimeTypes.isAsset(key));

        // The ledger holds every object this instance has put on the target as
        // well as every one it has taken off, so exports are skipped here too.
        // That is deliberate: without it, importing from a backup target would
        // feed a user's own library back in as duplicates on every run.

        const newKeys = await this.storageTargetRepository.filterNewRemoteKeys(
          target.id,
          candidates.map(({ key }) => key),
        );
        const newKeySet = new Set(newKeys);
        const newObjects = candidates.filter(({ key }) => newKeySet.has(key));

        for (const object of newObjects) {
          await this.jobRepository.queue({
            name: JobName.StorageTargetImportObject,
            data: { transferId, runId: runId ?? undefined, remoteKey: object.key, size: object.size },
          });
          queued++;
        }
      }
    } catch (error: any) {
      const detail = describeRemoteError(error);
      this.logger.error(`Failed to scan storage target "${target.name}" (${target.id}): ${detail}`, error?.stack);
      await this.storageTargetRepository.updateTransferRun(transferId, runId, {
        status: StorageTransferStatus.Failed,
        finishedAt: new Date(),
        error: detail,
      });
      return JobStatus.Failed;
    }

    this.logger.log(`Queued ${queued} object(s) for import from storage target ${target.id}`);

    return this.finishWalk(transferId, runId, baseline, queued);
  }

  @OnJob({ name: JobName.StorageTargetImportObject, queue: QueueName.StorageTarget })
  async handleImportObject({ transferId, runId, remoteKey, size }: IStorageTransferObjectJob): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer || !isCurrentRun(transfer, runId)) {
      return JobStatus.Skipped;
    }

    const target = await this.storageTargetRepository.get(transfer.targetId);
    if (!target) {
      return JobStatus.Skipped;
    }

    const ownerId = transfer.ownerId;
    const uuid = randomUUID();
    const originalName = basename(remoteKey);
    const item = { remoteKey, fileName: originalName, size };
    const localPath = join(
      StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, uuid),
      `${uuid}${getFilenameExtension(originalName)}`,
    );

    try {
      this.storageRepository.mkdirSync(StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, uuid));

      const remoteStream = await this.remoteStorageRepository.createReadStream(target, remoteKey);
      const writeStream = this.storageRepository.createWriteStream(localPath);
      await new Promise<void>((resolve, reject) => {
        remoteStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
        remoteStream.pipe(writeStream);
      });

      const checksum = await this.cryptoRepository.hashFile(localPath);

      // Content-addressed dedupe: if the user already has these exact bytes we
      // record the mapping and drop the download rather than creating a duplicate.
      const duplicate = await this.assetRepository.getUploadAssetIdByChecksum(ownerId, checksum);
      if (duplicate) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [localPath] } });
        await this.storageTargetRepository.upsertObject({
          targetId: target.id,
          remoteKey,
          assetId: duplicate,
          size,
          checksum,
        });
        await this.succeed(transferId, runId, remoteKey);
        return JobStatus.Skipped;
      }

      const stats = await this.storageRepository.stat(localPath);

      const asset = await this.assetRepository.create({
        ownerId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: localPath,
        // The remote store is not a reliable source of capture time; metadata
        // extraction corrects these from EXIF right after this job.
        fileCreatedAt: stats.mtime,
        fileModifiedAt: stats.mtime,
        localDateTime: stats.mtime,
        type: mimeTypes.assetType(originalName),
        visibility: AssetVisibility.Timeline,
        originalFileName: originalName,
      });

      // A sibling `.xmp` on the target belongs to this asset, so it comes across too.
      await this.importSidecar(target, remoteKey, asset.id, ownerId, uuid);

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.storageTargetRepository.upsertObject({
        targetId: target.id,
        remoteKey,
        assetId: asset.id,
        size: stats.size,
        checksum,
      });

      await this.jobRepository.queue({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' },
      });

      await this.succeed(transferId, runId, remoteKey);
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Failed to import ${remoteKey}: ${error}`, error?.stack);
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [localPath] } });
      await this.fail(transferId, runId, item, error);
      return JobStatus.Failed;
    }
  }

  private async importSidecar(
    target: StorageTargetRef,
    remoteKey: string,
    assetId: string,
    ownerId: string,
    uuid: string,
  ) {
    const sidecarKey = `${remoteKey}.xmp`;

    const sidecar = await this.remoteStorageRepository.head(target, sidecarKey).catch(() => null);
    if (!sidecar) {
      return;
    }

    const sidecarPath = join(StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, uuid), `${uuid}.xmp`);
    const stream = await this.remoteStorageRepository.createReadStream(target, sidecarKey);
    const writeStream = this.storageRepository.createWriteStream(sidecarPath);

    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', () => resolve());
      stream.pipe(writeStream);
    });

    await this.assetRepository.upsertFile({ assetId, path: sidecarPath, type: AssetFileType.Sidecar });
  }

  @OnJob({ name: JobName.StorageTargetOffloadQueue, queue: QueueName.StorageTarget })
  handleOffloadQueue({ transferId }: IStorageTransferJob): Promise<JobStatus> {
    return this.queueAssetTransfer(
      transferId,
      JobName.StorageTargetOffloadAsset,
      (transfer) => this.storageTargetRepository.streamAssetsForOffload(transfer.ownerId, transfer.scope),
      (transfer) => this.storageTargetRepository.countAssetsMissingPreviews(transfer.ownerId, transfer.scope),
    );
  }

  /**
   * Push an asset's original to the target and then drop the local copy.
   *
   * Only the original file goes: the asset row, its EXIF, faces, tags, album
   * memberships, thumbnails, preview and sidecar all stay exactly where they are,
   * so the asset keeps showing up in the timeline and search, and a later restore
   * or re-upload lands back on this same row instead of creating a duplicate.
   *
   * The local delete happens only after the remote object has been read back and
   * its size confirmed. A stale ledger row is never enough on its own -- that is
   * the difference between a cheap re-run and deleting the last copy of a photo.
   */
  @OnJob({ name: JobName.StorageTargetOffloadAsset, queue: QueueName.StorageTarget })
  async handleOffloadAsset({ transferId, runId, assetId }: IStorageTransferAssetJob): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer || !isCurrentRun(transfer, runId)) {
      return JobStatus.Skipped;
    }

    const target = await this.storageTargetRepository.get(transfer.targetId);
    if (!target) {
      this.logger.warn(`Storage target ${transfer.targetId} no longer exists, skipping offload`);
      return JobStatus.Skipped;
    }

    const asset = await this.storageTargetRepository.getAssetForExport(assetId);
    if (!asset) {
      await this.fail(transferId, runId, { assetId }, 'The asset no longer exists');
      return JobStatus.Skipped;
    }

    if (asset.offloadedAt) {
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Skipped;
    }

    const existing = await this.storageTargetRepository.getObjectByAsset(target.id, assetId);
    const remoteKey = existing?.remoteKey ?? this.getRemoteKey(asset.ownerId, asset.originalPath);
    const item = { assetId, remoteKey, fileName: asset.originalFileName, size: asSize(asset.fileSizeInByte) };

    try {
      const { size: localSize } = await this.storageRepository.stat(asset.originalPath);

      if (!existing) {
        await this.uploadOriginal(target, asset, remoteKey);
      }

      // Read back before deleting. An object that is missing, truncated, or a
      // different length than what is on disk means the upload did not land.
      const remote = await this.remoteStorageRepository.head(target, remoteKey);
      if (!remote) {
        throw new Error(`Object ${remoteKey} is not readable on the target`);
      }

      if (remote.size !== localSize) {
        throw new Error(`Object ${remoteKey} is ${remote.size} bytes on the target but ${localSize} bytes locally`);
      }

      await this.storageRepository.unlink(asset.originalPath);

      // A cache entry from before the offload would shadow the remote copy with
      // bytes nobody has verified, so it goes too.
      await this.storageRepository.unlink(getRemoteCachePath(asset)).catch(() => {});

      await this.storageTargetRepository.setOffloadedAt(assetId, new Date());

      this.logger.debug(`Offloaded asset ${assetId} to ${remoteKey}, freed ${localSize} bytes`);
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Failed to offload asset ${assetId} to ${remoteKey}: ${error}`, error?.stack);
      await this.fail(transferId, runId, item, error);
      return JobStatus.Failed;
    }
  }

  @OnJob({ name: JobName.StorageTargetRestoreQueue, queue: QueueName.StorageTarget })
  handleRestoreQueue({ transferId }: IStorageTransferJob): Promise<JobStatus> {
    return this.queueAssetTransfer(transferId, JobName.StorageTargetRestoreAsset, (transfer) =>
      this.storageTargetRepository.streamAssetsForRestore(transfer.ownerId, transfer.scope),
    );
  }

  /**
   * Pull an offloaded original back to the path it came from, on the same asset
   * row. Nothing is re-created and nothing is re-indexed, so metadata, faces and
   * album membership survive a full offload/restore round trip untouched.
   */
  @OnJob({ name: JobName.StorageTargetRestoreAsset, queue: QueueName.StorageTarget })
  async handleRestoreAsset({ transferId, runId, assetId }: IStorageTransferAssetJob): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer || !isCurrentRun(transfer, runId)) {
      return JobStatus.Skipped;
    }

    const asset = await this.storageTargetRepository.getAssetForExport(assetId);
    if (!asset) {
      await this.fail(transferId, runId, { assetId }, 'The asset no longer exists');
      return JobStatus.Skipped;
    }

    if (!asset.offloadedAt) {
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Skipped;
    }

    const location = await this.storageTargetRepository.getOffloadLocation(assetId);
    if (!location) {
      this.logger.error(`Asset ${assetId} is offloaded but no enabled target holds it`);
      await this.fail(
        transferId,
        runId,
        { assetId, fileName: asset.originalFileName, size: asSize(asset.fileSizeInByte) },
        'The asset is offloaded, but no enabled storage target holds it',
      );
      return JobStatus.Failed;
    }

    const partialPath = `${asset.originalPath}.restore`;
    const item = {
      assetId,
      remoteKey: location.remoteKey,
      fileName: asset.originalFileName,
      size: asSize(location.size),
    };

    try {
      this.storageRepository.mkdirSync(dirname(asset.originalPath));

      const stream = await this.remoteStorageRepository.createReadStream(
        { id: location.id, updatedAt: location.updatedAt, config: location.config, secret: location.secret },
        location.remoteKey,
      );
      await pipeline(stream, this.storageRepository.createWriteStream(partialPath));

      // The asset row still carries the checksum from before the offload, so a
      // corrupted or swapped remote object is caught here rather than silently
      // becoming the library's copy.
      const checksum = await this.cryptoRepository.hashFile(partialPath);
      if (asset.checksum && Buffer.compare(checksum, asset.checksum) !== 0) {
        throw new Error(`Checksum mismatch restoring ${location.remoteKey}`);
      }

      await this.storageRepository.rename(partialPath, asset.originalPath);
      await this.storageTargetRepository.setOffloadedAt(assetId, null);

      // The original is local again, so the cached copy is dead weight.
      await this.storageRepository.unlink(getRemoteCachePath(asset)).catch(() => {});

      this.logger.debug(`Restored asset ${assetId} from ${location.remoteKey}`);
      await this.succeed(transferId, runId, assetId);
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Failed to restore asset ${assetId}: ${error}`, error?.stack);
      await this.storageRepository.unlink(partialPath).catch(() => {});
      await this.fail(transferId, runId, item, error);
      return JobStatus.Failed;
    }
  }

  /**
   * Remove an object from a target once the asset that owned it is gone for good.
   * Queued by asset deletion, where the ledger row has already cascaded away.
   */
  @OnJob({ name: JobName.StorageTargetObjectDelete, queue: QueueName.StorageTarget })
  async handleObjectDelete({ targetId, remoteKey }: IStorageTargetObjectDeleteJob): Promise<JobStatus> {
    const target = await this.storageTargetRepository.get(targetId);
    if (!target) {
      return JobStatus.Skipped;
    }

    try {
      await this.remoteStorageRepository.delete(target, remoteKey);
      await this.remoteStorageRepository.delete(target, `${remoteKey}.xmp`).catch(() => {});
      await this.storageTargetRepository.deleteObject(targetId, remoteKey);
      return JobStatus.Success;
    } catch (error: any) {
      this.logger.error(`Failed to delete ${remoteKey} from target ${targetId}: ${error}`, error?.stack);
      return JobStatus.Failed;
    }
  }

  /**
   * Trim the read-through cache. Entries are touched on every hit, so age here
   * means "not looked at recently" rather than "downloaded a while ago" -- an
   * album someone browses every week never gets re-fetched.
   */
  @OnJob({ name: JobName.StorageTargetCacheCleanup, queue: QueueName.BackgroundTask })
  async handleCacheCleanup(_: IBaseJob = {}): Promise<JobStatus> {
    const folder = StorageCore.getBaseFolder(StorageFolder.RemoteCache);
    if (!this.storageRepository.existsSync(folder)) {
      return JobStatus.Skipped;
    }

    const cutoff = Date.now() - REMOTE_CACHE_TTL_MS;
    let removed = 0;

    for await (const batch of this.storageRepository.walk({
      pathsToCrawl: [folder],
      includeHidden: true,
      exclusionPatterns: [],
      take: 1000,
    })) {
      for (const path of batch) {
        const { mtimeMs } = await this.storageRepository.stat(path);
        if (mtimeMs < cutoff) {
          await this.storageRepository.unlink(path);
          removed++;
        }
      }
    }

    if (removed > 0) {
      this.logger.log(`Evicted ${removed} cached remote original(s)`);
      await this.storageRepository.removeEmptyDirs(folder);
    }

    return JobStatus.Success;
  }

  /** Count an item as done, and forget any failure it left on an earlier attempt. */
  private async succeed(transferId: string, runId: string | undefined, itemKey: string) {
    await this.storageTargetRepository.clearTransferFailure(transferId, itemKey);
    await this.storageTargetRepository.incrementTransferProgress(transferId, runId, { completed: 1 });
  }

  /**
   * Count an item as failed, and keep what went wrong with it. The counter says
   * how many failed; this is what says which ones, and why.
   */
  private async fail(transferId: string, runId: string | undefined, item: TransferItemRef, error: unknown) {
    const message = typeof error === 'string' ? error : describeRemoteError(error);

    await this.storageTargetRepository.recordTransferFailure({
      transferId,
      itemKey: item.assetId ?? item.remoteKey ?? '',
      assetId: item.assetId ?? null,
      remoteKey: item.remoteKey ?? null,
      fileName: item.fileName ?? null,
      size: item.size ?? null,
      error: message.slice(0, MAX_ERROR_LENGTH),
    });
    await this.storageTargetRepository.incrementTransferProgress(transferId, runId, { failed: 1 });
  }

  /**
   * Shared queueing shell for the asset-by-asset directions.
   *
   * Offload and restore leave finished assets out of their walk, so on a resumed
   * run the total is what the earlier run already completed plus what the walk
   * queues now. Export walks everything and counts what the ledger holds as it
   * goes, which is why resuming one clears its count before this runs.
   *
   * `countSkipped` reports assets the walk leaves out because they are not ready
   * yet. They are not in the total, so it is recorded separately.
   */
  private async queueAssetTransfer(
    transferId: string,
    jobName: JobName.StorageTargetExportAsset | JobName.StorageTargetOffloadAsset | JobName.StorageTargetRestoreAsset,
    stream: (transfer: TransferWalk) => AsyncIterable<{ id: string }>,
    countSkipped?: (transfer: TransferWalk) => Promise<number>,
  ): Promise<JobStatus> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    if (!transfer) {
      this.logger.warn(`Transfer ${transferId} no longer exists, skipping`);
      return JobStatus.Skipped;
    }

    if (STORAGE_TRANSFER_STOPPED.has(transfer.status)) {
      this.logger.debug(`Transfer ${transferId} is ${transfer.status}, not queueing work`);
      return JobStatus.Skipped;
    }

    const { runId } = transfer;
    const baseline = transfer.completedCount;
    const skippedCount = countSkipped ? await countSkipped(transfer) : 0;

    const started = await this.storageTargetRepository.updateTransferRun(transferId, runId, {
      status: StorageTransferStatus.Running,
      startedAt: new Date(),
      skippedCount,
    });
    if (!started) {
      return JobStatus.Skipped;
    }

    let queued = 0;
    for await (const { id } of stream(transfer)) {
      await this.jobRepository.queue({ name: jobName, data: { transferId, runId: runId ?? undefined, assetId: id } });
      queued++;

      // Enumerating a large library takes a while, and an operator who pauses
      // during it expects the queueing to stop too, not to finish first.
      if (queued % QUEUE_STOP_CHECK_INTERVAL === 0 && (await this.isStopped(transferId, runId))) {
        this.logger.log(`Transfer ${transferId} stopped after queueing ${queued} asset(s)`);
        await this.storageTargetRepository.updateTransferRun(transferId, runId, { totalCount: baseline + queued });
        return JobStatus.Skipped;
      }
    }

    this.logger.log(
      `Queued ${queued} asset(s) for ${transfer.direction} on storage target ${transfer.targetId}` +
        (skippedCount > 0 ? `, skipped ${skippedCount} with no thumbnail or preview yet` : ''),
    );

    return this.finishWalk(transferId, runId, baseline, queued);
  }

  /**
   * Record a walk's total and close the transfer when it queued nothing. The
   * total is only known once the walk is drained, so it is written last and the
   * counters are reconciled after, in case workers finished before it landed.
   */
  private async finishWalk(
    transferId: string,
    runId: string | null,
    baseline: number,
    queued: number,
  ): Promise<JobStatus> {
    const updated = await this.storageTargetRepository.updateTransferRun(transferId, runId, {
      totalCount: baseline + queued,
    });

    // Paused and resumed while this walk was still going: the new run walks
    // again, so this one's total describes nothing.
    if (!updated) {
      return JobStatus.Skipped;
    }

    if (queued === 0) {
      // A walk that finished after a pause landed leaves it paused.
      if (updated.status === StorageTransferStatus.Running) {
        await this.storageTargetRepository.updateTransferRun(transferId, runId, {
          status: StorageTransferStatus.Completed,
          finishedAt: new Date(),
        });
      }
    } else {
      await this.storageTargetRepository.incrementTransferProgress(transferId, runId, {});
    }

    return JobStatus.Success;
  }

  /** Whether the transfer has been paused, cancelled, or moved to a new run since the walk started. */
  private async isStopped(transferId: string, runId: string | null): Promise<boolean> {
    const transfer = await this.storageTargetRepository.getTransfer(transferId);
    return !transfer || !isCurrentRun(transfer, runId ?? undefined);
  }

  /** Upload an original and its sidecar, and record both in the ledger. */
  private async uploadOriginal(
    target: StorageTargetRef,
    asset: { id: string; originalPath: string; checksum: Buffer },
    remoteKey: string,
  ) {
    const { size } = await this.storageRepository.stat(asset.originalPath);

    await this.remoteStorageRepository.upload(
      target,
      remoteKey,
      this.storageRepository.createPlainReadStream(asset.originalPath),
      { size, contentType: mimeTypes.lookup(asset.originalPath) },
    );

    // Sidecars carry user-edited metadata, so an export without them would not
    // round-trip faithfully.
    const sidecarPath = `${asset.originalPath}.xmp`;
    if (await this.storageRepository.checkFileExists(sidecarPath)) {
      const sidecarStats = await this.storageRepository.stat(sidecarPath);
      await this.remoteStorageRepository.upload(
        target,
        `${remoteKey}.xmp`,
        this.storageRepository.createPlainReadStream(sidecarPath),
        { size: sidecarStats.size, contentType: 'application/xml' },
      );
    }

    await this.storageTargetRepository.upsertObject({
      targetId: target.id,
      remoteKey,
      assetId: asset.id,
      size,
      checksum: asset.checksum,
    });
  }

  /** Walk several prefixes as one stream, so the scan body stays prefix-agnostic. */
  private async *listPrefixes(target: StorageTargetRef, prefixes: string[]) {
    for (const prefix of prefixes) {
      yield* this.remoteStorageRepository.list(target, prefix || undefined);
    }
  }

  /**
   * Mirror the local library layout on the target so exports are stable across
   * runs and an exported tree can be imported back without losing structure.
   */
  private getRemoteKey(ownerId: string, originalPath: string): string {
    const libraryFolder = StorageCore.getBaseFolder(StorageFolder.Library);
    const relativePath = relative(libraryFolder, originalPath);

    // Assets that have not been through the storage template still live under the
    // upload folder, so fall back to a flat, owner-scoped key for those.
    if (relativePath.startsWith('..')) {
      return `${ownerId}/${basename(originalPath)}`;
    }

    return relativePath.replaceAll('\\', '/');
  }
}
