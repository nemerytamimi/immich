import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AssetOffloadDto } from 'src/dtos/asset.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  mapStorageTarget,
  mapStorageTransfer,
  StorageTargetConfigDto,
  StorageTargetCreateDto,
  StorageTargetResponseDto,
  StorageTargetSecretDto,
  StorageTargetTestResponseDto,
  StorageTargetUpdateDto,
  StorageTransferCreateDto,
  StorageTransferResponseDto,
  StorageTransferScopeDto,
} from 'src/dtos/storage-target.dto';
import {
  JobName,
  Permission,
  StorageTargetKind,
  StorageTransferDirection,
  StorageTransferScopeType,
  StorageTransferStatus,
} from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { StorageTargetConfig, StorageTargetSecret, StorageTransferScope } from 'src/types';

const QUEUE_JOB_BY_DIRECTION = {
  [StorageTransferDirection.Export]: JobName.StorageTargetExportQueue,
  [StorageTransferDirection.Import]: JobName.StorageTargetImportScan,
  [StorageTransferDirection.Offload]: JobName.StorageTargetOffloadQueue,
  [StorageTransferDirection.Restore]: JobName.StorageTargetRestoreQueue,
} as const;

@Injectable()
export class StorageTargetService extends BaseService {
  async getAll(): Promise<StorageTargetResponseDto[]> {
    const targets = await this.storageTargetRepository.getAll();
    return targets.map((target) => mapStorageTarget(target));
  }

  /** Enabled targets only, for the user-facing offload picker. */
  async getAvailable(): Promise<StorageTargetResponseDto[]> {
    const targets = await this.storageTargetRepository.getAll();
    return targets.filter(({ isEnabled }) => isEnabled).map((target) => mapStorageTarget(target));
  }

  async get(id: string): Promise<StorageTargetResponseDto> {
    const target = await this.findOrFailTarget(id);
    return mapStorageTarget(target);
  }

  async create(dto: StorageTargetCreateDto): Promise<StorageTargetResponseDto> {
    const config = asConfig(dto.kind, dto.config);
    const secret = asSecret(dto.kind, dto.secret);

    const duplicate = await this.storageTargetRepository.getByName(dto.name);
    if (duplicate) {
      throw new BadRequestException('A storage target with that name already exists');
    }

    const target = await this.storageTargetRepository.create({
      name: dto.name,
      kind: dto.kind,
      config,
      secret,
      isEnabled: dto.isEnabled,
    });

    return mapStorageTarget(target);
  }

  async update(id: string, dto: StorageTargetUpdateDto): Promise<StorageTargetResponseDto> {
    const existing = await this.findOrFailTarget(id);

    // The kind is immutable, so an update always narrows against the stored one.
    const config = dto.config ? asConfig(existing.kind, dto.config) : (existing.config as StorageTargetConfig);

    // An omitted secret means "keep what is stored", so the UI never has to hold
    // credentials it cannot read back.
    const secret = dto.secret ? asSecret(existing.kind, dto.secret) : (existing.secret as StorageTargetSecret);

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.storageTargetRepository.getByName(dto.name);
      if (duplicate) {
        throw new BadRequestException('A storage target with that name already exists');
      }
    }

    const target = await this.storageTargetRepository.update(id, {
      name: dto.name ?? existing.name,
      config,
      secret,
      isEnabled: dto.isEnabled ?? existing.isEnabled,
    });

    this.remoteStorageRepository.evict(id);

