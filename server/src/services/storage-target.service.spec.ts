import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  JobName,
  StorageTargetKind,
  StorageTransferDirection,
  StorageTransferScopeType,
  StorageTransferStatus,
} from 'src/enum.js';
import { StorageTargetService } from 'src/services/storage-target.service.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** What a client sends: one flat shape regardless of kind. */
const s3ConfigDto = {
  endpoint: 'http://minio:9000',
  bucket: 'immich',
  region: 'us-east-1',
  forcePathStyle: true,
  baseUrl: '',
  basePath: '',
  prefix: 'photos',
};

/** What gets stored: narrowed to the declared kind. */
const s3Config = {
  kind: StorageTargetKind.S3 as const,
  endpoint: 'http://minio:9000',
  bucket: 'immich',
  region: 'us-east-1',
  forcePathStyle: true,
  prefix: 'photos',
};

/** What a client sends: no `kind`, the config already carries it. */
const s3SecretDto = {
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
};

/** What gets stored: narrowed to the configured kind. */
const s3Secret = {
  kind: StorageTargetKind.S3 as const,
  ...s3SecretDto,
};

const targetStub = {
  id: 'target-1',
  name: 'MinIO',
  kind: StorageTargetKind.S3,
  config: s3Config,
  secret: s3Secret,
  isEnabled: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  updateId: 'update-1',
};

const transferStub = {
  id: 'transfer-1',
  targetId: 'target-1',
  ownerId: 'user-1',
  direction: StorageTransferDirection.Export,
  status: StorageTransferStatus.Pending,
  scope: { type: StorageTransferScopeType.All } as const,
  totalCount: 0,
  completedCount: 0,
  failedCount: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  prefix: null,
  runId: null as string | null,
  skippedCount: 0,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  updateId: 'update-1',
};

