import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core';
import { StorageFolder } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { RemoteStorageRepository, StorageTargetRef } from 'src/repositories/remote-storage.repository';
import { StorageTargetRepository } from 'src/repositories/storage-target.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { getFilenameExtension } from 'src/utils/file';

export type RemoteCacheDeps = {
  logger: LoggingRepository;
  storageRepository: StorageRepository;
  storageTargetRepository: StorageTargetRepository;
  remoteStorageRepository: RemoteStorageRepository;
};

export type OffloadableAsset = {
  id: string;
  ownerId: string;
  originalPath: string;
  originalFileName?: string;
};

/**
 * Two requests for the same offloaded asset arrive together all the time -- the
 * web viewer asks for the full-size image while the download button is pressed,
 * for instance. Without this, both would pull the whole object down. Keyed by
 * cache path, cleared as soon as the download settles either way.
 */
const inFlight = new Map<string, Promise<string>>();

export const getRemoteCachePath = (asset: OffloadableAsset): string => {
  const extension = getFilenameExtension(asset.originalFileName ?? asset.originalPath);
  return StorageCore.getNestedPath(StorageFolder.RemoteCache, asset.ownerId, `${asset.id}${extension}`);
};

/**
 * Resolve the local path to an asset's original bytes, pulling them back from the
 * storage target first if the local copy has been offloaded.
 *
 * The happy path is a single `access()` call: an asset that still has its bytes
 * on disk never touches the database or the network, so every caller can route
 * through here without paying for the feature when it is unused.
 *
 * Returns the original path unchanged when the file is simply missing and no
 * remote copy is recorded, so callers keep whatever "file not found" behaviour
 * they had before.
 */
export const resolveOriginalPath = async (deps: RemoteCacheDeps, asset: OffloadableAsset): Promise<string> => {
  const { logger, storageRepository, storageTargetRepository, remoteStorageRepository } = deps;

  if (await storageRepository.checkFileExists(asset.originalPath)) {
    return asset.originalPath;
  }

  const location = await storageTargetRepository.getOffloadLocation(asset.id);
  if (!location) {
    return asset.originalPath;
  }

  const cachePath = getRemoteCachePath(asset);

  if (await storageRepository.checkFileExists(cachePath)) {
    // Bump mtime so the cleanup sweep ages entries by last use, not by when they
    // were first pulled down. A failure here only costs an early eviction.
    await storageRepository.utimes(cachePath, new Date(), new Date()).catch(() => {});
    return cachePath;
  }

  const existing = inFlight.get(cachePath);
  if (existing) {
    return existing;
  }

  const target: StorageTargetRef = {
    id: location.id,
    updatedAt: location.updatedAt,
    config: location.config,
    secret: location.secret,
  };

  const download = (async () => {
    logger.debug(`Fetching offloaded original for asset ${asset.id} from target "${location.name}"`);

    storageRepository.mkdirSync(join(cachePath, '..'));

    // Download to a scratch name and rename into place, so a connection that
    // drops halfway cannot leave a truncated file that later reads as a cache hit.
    const partialPath = `${cachePath}.${process.pid}.partial`;

    try {
      const remote = await remoteStorageRepository.createReadStream(target, location.remoteKey);
      await pipeline(remote, storageRepository.createWriteStream(partialPath));
      await storageRepository.rename(partialPath, cachePath);
      return cachePath;
    } catch (error) {
      await storageRepository.unlink(partialPath).catch(() => {});
      throw error;
    }
  })();

  inFlight.set(cachePath, download);

  try {
    return await download;
  } finally {
    inFlight.delete(cachePath);
  }
};
