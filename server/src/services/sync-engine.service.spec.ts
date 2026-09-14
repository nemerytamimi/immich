import { Readable, Writable } from 'node:stream';
import { NODE_SYNC_MAX_ATTEMPTS } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { AssetVisibility, JobStatus, SyncNodeStatus } from 'src/enum';
import { SyncEngineService } from 'src/services/sync-engine.service';
import { newTestService, ServiceMocks } from 'test/utils';

const nodeStub = {
  id: 'node-1',
  name: 'Peer',
  url: 'https://peer.example',
  apiKey: 'peer-key',
  isEnabled: true,
  status: SyncNodeStatus.Online,
  remoteVersion: '3.1.0',
  lastCheckedAt: new Date('2026-01-01'),
  error: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  updateId: 'update-1',
};

const pairingStub = {
  id: 'pairing-1',
  nodeId: 'node-1',
  localUserId: 'user-1',
  remoteUserId: 'remote-user-1',
  remoteUserEmail: 'alice@peer.example',
  apiKey: 'paired-user-key',
  pushEnabled: true,
  pullEnabled: true,
  pushCursor: null,
  pullCursor: null,
  lastSyncedAt: null,
  error: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  updateId: 'update-1',
};

const assetStub = {
  id: 'asset-1',
  ownerId: 'user-1',
  originalPath: '/data/library/user-1/IMG_0001.jpg',
  originalFileName: 'IMG_0001.jpg',
  checksum: Buffer.from('checksum'),
  type: 'IMAGE',
  isFavorite: false,
  visibility: AssetVisibility.Timeline,
  fileCreatedAt: new Date('2026-01-01'),
  fileModifiedAt: new Date('2026-01-01'),
  deletedAt: null,
  updateId: 'asset-update-1',
  isExternal: false,
  isOffline: false,
  description: null,
};