describe(StorageTargetService.name, () => {
  let sut: StorageTargetService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageTargetService));

    mocks.remoteStorage.evict.mockReturnValue(void 0);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should never expose stored credentials', async () => {
      mocks.storageTarget.getAll.mockResolvedValue([targetStub]);

      const [target] = await sut.getAll();

      expect(target).not.toHaveProperty('secret');
      expect(target.hasCredentials).toBe(true);
      // The response widens the stored, kind-specific config back to the flat shape.
      expect(target.config).toEqual(s3ConfigDto);
    });
  });

  describe('get', () => {
    it('should throw when the target does not exist', async () => {
      mocks.storageTarget.get.mockResolvedValue(void 0);
      await expect(sut.get('target-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('transfer control', () => {
    const transferStub = {
      id: 'transfer-1',
      targetId: targetStub.id,
      ownerId: 'user-1',
      direction: StorageTransferDirection.Offload,
      status: StorageTransferStatus.Running,
      scope: { type: StorageTransferScopeType.All } as const,
      totalCount: 10,
      completedCount: 4,
      failedCount: 0,
      startedAt: new Date('2026-01-01'),
      finishedAt: null,
      error: null,
      prefix: null,
      runId: null as string | null,
      skippedCount: 0,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      updateId: 'update-1',
    };

    it('should pause a running transfer', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue(transferStub);
      mocks.storageTarget.updateTransfer.mockResolvedValue({
        ...transferStub,
        status: StorageTransferStatus.Paused,
      });

      await sut.pauseTransfer('transfer-1');

      expect(mocks.storageTarget.updateTransfer).toHaveBeenCalledWith('transfer-1', {
        status: StorageTransferStatus.Paused,
      });
    });

    it('should refuse to pause a transfer that has already finished', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({
        ...transferStub,
        status: StorageTransferStatus.Completed,
      });

      await expect(sut.pauseTransfer('transfer-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storageTarget.updateTransfer).not.toHaveBeenCalled();
    });

    it('should resume under a new run, keeping what the stopped run completed', async () => {
      // An offload walk leaves finished assets out, so the completed count carries
      // over and the transfer continues instead of appearing to start again.
      mocks.storageTarget.getTransfer.mockResolvedValue({
        ...transferStub,
        status: StorageTransferStatus.Paused,
        runId: 'run-1',
        failedCount: 2,
      });
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.updateTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Pending });

      await sut.resumeTransfer('transfer-1');

      expect(mocks.storageTarget.updateTransfer).toHaveBeenCalledWith('transfer-1', {
        status: StorageTransferStatus.Pending,
        runId: expect.any(String),
        failedCount: 0,
        skippedCount: 0,
        finishedAt: null,
        error: null,
      });
      // A fresh run is what keeps jobs queued before the pause from acting again.
      expect(mocks.storageTarget.updateTransfer.mock.calls[0][1].runId).not.toBe('run-1');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.StorageTargetOffloadQueue,
        data: { transferId: 'transfer-1' },
      });
    });

    it('should restart the count when resuming an export', async () => {
      // An export walks every asset and counts the ones already on the target as
      // it goes, so keeping the old count would count those twice.
      mocks.storageTarget.getTransfer.mockResolvedValue({
        ...transferStub,
        direction: StorageTransferDirection.Export,
        status: StorageTransferStatus.Paused,
      });
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.updateTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Pending });

      await sut.resumeTransfer('transfer-1');

      expect(mocks.storageTarget.updateTransfer).toHaveBeenCalledWith(
        'transfer-1',
        expect.objectContaining({ totalCount: 0, completedCount: 0 }),
      );
    });

    it('should only resume a paused transfer', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue(transferStub);

      await expect(sut.resumeTransfer('transfer-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should not resume onto a disabled target', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Paused });
      mocks.storageTarget.get.mockResolvedValue({ ...targetStub, isEnabled: false });

      await expect(sut.resumeTransfer('transfer-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should cancel a paused transfer', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Paused });
      mocks.storageTarget.updateTransfer.mockResolvedValue({
        ...transferStub,
        status: StorageTransferStatus.Cancelled,
      });

      await sut.cancelTransfer('transfer-1');

      expect(mocks.storageTarget.updateTransfer).toHaveBeenCalledWith('transfer-1', {
        status: StorageTransferStatus.Cancelled,
        finishedAt: expect.any(Date),
      });
    });

    it('should refuse to cancel a transfer that has already finished', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Cancelled });

      await expect(sut.cancelTransfer('transfer-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    const failureStub = {
      id: 'item-1',
      transferId: 'transfer-1',
      itemKey: 'asset-1',
      assetId: 'asset-1' as string | null,
      remoteKey: null as string | null,
      fileName: 'IMG_0001.jpg' as string | null,
      size: 1024 as number | null,
      attempts: 1,
      error: 'Access Denied',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };

    it('should clear recorded failures when resuming, since the new walk retries them', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Paused });
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.updateTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Pending });

      await sut.resumeTransfer('transfer-1');

      expect(mocks.storageTarget.clearTransferFailures).toHaveBeenCalledWith('transfer-1');
    });

    it('should retry failures under the current run and take them off the failed count', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({
        ...transferStub,
        status: StorageTransferStatus.Failed,
        runId: 'run-1',
        failedCount: 2,
      });
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.getTransferFailuresForRetry.mockResolvedValue([
        failureStub,
        { ...failureStub, id: 'item-2', itemKey: 'asset-2', assetId: 'asset-2' },
      ]);

      await expect(sut.retryTransferFailures('transfer-1', {})).resolves.toEqual({ count: 2 });

      expect(mocks.storageTarget.reopenTransferForRetry).toHaveBeenCalledWith('transfer-1', 2);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.StorageTargetOffloadAsset,
          data: { transferId: 'transfer-1', runId: 'run-1', assetId: 'asset-1' },
        },
        {
          name: JobName.StorageTargetOffloadAsset,
          data: { transferId: 'transfer-1', runId: 'run-1', assetId: 'asset-2' },
        },
      ]);
    });

    it('should retry an import failure by its remote key', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({
        ...transferStub,
        direction: StorageTransferDirection.Import,
        status: StorageTransferStatus.Completed,
      });
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.getTransferFailuresForRetry.mockResolvedValue([
        { ...failureStub, itemKey: 'user-1/IMG_0002.jpg', assetId: null, remoteKey: 'user-1/IMG_0002.jpg', size: 42 },
      ]);

      await sut.retryTransferFailures('transfer-1', { itemIds: ['item-1'] });

      expect(mocks.storageTarget.getTransferFailuresForRetry).toHaveBeenCalledWith('transfer-1', ['item-1']);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.StorageTargetImportObject,
          data: { transferId: 'transfer-1', runId: undefined, remoteKey: 'user-1/IMG_0002.jpg', size: 42 },
        },
      ]);
    });

    it('should not retry the failures of a paused transfer', async () => {
      // Resuming walks everything outstanding, failures included, so a retry on
      // top would only race it.
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Paused });

      await expect(sut.retryTransferFailures('transfer-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should refuse to remove a transfer that is still going', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue(transferStub);

      await expect(sut.deleteTransfer('transfer-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storageTarget.deleteTransfers).not.toHaveBeenCalled();
    });

    it('should remove a finished transfer from the history', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue({ ...transferStub, status: StorageTransferStatus.Completed });

      await sut.deleteTransfer('transfer-1');

      expect(mocks.storageTarget.deleteTransfers).toHaveBeenCalledWith(['transfer-1']);
    });

    it('should clear only finished transfers from the history', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.deleteTransfersByStatus.mockResolvedValue(3);

      await expect(sut.clearTransferHistory('target-1')).resolves.toEqual({ count: 3 });

      const [, statuses] = mocks.storageTarget.deleteTransfersByStatus.mock.calls[0];
      expect(statuses).toEqual(
        expect.arrayContaining([
          StorageTransferStatus.Completed,
          StorageTransferStatus.Failed,
          StorageTransferStatus.Cancelled,
        ]),
      );
      // Work still on the queue needs its transfer to report to.
      expect(statuses).not.toContain(StorageTransferStatus.Paused);
      expect(statuses).not.toContain(StorageTransferStatus.Running);
    });

    it('should report a transfer that does not exist', async () => {
      mocks.storageTarget.getTransfer.mockResolvedValue(void 0);

      await expect(sut.pauseTransfer('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('should reject credentials that do not fit the configured kind', async () => {
      await expect(
        sut.create({
          name: 'Mismatched',
          kind: StorageTargetKind.S3,
          config: s3ConfigDto,
          secret: { username: 'alice', password: 'hunter2' },
          isEnabled: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.storageTarget.create).not.toHaveBeenCalled();
    });

    it('should reject an endpoint that already contains the bucket', async () => {
      // Copied straight out of a provider's console. With path-style addressing
      // this addresses the bucket twice and the service answers NoSuchKey, so it
      // is refused at configuration time instead.
      await expect(
        sut.create({
          name: 'Contabo',
          kind: StorageTargetKind.S3,
          config: { ...s3ConfigDto, endpoint: 'https://eu2.contabostorage.com/immich', bucket: 'immich' },
          secret: { accessKeyId: 'key', secretAccessKey: 'secret' },
          isEnabled: true,
        }),
      ).rejects.toThrow(/must not include the bucket/);

      expect(mocks.storageTarget.create).not.toHaveBeenCalled();
    });

    it('should accept the same endpoint without the bucket in its path', async () => {
      mocks.storageTarget.getByName.mockResolvedValue(void 0);
      mocks.storageTarget.create.mockResolvedValue(targetStub);

      await sut.create({
        name: 'Contabo',
        kind: StorageTargetKind.S3,
        config: { ...s3ConfigDto, endpoint: 'https://eu2.contabostorage.com', bucket: 'immich' },
        secret: { accessKeyId: 'key', secretAccessKey: 'secret' },
        isEnabled: true,
      });

      expect(mocks.storageTarget.create).toHaveBeenCalled();
    });

    it('should leave a path that is not the bucket alone, for S3 behind a proxy', async () => {
      mocks.storageTarget.getByName.mockResolvedValue(void 0);
      mocks.storageTarget.create.mockResolvedValue(targetStub);

      await sut.create({
        name: 'Proxied',
        kind: StorageTargetKind.S3,
        config: { ...s3ConfigDto, endpoint: 'https://gateway.example.com/s3', bucket: 'immich' },
        secret: { accessKeyId: 'key', secretAccessKey: 'secret' },
        isEnabled: true,
      });

      expect(mocks.storageTarget.create).toHaveBeenCalled();
    });

    it('should reject an endpoint that is not a URL', async () => {
      await expect(
        sut.create({
          name: 'Broken',
          kind: StorageTargetKind.S3,
          config: { ...s3ConfigDto, endpoint: 'eu2.contabostorage.com' },
          secret: { accessKeyId: 'key', secretAccessKey: 'secret' },
          isEnabled: true,
        }),
      ).rejects.toThrow(/must be a full URL/);
    });

    it('should not require credentials for a local target', async () => {
      const localConfig = { ...s3ConfigDto, basePath: '/mnt/backup', prefix: '' };
      mocks.storageTarget.getByName.mockResolvedValue(void 0);
      mocks.storageTarget.create.mockResolvedValue({ ...targetStub, kind: StorageTargetKind.Local });

      await sut.create({
        name: 'NAS',
        kind: StorageTargetKind.Local,
        config: localConfig,
        secret: {},
        isEnabled: true,
      });

      expect(mocks.storageTarget.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: StorageTargetKind.Local, secret: { kind: StorageTargetKind.Local } }),
      );
    });

    it('should reject a duplicate name', async () => {
      mocks.storageTarget.getByName.mockResolvedValue(targetStub);

      await expect(
        sut.create({
          name: 'MinIO',
          kind: StorageTargetKind.S3,
          config: s3ConfigDto,
          secret: s3SecretDto,
          isEnabled: true,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.storageTarget.create).not.toHaveBeenCalled();
    });

    it('should create a target and derive the kind from the config', async () => {
      mocks.storageTarget.getByName.mockResolvedValue(void 0);
      mocks.storageTarget.create.mockResolvedValue(targetStub);

      await sut.create({
        name: 'MinIO',
        kind: StorageTargetKind.S3,
        config: s3ConfigDto,
        secret: s3SecretDto,
        isEnabled: true,
      });

      expect(mocks.storageTarget.create).toHaveBeenCalledWith({
        name: 'MinIO',
        kind: StorageTargetKind.S3,
        config: s3Config,
        secret: s3Secret,
        isEnabled: true,
      });
    });
  });

  describe('update', () => {
    it('should keep the stored secret when none is supplied', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.update.mockResolvedValue(targetStub);

      await sut.update('target-1', { isEnabled: false });

      expect(mocks.storageTarget.update).toHaveBeenCalledWith(
        'target-1',
        expect.objectContaining({ secret: s3Secret, isEnabled: false }),
      );
    });

    it('should reject a config that is missing what the kind needs', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);

      await expect(sut.update('target-1', { config: { ...s3ConfigDto, bucket: '' } })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.storageTarget.update).not.toHaveBeenCalled();
    });

    it('should evict the cached driver so the next call uses the new config', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.storageTarget.update.mockResolvedValue(targetStub);

      await sut.update('target-1', { name: 'MinIO' });

      expect(mocks.remoteStorage.evict).toHaveBeenCalledWith('target-1');
    });
  });

  describe('test', () => {
    it('should report a failure in the body rather than throwing', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.remoteStorage.test.mockRejectedValue(new Error('Access Denied'));

      await expect(sut.test('target-1')).resolves.toEqual({ ok: false, error: 'Access Denied' });
    });

    it('should report success', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.remoteStorage.test.mockResolvedValue(void 0);

      await expect(sut.test('target-1')).resolves.toEqual({ ok: true });
    });
  });

  describe('startExport', () => {
    it('should refuse to use a disabled target', async () => {
      mocks.storageTarget.get.mockResolvedValue({ ...targetStub, isEnabled: false });

      await expect(
        sut.startExport('target-1', { ownerId: 'user-1', scope: { type: StorageTransferScopeType.All } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should queue an export and return the transfer', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.user.get.mockResolvedValue({ id: 'user-1' } as never);
      mocks.storageTarget.createTransfer.mockResolvedValue(transferStub);

      const transfer = await sut.startExport('target-1', {
        ownerId: 'user-1',
        scope: { type: StorageTransferScopeType.All },
      });

      expect(transfer.id).toBe('transfer-1');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'StorageTargetExportQueue',
        data: { transferId: 'transfer-1' },
      });
    });
  });

  describe('startImport', () => {
    it('should queue a scan of the target', async () => {
      mocks.storageTarget.get.mockResolvedValue(targetStub);
      mocks.user.get.mockResolvedValue({ id: 'user-1' } as never);
      mocks.storageTarget.createTransfer.mockResolvedValue({
        ...transferStub,
        direction: StorageTransferDirection.Import,
      });

      await sut.startImport('target-1', { ownerId: 'user-1', scope: { type: StorageTransferScopeType.All } });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: 'StorageTargetImportScan',
        data: { transferId: 'transfer-1' },
      });
    });
  });
});
