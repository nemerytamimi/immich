import { Selectable } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  StorageTargetKind,
  StorageTargetKindSchema,
  StorageTransferDirectionSchema,
  StorageTransferScopeType,
  StorageTransferScopeTypeSchema,
  StorageTransferStatusSchema,
} from 'src/enum.js';
import {
  StorageTargetTable,
  StorageTargetTransferItemTable,
  StorageTargetTransferTable,
} from 'src/schema/tables/storage-target.table.js';
import { StorageTargetConfig, StorageTargetSecret } from 'src/types.js';
import { asDateTimeString } from 'src/utils/date.js';

// Connection details are a flat bag rather than a discriminated union: the union
// generates one anonymous single-value enum per branch in every client SDK, which
// makes the kind unusable from client code. The kind lives once, at the top level,
// and the server narrows the bag against it.
const StorageTargetConfigSchema = z
  .object({
    endpoint: z
      .string()
      .default('')
      .describe('S3 endpoint for S3-compatible services (MinIO, R2, Wasabi). Leave blank for AWS.'),
    bucket: z.string().default('').describe('S3 bucket name'),
    region: z.string().default('us-east-1').describe('S3 region'),
    forcePathStyle: z
      .boolean()
      .default(true)
      .describe('Use S3 path-style addressing, required by MinIO and most self-hosted implementations'),
    baseUrl: z
      .string()
      .default('')
      .describe('WebDAV base URL, e.g. https://nextcloud.example.com/remote.php/dav/files/alice'),
    basePath: z.string().default('').describe('Absolute path to a local or network-mounted directory'),
    prefix: z.string().default('').describe('Key prefix applied to every object read from or written to this target'),
  })
  .describe('Connection details. Which fields apply depends on the target kind.')
  .meta({ id: 'StorageTargetConfigDto' });

const StorageTargetSecretSchema = z
  .object({
    accessKeyId: z.string().optional().describe('S3 access key ID'),
    secretAccessKey: z.string().optional().describe('S3 secret access key'),
    username: z.string().optional().describe('WebDAV username'),
    password: z.string().optional().describe('WebDAV password or app password'),
  })
  .describe('Credentials for the target. Write-only: never returned by the API.')
  .meta({ id: 'StorageTargetSecretDto' });

const StorageTargetCreateSchema = z
  .object({
    name: z.string().min(1).describe('Human-readable name, unique across targets'),
    kind: StorageTargetKindSchema,
    config: StorageTargetConfigSchema,
    secret: StorageTargetSecretSchema,
    isEnabled: z.boolean().default(true).describe('Whether this target can be used for transfers'),
  })
  .meta({ id: 'StorageTargetCreateDto' });

const StorageTargetUpdateSchema = z
  .object({
    name: z.string().min(1).optional().describe('Human-readable name, unique across targets'),
    // The kind is fixed once a target exists: changing it would invalidate both
    // the stored credentials and every object already recorded against it.
    config: StorageTargetConfigSchema.optional(),
    // Omitting `secret` keeps the stored credentials, so the UI never has to
    // round-trip them and they never need to leave the server.
    secret: StorageTargetSecretSchema.optional(),
    isEnabled: z.boolean().optional().describe('Whether this target can be used for transfers'),
  })
  .meta({ id: 'StorageTargetUpdateDto' });