    return mapStorageTarget(target);
  }

  async remove(id: string): Promise<void> {
    await this.findOrFailTarget(id);

    // The object ledger cascades away with the target, which for an offloaded
    // asset is the only record of where its bytes went. Deleting the target would
    // strand those originals, so the offload has to be undone first.
    const offloaded = await this.storageTargetRepository.countOffloadedAssets(id);
    if (offloaded > 0) {
      throw new BadRequestException(
        `Cannot delete this storage target: ${offloaded} asset(s) have been offloaded to it and hold no local copy. Restore them first.`,
      );
    }

    await this.storageTargetRepository.delete(id);
    this.remoteStorageRepository.evict(id);
  }

  async test(id: string): Promise<StorageTargetTestResponseDto> {
    const target = await this.findOrFailTarget(id);

    try {
      await this.remoteStorageRepository.test(target);
      return { ok: true };
    } catch (error: any) {
      // A failed connection test is an expected outcome of the admin fixing
      // credentials, not a server fault, so report it in the body rather than
      // as a 500.
      this.logger.warn(`Storage target "${target.name}" failed its connection test: ${error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async getTransfers(id: string): Promise<StorageTransferResponseDto[]> {
    await this.findOrFailTarget(id);
    const transfers = await this.storageTargetRepository.getTransfers(id);
    return transfers.map((transfer) => mapStorageTransfer(transfer));
  }

  startExport(id: string, dto: StorageTransferCreateDto): Promise<StorageTransferResponseDto> {
    return this.startTransfer(id, dto, StorageTransferDirection.Export);
  }

  startImport(id: string, dto: StorageTransferCreateDto): Promise<StorageTransferResponseDto> {
    return this.startTransfer(id, dto, StorageTransferDirection.Import);
  }

  startOffload(id: string, dto: StorageTransferCreateDto): Promise<StorageTransferResponseDto> {
    return this.startTransfer(id, dto, StorageTransferDirection.Offload);
  }

  startRestore(id: string, dto: StorageTransferCreateDto): Promise<StorageTransferResponseDto> {
    return this.startTransfer(id, dto, StorageTransferDirection.Restore);
  }

  /**
   * Offload assets on behalf of their owner. Unlike the admin entry points this
   * is scoped to assets the caller owns, checked before the transfer is created.
   */
  async offloadAssets(auth: AuthDto, dto: AssetOffloadDto): Promise<StorageTransferResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetOffload, ids: dto.assetIds });

    return this.startTransfer(
      dto.targetId,
      {
        ownerId: auth.user.id,
        scope: { type: StorageTransferScopeType.Assets, assetIds: dto.assetIds },
      },
      dto.restore ? StorageTransferDirection.Restore : StorageTransferDirection.Offload,
    );
  }

  private async startTransfer(
    id: string,
    dto: StorageTransferCreateDto,
    direction: StorageTransferDirection,
  ): Promise<StorageTransferResponseDto> {
    const target = await this.findOrFailTarget(id);

    if (!target.isEnabled) {
      throw new BadRequestException('Storage target is disabled');
    }

    const owner = await this.userRepository.get(dto.ownerId, {});
    if (!owner) {
      throw new BadRequestException('User not found');
    }

    const transfer = await this.storageTargetRepository.createTransfer({
      targetId: id,
      ownerId: dto.ownerId,
      direction,
      status: StorageTransferStatus.Pending,
      scope: asScope(dto.scope),
    });

    await this.jobRepository.queue({ name: QUEUE_JOB_BY_DIRECTION[direction], data: { transferId: transfer.id } });

    return mapStorageTransfer(transfer);
  }

  private async findOrFailTarget(id: string) {
    const target = await this.storageTargetRepository.get(id);
    if (!target) {
      throw new NotFoundException('Storage target not found');
    }
    return target;
  }
}

/**
 * Credentials arrive as a flat bag because the API does not make the client repeat
 * the target kind. This narrows that bag to the kind the config declares, and
 * rejects a bag that is missing what the kind needs.
 */
function asSecret(kind: StorageTargetKind, secret: StorageTargetSecretDto): StorageTargetSecret {
  switch (kind) {
    case StorageTargetKind.S3: {
      if (!secret.accessKeyId || !secret.secretAccessKey) {
        throw new BadRequestException('An S3 target requires accessKeyId and secretAccessKey');
      }
      return { kind, accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey };
    }
    case StorageTargetKind.WebDav: {
      if (!secret.username || !secret.password) {
        throw new BadRequestException('A WebDAV target requires username and password');
      }
      return { kind, username: secret.username, password: secret.password };
    }
    case StorageTargetKind.Local: {
      return { kind };
    }
    default: {
      throw new BadRequestException(`Unsupported storage target kind: ${kind}`);
    }
  }
}

/**
 * Connection details arrive as a flat bag so that clients get a usable `kind`
 * enum. This narrows that bag to the declared kind and rejects one that is
 * missing what the kind needs.
 */
function asConfig(kind: StorageTargetKind, config: StorageTargetConfigDto): StorageTargetConfig {
  const { prefix } = config;

  switch (kind) {
    case StorageTargetKind.S3: {
      if (!config.bucket) {
        throw new BadRequestException('An S3 target requires a bucket');
      }
      assertEndpointHasNoBucket(config.endpoint, config.bucket);
      return {
        kind,
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        prefix,
      };
    }
    case StorageTargetKind.WebDav: {
      if (!config.baseUrl) {
        throw new BadRequestException('A WebDAV target requires a base URL');
      }
      return { kind, baseUrl: config.baseUrl, prefix };
    }
    case StorageTargetKind.Local: {
      if (!config.basePath) {
        throw new BadRequestException('A filesystem target requires a path');
      }
      return { kind, basePath: config.basePath, prefix };
    }
    default: {
      throw new BadRequestException(`Unsupported storage target kind: ${kind}`);
    }
  }
}

/**
 * Reject an endpoint that already contains the bucket in its path.
 *
 * Copying the browsable bucket URL out of a provider's console is the obvious
 * thing to do, and with path-style addressing it silently doubles up: the SDK
 * appends the bucket to whatever path the endpoint carries, so
 * `https://eu2.contabostorage.com/immich` plus bucket `immich` requests
 * `/immich/immich`. Ceph reads that second segment as an object key and answers
 * `NoSuchKey`, which looks like missing data rather than a wrong endpoint.
 *
 * Only the bucket-in-path case is refused. A path that is not the bucket is
 * left alone, since S3 behind a reverse proxy is legitimately mounted that way.
 */
function assertEndpointHasNoBucket(endpoint: string | undefined, bucket: string) {
  if (!endpoint) {
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BadRequestException(`The endpoint must be a full URL, for example https://s3.example.com`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.includes(bucket)) {
    throw new BadRequestException(
      `The endpoint must not include the bucket: use ${url.protocol}//${url.host} and leave "${bucket}" in the bucket field. ` +
        `Including it makes every request address "${bucket}" twice, which the service reports as a missing object.`,
    );
  }
}

/** Narrows the flat scope payload to the variant its `type` declares. */
function asScope(scope: StorageTransferScopeDto): StorageTransferScope {
  switch (scope.type) {
    case StorageTransferScopeType.Albums: {
      if (!scope.albumIds?.length) {
        throw new BadRequestException('A transfer scoped to albums requires at least one album');
      }
      return { type: scope.type, albumIds: scope.albumIds };
    }
    case StorageTransferScopeType.Assets: {
      if (!scope.assetIds?.length) {
        throw new BadRequestException('A transfer scoped to assets requires at least one asset');
      }
      return { type: scope.type, assetIds: scope.assetIds };
    }
    default: {
      return { type: StorageTransferScopeType.All };
    }
  }
}
