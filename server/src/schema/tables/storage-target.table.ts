import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { StorageTargetConfig, StorageTargetSecret, StorageTransferScope } from 'src/types.js';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { StorageTargetKind, StorageTransferDirection, StorageTransferStatus } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('storage_target')
@UpdatedAtTrigger('storage_target_updatedAt')
@Unique({ columns: ['name'] })
export class StorageTargetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  name!: string;

  @Column()
  kind!: StorageTargetKind;

  /** Non-secret connection details, shape depends on `kind` */
  @Column({ type: 'jsonb' })
  config!: StorageTargetConfig;

  /** Credentials. Never returned by the API. */
  @Column({ type: 'jsonb' })
  secret!: StorageTargetSecret;

  @Column({ type: 'boolean', default: true })
  isEnabled!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}

@Table('storage_target_transfer')
@UpdatedAtTrigger('storage_target_transfer_updatedAt')
export class StorageTargetTransferTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StorageTargetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  targetId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column()
  direction!: StorageTransferDirection;

  @Column()
  status!: StorageTransferStatus;

  @Column({ type: 'jsonb' })
  scope!: StorageTransferScope;

  /**
   * Where an import scans, when the default is not what is wanted.
   *
   * Null -- the default -- scans only the owner's own key prefixes, which is what
   * stops an import handing one user another user's originals. An empty string
   * deliberately scans the whole target, for a bucket that was not written by
   * Immich and so has no per-user layout to respect. Unused by the other
   * directions, which work from local assets rather than remote keys.
   */
  @Column({ type: 'character varying', nullable: true, default: null })
  prefix!: string | null;

  @Column({ type: 'integer', default: 0 })
  totalCount!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  completedCount!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  failedCount!: Generated<number>;

  /**
   * Items the walk left out because they are not ready to transfer yet -- an
   * offload candidate with no thumbnail or preview, say. They are not in the
   * total, so without this a run that skipped everything reads as nothing to do.
   */
  @Column({ type: 'integer', default: 0 })
  skippedCount!: Generated<number>;

  /**
   * The run the transfer is on. Resuming starts a new one, and every job carries
   * the run that queued it, so jobs still on the queue from before a pause see
   * the mismatch and drain without acting or counting. Null only for transfers
   * created before runs existed.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  runId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true, default: null })
  startedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true, default: null })
  finishedAt!: Timestamp | null;

  @Column({ type: 'character varying', nullable: true, default: null })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}

/**
 * Items that failed within a transfer, and what went wrong with each, so a run
 * with failures can be looked at file by file and retried without walking the
 * whole library again. A row goes once its item succeeds, and every row goes
 * with the transfer when it is removed from the history.
 */
@Table('storage_target_transfer_item')
@Unique({ columns: ['transferId', 'itemKey'] })
export class StorageTargetTransferItemTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StorageTargetTransferTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  transferId!: string;

  /** What identifies the item within its transfer: the asset id, or the remote key for an import. */
  @Column()
  itemKey!: string;

  /** Deliberately not a foreign key: a failure is still worth reading once its asset is gone. */
  @Column({ type: 'uuid', nullable: true, default: null })
  assetId!: string | null;

  @Column({ type: 'character varying', nullable: true, default: null })
  remoteKey!: string | null;

  @Column({ type: 'character varying', nullable: true, default: null })
  fileName!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  size!: number | null;

  @Column({ type: 'integer', default: 1 })
  attempts!: Generated<number>;

  @Column()
  error!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * Ledger of objects known to exist on a target. Doubles as the idempotency key for
 * both directions: export skips assets already recorded, import skips remote keys
 * already recorded.
 */
@Table('storage_target_object')
@Unique({ columns: ['targetId', 'remoteKey'] })
export class StorageTargetObjectTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => StorageTargetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  targetId!: string;

  @Column()
  remoteKey!: string;

  /** Null when the remote object has no corresponding local asset (yet). */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  @Column({ type: 'bigint' })
  size!: number;

  @Column({ type: 'bytea', nullable: true, default: null })
  checksum!: Buffer | null;

  @CreateDateColumn()
  syncedAt!: Generated<Timestamp>;
}