const StorageTargetResponseSchema = z
  .object({
    id: z.uuidv4().describe('Storage target ID'),
    name: z.string().describe('Human-readable name'),
    kind: StorageTargetKindSchema,
    config: StorageTargetConfigSchema,
    hasCredentials: z.boolean().describe('Whether credentials are stored for this target'),
    isEnabled: z.boolean().describe('Whether this target can be used for transfers'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'StorageTargetResponseDto' });

const StorageTargetTestResponseSchema = z
  .object({
    ok: z.boolean().describe('Whether the target could be reached and written to'),
    error: z.string().optional().describe('Failure reason when `ok` is false'),
  })
  .meta({ id: 'StorageTargetTestResponseDto' });

// Flat for the same reason as the config above: a discriminated union here turns
// into three anonymous single-value enums in the generated clients.
const StorageTransferScopeSchema = z
  .object({
    type: StorageTransferScopeTypeSchema,
    albumIds: z.array(z.uuidv4()).optional().describe('Albums to transfer, when type is "albums"'),
    assetIds: z.array(z.uuidv4()).optional().describe('Assets to transfer, when type is "assets"'),
  })
  .describe('Which assets the transfer covers')
  .meta({ id: 'StorageTransferScopeDto' });

const StorageTransferCreateSchema = z
  .object({
    ownerId: z.uuidv4().describe('User whose assets are exported, or who will own the imported assets'),
    scope: StorageTransferScopeSchema.default({ type: StorageTransferScopeType.All }),
    prefix: z
      .string()
      .optional()
      .describe(
        "Import only. Where to scan, when the default is not wanted. Omit to scan just this user's own key " +
          "prefixes, which is what stops an import pulling in another user's files. Pass an empty string to scan " +
          'the whole target, for a bucket that was not written by Immich.',
      ),
  })
  .meta({ id: 'StorageTransferCreateDto' });

const StorageTransferResponseSchema = z
  .object({
    id: z.uuidv4().describe('Transfer ID'),
    targetId: z.uuidv4().describe('Storage target ID'),
    ownerId: z.uuidv4().describe('Owning user ID'),
    direction: StorageTransferDirectionSchema,
    status: StorageTransferStatusSchema,
    totalCount: z.int().describe('Number of items queued'),
    completedCount: z.int().describe('Number of items completed'),
    failedCount: z.int().describe('Number of items that failed'),
    skippedCount: z
      .int()
      .describe(
        'Number of items left out because they are not ready to transfer yet, such as assets with no thumbnail',
      ),
    startedAt: z.string().meta({ format: 'date-time' }).nullable().describe('Start date'),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable().describe('Completion date'),
    error: z.string().nullable().describe('Failure reason, if the transfer failed as a whole'),
    prefix: z.string().nullable().describe("Where an import scanned, or null for the owner's own prefixes"),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
  })
  .meta({ id: 'StorageTransferResponseDto' });

export class StorageTargetConfigDto extends createZodDto(StorageTargetConfigSchema) {}
export class StorageTargetSecretDto extends createZodDto(StorageTargetSecretSchema) {}
export class StorageTransferScopeDto extends createZodDto(StorageTransferScopeSchema) {}
export class StorageTargetCreateDto extends createZodDto(StorageTargetCreateSchema) {}
export class StorageTargetUpdateDto extends createZodDto(StorageTargetUpdateSchema) {}
export class StorageTargetResponseDto extends createZodDto(StorageTargetResponseSchema) {}
export class StorageTargetTestResponseDto extends createZodDto(StorageTargetTestResponseSchema) {}
export class StorageTransferCreateDto extends createZodDto(StorageTransferCreateSchema) {}
export class StorageTransferResponseDto extends createZodDto(StorageTransferResponseSchema) {}

/**
 * Widen the narrowed, kind-specific config back into the flat shape the API
 * exposes, so a client sees the same field set regardless of the target kind.
 */
function asConfigDto(config: StorageTargetConfig): StorageTargetConfigDto {
  return {
    endpoint: 'endpoint' in config ? config.endpoint : '',
    bucket: 'bucket' in config ? config.bucket : '',
    region: 'region' in config ? config.region : '',
    forcePathStyle: 'forcePathStyle' in config ? config.forcePathStyle : true,
    baseUrl: 'baseUrl' in config ? config.baseUrl : '',
    basePath: 'basePath' in config ? config.basePath : '',
    prefix: config.prefix,
  };
}

/** A local target needs no credentials; the others are only usable once they have them. */
function hasCredentials(kind: StorageTargetKind, secret: StorageTargetSecret | null): boolean {
  switch (kind) {
    case StorageTargetKind.Local: {
      return true;
    }
    case StorageTargetKind.S3: {
      return !!(secret && 'accessKeyId' in secret && secret.accessKeyId);
    }
    case StorageTargetKind.WebDav: {
      return !!(secret && 'username' in secret && secret.username);
    }
    default: {
      return false;
    }
  }
}

/**
 * Note the deliberate absence of `secret` -- credentials are write-only and must
 * never reach a client, so the mapper is the single place that guarantees it.
 */
export function mapStorageTarget(entity: Selectable<StorageTargetTable>): StorageTargetResponseDto {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    config: asConfigDto(entity.config),
    hasCredentials: hasCredentials(entity.kind, entity.secret),
    isEnabled: entity.isEnabled,
    createdAt: asDateTimeString(entity.createdAt),
    updatedAt: asDateTimeString(entity.updatedAt),
  };
}