const mappingStub = {
  id: 'mapping-1',
  nodeUserId: 'pairing-1',
  localAssetId: 'asset-1',
  remoteAssetId: 'remote-asset-1',
  checksum: Buffer.from('checksum'),
  origin: 'push',
  metadataUpdateId: 'asset-update-1',
  trashSyncedAt: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const setupDownload = (mocks: ServiceMocks) => {
  mocks.storage.mkdirSync.mockReturnValue(void 0);
  mocks.nodeClient.getRemoteAsset.mockResolvedValue({
    id: 'remote-1',
    originalFileName: 'IMG_9000.jpg',
    fileCreatedAt: '2026-01-01T00:00:00.000Z',
    fileModifiedAt: '2026-01-01T00:00:00.000Z',
    isFavorite: true,
    isArchived: false,
    checksum: 'abc',
    type: 'IMAGE',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  mocks.nodeClient.downloadAsset.mockResolvedValue(Readable.from(['bytes']));
  mocks.storage.createWriteStream.mockImplementation(
    () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
  );
  mocks.crypto.hashFile.mockResolvedValue(Buffer.from('checksum'));
  mocks.storage.stat.mockResolvedValue({ size: 5 } as never);
};

describe(SyncEngineService.name, () => {
  let sut: SyncEngineService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SyncEngineService));

    StorageCore.setMediaLocation('/data');

    mocks.syncNode.getPairing.mockResolvedValue(pairingStub);
    mocks.syncNode.get.mockResolvedValue(nodeStub);
    mocks.syncNode.updatePairing.mockResolvedValue(pairingStub);
    mocks.syncNode.getChangedAssets.mockResolvedValue([]);
    mocks.syncNode.getMappingsByRemoteIds.mockResolvedValue([]);
    mocks.syncNode.upsertAssetMapping.mockResolvedValue(mappingStub);
    mocks.syncNode.updateAssetMapping.mockResolvedValue(mappingStub);
    mocks.syncNode.getAssetMetadata.mockResolvedValue(void 0);
    mocks.syncNode.getAssetTagValues.mockResolvedValue([]);
    mocks.nodeClient.getFaces.mockResolvedValue([]);
    mocks.person.getFaces.mockResolvedValue([]);
    mocks.nodeClient.searchAssets.mockResolvedValue({ items: [], nextPage: null });
    mocks.nodeClient.updateAsset.mockResolvedValue(void 0);
    mocks.nodeClient.trashAssets.mockResolvedValue(void 0);
    mocks.nodeClient.getAlbums.mockResolvedValue([]);
    mocks.syncNode.getAlbumsForOwner.mockResolvedValue([]);
    mocks.syncNode.getAlbumMappings.mockResolvedValue([]);
    mocks.storage.checkFileExists.mockResolvedValue(false);
    mocks.syncNode.markQueued.mockResolvedValue(void 0);
    mocks.syncNode.markSucceeded.mockResolvedValue(void 0);
    mocks.syncNode.markFailed.mockResolvedValue(void 0);
    mocks.syncNode.getRetryableItems.mockResolvedValue([]);
    mocks.syncNode.getAssetsByIds.mockResolvedValue([assetStub] as never);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueAll', () => {
    it('should queue one job per syncable pairing', async () => {
      mocks.syncNode.getSyncablePairings.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never);

      await expect(sut.handleQueueAll()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledTimes(2);
    });
  });

  describe('handlePair', () => {
    it('should skip a pairing that no longer exists', async () => {
      mocks.syncNode.getPairing.mockResolvedValue(void 0);

      await expect(sut.handlePair({ pairingId: 'gone' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should skip a node that has been disabled', async () => {
      mocks.syncNode.get.mockResolvedValue({ ...nodeStub, isEnabled: false });

      await expect(sut.handlePair({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Skipped);
    });

    it('should record the error on the pairing when a run fails', async () => {
      mocks.syncNode.getChangedAssets.mockRejectedValue(new Error('peer exploded'));

      await expect(sut.handlePair({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.syncNode.updatePairing).toHaveBeenCalledWith(
        'pairing-1',
        expect.objectContaining({ error: 'peer exploded' }),
      );
    });

    it('should not push when push is disabled for the pairing', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pushEnabled: false, pullEnabled: false });

      await expect(sut.handlePair({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.syncNode.getChangedAssets).not.toHaveBeenCalled();
      expect(mocks.nodeClient.searchAssets).not.toHaveBeenCalled();
    });

    it('should queue one job per asset so transfers can run in parallel', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pullEnabled: false });
      mocks.syncNode.getChangedAssets.mockResolvedValueOnce([
        { ...assetStub, id: 'a', updateId: 'u1' },
        { ...assetStub, id: 'b', updateId: 'u2' },
      ] as never);

      await sut.handlePair({ pairingId: 'pairing-1' });

      const pushJobs = mocks.job.queue.mock.calls.filter(([job]) => job.name === 'NodeSyncPushAsset');
      expect(pushJobs).toHaveLength(2);
      expect(mocks.syncNode.markQueued).toHaveBeenCalledWith('pairing-1', 'push', ['a', 'b']);
    });

    it('should advance the cursor once a page is queued, not once it has finished', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pullEnabled: false });
      mocks.syncNode.getChangedAssets.mockResolvedValueOnce([
        { ...assetStub, id: 'a', updateId: 'u1' },
        { ...assetStub, id: 'b', updateId: 'u2' },
      ] as never);

      // A single difficult asset must not pin the cursor and make every later
      // run re-attempt the same page.
      await sut.handlePair({ pairingId: 'pairing-1' });

      expect(mocks.syncNode.updatePairing).toHaveBeenCalledWith('pairing-1', { pushCursor: 'u2' });
    });

    it('should queue a retry pass at the end of a run', async () => {
      await sut.handlePair({ pairingId: 'pairing-1' });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'NodeSyncRetryFailed',
        data: { pairingId: 'pairing-1' },
      });
    });

    it("should adopt the peer's copy when it already holds identical bytes", async () => {
      mocks.syncNode.getAssetMapping.mockResolvedValue(void 0);
      mocks.nodeClient.bulkUploadCheck.mockResolvedValue({
        'asset-1': { action: 'reject', assetId: 'remote-existing' },
      });

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.uploadAsset).not.toHaveBeenCalled();
      expect(mocks.syncNode.upsertAssetMapping).toHaveBeenCalledWith(
        expect.objectContaining({ remoteAssetId: 'remote-existing', origin: 'push-dedupe' }),
      );
      // Two copies that each lived their own life are compared straight away.
      expect(mocks.syncNode.getAssetMetadata).toHaveBeenCalledWith('asset-1');
    });

    it('should record a failed push instead of aborting the run', async () => {
      mocks.syncNode.getAssetMapping.mockResolvedValue(void 0);
      mocks.nodeClient.bulkUploadCheck.mockRejectedValue(new Error('peer timed out'));

      await expect(sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.syncNode.markFailed).toHaveBeenCalledWith('pairing-1', 'push', 'asset-1', 'peer timed out');
      expect(mocks.syncNode.markSucceeded).not.toHaveBeenCalled();
    });

    it('should clear an item from the ledger once it succeeds', async () => {
      mocks.syncNode.getAssetMapping.mockResolvedValue(mappingStub);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.syncNode.markSucceeded).toHaveBeenCalledWith('pairing-1', 'push', 'asset-1');
    });

    it('should propagate a local trash to the peer exactly once', async () => {
      mocks.syncNode.getAssetsByIds.mockResolvedValue([{ ...assetStub, deletedAt: new Date('2026-02-01') }] as never);
      mocks.syncNode.getAssetMapping.mockResolvedValue(mappingStub);
      mocks.syncNode.updateAssetMapping.mockResolvedValue(mappingStub);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.trashAssets).toHaveBeenCalledWith(expect.anything(), ['remote-asset-1']);
      expect(mocks.syncNode.updateAssetMapping).toHaveBeenCalledWith(
        'mapping-1',
        expect.objectContaining({ trashSyncedAt: expect.any(Date) }),
      );
    });

    it('should not re-trash an asset whose deletion already travelled', async () => {
      mocks.syncNode.getAssetsByIds.mockResolvedValue([{ ...assetStub, deletedAt: new Date('2026-02-01') }] as never);
      mocks.syncNode.getAssetMapping.mockResolvedValue({ ...mappingStub, trashSyncedAt: new Date('2026-02-02') });

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.trashAssets).not.toHaveBeenCalled();
    });

    it('should never queue an external or offline asset, having no local bytes', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pullEnabled: false });
      mocks.syncNode.getChangedAssets.mockResolvedValueOnce([
        { ...assetStub, id: 'ext', isExternal: true },
        { ...assetStub, id: 'off', isOffline: true },
      ] as never);

      await sut.handlePair({ pairingId: 'pairing-1' });

      const pushJobs = mocks.job.queue.mock.calls.filter(([job]) => job.name === 'NodeSyncPushAsset');
      expect(pushJobs).toHaveLength(0);
      // Not queued means not in the ledger, so they never look like outstanding work.
      expect(mocks.syncNode.markQueued).toHaveBeenCalledWith('pairing-1', 'push', []);
    });

    it('should queue unseen remote assets, and matched ones the peer changed since they were compared', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pushEnabled: false });
      mocks.nodeClient.searchAssets.mockResolvedValue({
        items: [
          { id: 'remote-unchanged', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'remote-changed', updatedAt: '2026-03-01T00:00:00.000Z' },
          { id: 'remote-new', updatedAt: '2026-03-01T00:00:00.000Z' },
        ],
        nextPage: null,
      } as never);
      mocks.syncNode.getMappingsByRemoteIds.mockResolvedValue([
        { remoteAssetId: 'remote-unchanged', updatedAt: new Date('2026-02-01T00:00:00.000Z') },
        { remoteAssetId: 'remote-changed', updatedAt: new Date('2026-02-01T00:00:00.000Z') },
      ] as never);

      await sut.handlePair({ pairingId: 'pairing-1' });

      const pullJobs = mocks.job.queue.mock.calls.filter(([job]) => job.name === 'NodeSyncPullAsset');
      expect(pullJobs.map(([job]) => job.data)).toEqual([
        { pairingId: 'pairing-1', assetId: 'remote-changed' },
        { pairingId: 'pairing-1', assetId: 'remote-new' },
      ]);
    });
  });

  describe('metadata reconciliation', () => {
    const localMetadataStub = {
      id: 'asset-1',
      ownerId: 'user-1',
      isFavorite: false,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      updateId: 'asset-update-2',
      dateTimeOriginal: null as Date | null,
      timeZone: null,
      latitude: null,
      longitude: null,
      rating: null,
      description: '',
      exifUpdatedAt: new Date('2026-03-01T00:00:00.000Z'),
    };

    const remoteWithMetadata = {
      id: 'remote-asset-1',
      checksum: 'abc',
      originalFileName: 'IMG_0001.jpg',
      fileCreatedAt: '2019-07-14T10:00:00.000Z',
      fileModifiedAt: '2019-07-14T10:00:00.000Z',
      isFavorite: true,
      isArchived: false,
      visibility: 'timeline',
      type: 'IMAGE',
      updatedAt: '2026-01-01T00:00:00.000Z',
      exifInfo: {
        dateTimeOriginal: '2019-07-14T10:00:00.000Z' as string | null,
        timeZone: 'UTC',
        latitude: 31.77,
        longitude: 35.21,
        rating: 5,
        description: 'Old city' as string | null,
      },
      tags: [{ id: 'remote-tag-1', value: 'travel' }],
    };

    const faceBox = { imageWidth: 1000, imageHeight: 1000, boundingBoxX1: 100, boundingBoxY1: 100 };

    beforeEach(() => {
      // The asset changed since the mapping last compared it, so the push compares metadata.
      mocks.syncNode.getAssetsByIds.mockResolvedValue([{ ...assetStub, updateId: 'asset-update-2' }] as never);
      mocks.syncNode.getAssetMapping.mockResolvedValue(mappingStub);
      mocks.syncNode.getAssetMetadata.mockResolvedValue(localMetadataStub as never);
      mocks.nodeClient.getRemoteAsset.mockResolvedValue(remoteWithMetadata);
      mocks.tag.upsertValue.mockResolvedValue({ id: 'tag-1', value: 'travel' } as never);
      mocks.tag.upsertAssetIds.mockResolvedValue([]);
    });

    it('should restore what this node lost from the peer', async () => {
      await expect(sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
        exif: expect.objectContaining({
          assetId: 'asset-1',
          dateTimeOriginal: new Date('2019-07-14T10:00:00.000Z'),
          latitude: 31.77,
          longitude: 35.21,
          rating: 5,
          description: 'Old city',
          // Locked, so re-reading the file does not put back the value that was missing.
          lockedProperties: expect.arrayContaining(['dateTimeOriginal', 'description']),
        }),
        lockedPropertiesBehavior: 'append',
      });
      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'asset-1', isFavorite: true }));
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([{ tagId: 'tag-1', assetId: 'asset-1' }]);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: 'SidecarWrite', data: { id: 'asset-1' } });
      // The peer already had all of it, so nothing goes back.
      expect(mocks.nodeClient.updateAsset).not.toHaveBeenCalled();
    });

    it('should fill in on the peer what only this node has', async () => {
      mocks.syncNode.getAssetMetadata.mockResolvedValue({
        ...localMetadataStub,
        dateTimeOriginal: new Date('2019-07-14T10:00:00.000Z'),
        description: 'Only here',
      } as never);
      mocks.nodeClient.getRemoteAsset.mockResolvedValue({
        ...remoteWithMetadata,
        exifInfo: { ...remoteWithMetadata.exifInfo, description: null },
      });

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.updateAsset).toHaveBeenCalledWith(
        expect.anything(),
        'remote-asset-1',
        expect.objectContaining({ description: 'Only here' }),
      );
    });

    it('should not write to the peer when the pairing does not push', async () => {
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pushEnabled: false });
      mocks.syncNode.getAssetMetadata.mockResolvedValue({
        ...localMetadataStub,
        dateTimeOriginal: new Date('2019-07-14T10:00:00.000Z'),
        description: 'Only here',
      } as never);
      mocks.nodeClient.getRemoteAsset.mockResolvedValue({
        ...remoteWithMetadata,
        exifInfo: { ...remoteWithMetadata.exifInfo, description: null },
      });

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.updateAsset).not.toHaveBeenCalled();
      expect(mocks.nodeClient.tagAssets).not.toHaveBeenCalled();
    });

    it('should remember the local version it compared, so an unchanged asset is not compared again', async () => {
      mocks.syncNode.getAssetMetadata
        .mockResolvedValueOnce(localMetadataStub as never)
        .mockResolvedValueOnce({ ...localMetadataStub, updateId: 'asset-update-3' } as never);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.syncNode.updateAssetMapping).toHaveBeenCalledWith('mapping-1', {
        metadataUpdateId: 'asset-update-3',
        updatedAt: expect.any(Date),
      });
    });

    it('should not compare an asset that has not changed since it was last compared', async () => {
      mocks.syncNode.getAssetsByIds.mockResolvedValue([assetStub] as never);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.getRemoteAsset).not.toHaveBeenCalled();
    });

    it('should name a face here that only the peer has named', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          ...faceBox,
          id: 'local-face',
          boundingBoxX2: 300,
          boundingBoxY2: 300,
          personGroupId: 'local-cluster',
          person: { name: '' },
        },
      ] as never);
      mocks.nodeClient.getFaces.mockResolvedValue([
        {
          id: 'remote-face',
          imageWidth: 2000,
          imageHeight: 2000,
          boundingBoxX1: 200,
          boundingBoxY1: 200,
          boundingBoxX2: 600,
          boundingBoxY2: 600,
          person: { id: 'remote-sara', name: 'Sara' },
        },
      ]);
      mocks.person.getByName.mockResolvedValue([]);
      mocks.person.update.mockResolvedValue({} as never);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      // The face's unnamed cluster is named, so the rest of the cluster comes along.
      expect(mocks.person.update).toHaveBeenCalledWith({
        ownerId: 'user-1',
        personGroupId: 'local-cluster',
        name: 'Sara',
      });
    });

    it('should reuse a person the peer already has by that exact name', async () => {
      mocks.person.getFaces.mockResolvedValue([
        {
          ...faceBox,
          id: 'local-face',
          boundingBoxX2: 300,
          boundingBoxY2: 300,
          personGroupId: 'local-omar',
          person: { name: 'Omar' },
        },
      ] as never);
      mocks.nodeClient.getFaces.mockResolvedValue([
        { id: 'remote-face', ...faceBox, boundingBoxX2: 300, boundingBoxY2: 300, person: null },
      ]);
      // The peer's person search is fuzzy, so a near miss comes back alongside the real match.
      mocks.nodeClient.searchPeople.mockResolvedValue([
        { id: 'remote-omari', name: 'Omari' },
        { id: 'remote-omar', name: 'omar' },
      ]);

      await sut.handlePushAsset({ pairingId: 'pairing-1', assetId: 'asset-1' });

      expect(mocks.nodeClient.reassignFace).toHaveBeenCalledWith(expect.anything(), 'remote-omar', 'remote-face');
      expect(mocks.nodeClient.createPerson).not.toHaveBeenCalled();
    });
  });

  describe('handleMetadataQueue', () => {
    it('should send every matched asset through the push job so its metadata is compared', async () => {
      mocks.syncNode.getAssetMappingPage.mockResolvedValueOnce([
        { id: 'mapping-1', localAssetId: 'asset-1' },
        { id: 'mapping-2', localAssetId: 'asset-2' },
      ]);

      await expect(sut.handleMetadataQueue({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.syncNode.markQueued).toHaveBeenCalledWith('pairing-1', 'push', ['asset-1', 'asset-2']);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: 'NodeSyncPushAsset', data: { pairingId: 'pairing-1', assetId: 'asset-1' } },
        { name: 'NodeSyncPushAsset', data: { pairingId: 'pairing-1', assetId: 'asset-2' } },
      ]);
    });
  });

  describe('handleRetryFailed', () => {
    it('should re-queue outstanding items in the direction they belong to', async () => {
      mocks.syncNode.getRetryableItems.mockResolvedValue([
        { direction: 'push', assetId: 'local-1' },
        { direction: 'pull', assetId: 'remote-1' },
      ] as never);

      await expect(sut.handleRetryFailed({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'NodeSyncPushAsset',
        data: { pairingId: 'pairing-1', assetId: 'local-1' },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'NodeSyncPullAsset',
        data: { pairingId: 'pairing-1', assetId: 'remote-1' },
      });
    });

    it('should leave items past the attempt ceiling alone', async () => {
      // The repository applies the ceiling, so nothing coming back means nothing
      // to do rather than an error.
      mocks.syncNode.getRetryableItems.mockResolvedValue([]);

      await expect(sut.handleRetryFailed({ pairingId: 'pairing-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should ask for retryable items using the shared attempt ceiling', async () => {
      await sut.handleRetryFailed({ pairingId: 'pairing-1' });

      expect(mocks.syncNode.getRetryableItems).toHaveBeenCalledWith(
        'pairing-1',
        NODE_SYNC_MAX_ATTEMPTS,
        expect.any(Number),
      );
    });
  });

  describe('handlePullAsset', () => {
    it('should compare metadata rather than download a remote asset already here', async () => {
      mocks.syncNode.getMappingByRemoteId.mockResolvedValue(mappingStub);

      await expect(sut.handlePullAsset({ pairingId: 'pairing-1', assetId: 'remote-1' })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.nodeClient.downloadAsset).not.toHaveBeenCalled();
      expect(mocks.syncNode.getAssetMetadata).toHaveBeenCalledWith('asset-1');
      expect(mocks.syncNode.markSucceeded).toHaveBeenCalledWith('pairing-1', 'pull', 'remote-1');
    });

    it('should stop pulling once the pairing is paused', async () => {
      // Pausing has to stop the downloads already on the queue, not just the
      // ones not yet queued -- otherwise a paused pull keeps transferring for as
      // long as the backlog lasts.
      mocks.syncNode.getPairing.mockResolvedValue({ ...pairingStub, pullEnabled: false });
      mocks.syncNode.getMappingByRemoteId.mockResolvedValue(void 0);
      setupDownload(mocks);

      await expect(sut.handlePullAsset({ pairingId: 'pairing-1', assetId: 'remote-1' })).resolves.toBe(
        JobStatus.Skipped,
      );

      expect(mocks.nodeClient.downloadAsset).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('should map rather than duplicate when the bytes are already here', async () => {
      mocks.syncNode.getMappingByRemoteId.mockResolvedValue(void 0);
      setupDownload(mocks);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('local-existing');

      await expect(sut.handlePullAsset({ pairingId: 'pairing-1', assetId: 'remote-1' })).resolves.toBe(
        JobStatus.Skipped,
      );

      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.syncNode.upsertAssetMapping).toHaveBeenCalledWith(
        expect.objectContaining({ localAssetId: 'local-existing', origin: 'pull-dedupe' }),
      );
    });

    it('should create the asset and queue metadata extraction', async () => {
      mocks.syncNode.getMappingByRemoteId.mockResolvedValue(void 0);
      setupDownload(mocks);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(void 0);
      mocks.asset.create.mockResolvedValue({ id: 'local-new' } as never);
      mocks.asset.upsertExif.mockResolvedValue(void 0);

      await expect(sut.handlePullAsset({ pairingId: 'pairing-1', assetId: 'remote-1' })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', originalFileName: 'IMG_9000.jpg', isFavorite: true }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'AssetExtractMetadata',
        data: { id: 'local-new', source: 'upload' },
      });
    });

    it('should clean up the partial download when the pull fails', async () => {
      mocks.syncNode.getMappingByRemoteId.mockResolvedValue(void 0);
      setupDownload(mocks);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(void 0);
      mocks.asset.create.mockRejectedValue(new Error('constraint'));

      await expect(sut.handlePullAsset({ pairingId: 'pairing-1', assetId: 'remote-1' })).resolves.toBe(
        JobStatus.Failed,
      );

      expect(mocks.job.queue).toHaveBeenCalledWith(expect.objectContaining({ name: 'FileDelete' }));
    });
  });
});