export function mapStorageTransfer(entity: Selectable<StorageTargetTransferTable>): StorageTransferResponseDto {
  return {
    id: entity.id,
    targetId: entity.targetId,
    ownerId: entity.ownerId,
    direction: entity.direction,
    status: entity.status,
    totalCount: entity.totalCount,
    completedCount: entity.completedCount,
    failedCount: entity.failedCount,
    skippedCount: entity.skippedCount,
    startedAt: entity.startedAt ? asDateTimeString(entity.startedAt) : null,
    finishedAt: entity.finishedAt ? asDateTimeString(entity.finishedAt) : null,
    error: entity.error,
    prefix: entity.prefix,
    createdAt: asDateTimeString(entity.createdAt),
  };
}

const StorageTransferItemSearchSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('Page number for pagination'),
    size: z.coerce.number().int().min(1).max(1000).default(100).describe('Number of items per page'),
  })
  .meta({ id: 'StorageTransferItemSearchDto' });

const StorageTransferItemSchema = z
  .object({
    id: z.uuidv4().describe('Failure record ID'),
    assetId: z.string().nullable().describe('Local asset ID, for an export, offload or restore'),
    remoteKey: z.string().nullable().describe('Object key on the target, where one is known'),
    fileName: z.string().nullable().describe('File name, where one is known'),
    size: z.int().nullable().describe('Size in bytes, where known'),
    attempts: z.int().describe('How many times this item has failed'),
    error: z.string().describe('Why the last attempt failed'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the item first failed'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the item last failed'),
  })
  .meta({ id: 'StorageTransferItemDto' });

const StorageTransferItemsResponseSchema = z
  .object({
    items: z.array(StorageTransferItemSchema).describe('Failed items on this page, most recent first'),
    total: z.int().describe('How many items failed, across every page'),
  })
  .meta({ id: 'StorageTransferItemsResponseDto' });

const StorageTransferRetrySchema = z
  .object({
    itemIds: z.array(z.uuidv4()).optional().describe('Failed items to retry. Omit to retry every failed item.'),
  })
  .meta({ id: 'StorageTransferRetryDto' });

const StorageTransferCountResponseSchema = z
  .object({
    count: z.int().describe('How many were affected'),
  })
  .meta({ id: 'StorageTransferCountResponseDto' });

export class StorageTransferItemSearchDto extends createZodDto(StorageTransferItemSearchSchema) {}
export class StorageTransferItemDto extends createZodDto(StorageTransferItemSchema) {}
export class StorageTransferItemsResponseDto extends createZodDto(StorageTransferItemsResponseSchema) {}
export class StorageTransferRetryDto extends createZodDto(StorageTransferRetrySchema) {}
export class StorageTransferCountResponseDto extends createZodDto(StorageTransferCountResponseSchema) {}

export function mapStorageTransferItem(entity: Selectable<StorageTargetTransferItemTable>): StorageTransferItemDto {
  return {
    id: entity.id,
    assetId: entity.assetId,
    remoteKey: entity.remoteKey,
    fileName: entity.fileName,
    // bigint comes back from the driver as a string.
    size: entity.size === null ? null : Number(entity.size),
    attempts: entity.attempts,
    error: entity.error,
    createdAt: asDateTimeString(entity.createdAt),
    updatedAt: asDateTimeString(entity.updatedAt),
  };
}
