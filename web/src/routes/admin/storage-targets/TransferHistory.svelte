<script lang="ts">
  import {
    StorageTransferDirection,
    StorageTransferStatus,
    type StorageTargetResponseDto,
    type StorageTransferResponseDto,
  } from '@immich/sdk';
  import { Badge, Button, Card, CardBody, CardHeader, CardTitle, IconButton, Text } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiBroom,
    mdiCloseCircleOutline,
    mdiPause,
    mdiPlay,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import {
    handleCancelTransfer,
    handleClearTransferHistory,
    handleDeleteTransfer,
    handlePauseTransfer,
    handleResumeTransfer,
  } from '$lib/services/storage-target.service';
  import { locale } from '$lib/stores/preferences.store';
  import TransferFailures from './TransferFailures.svelte';

  type Props = {
    target: StorageTargetResponseDto;
    transfers: StorageTransferResponseDto[];
  };

  const { target, transfers }: Props = $props();

  /** Kept by id, so a poll replacing the list does not fold an open one back up. */
  let expandedIds = $state<string[]>([]);

  const isExpanded = (id: string) => expandedIds.includes(id);

  const statusColor = (status: StorageTransferStatus) => {
    switch (status) {
      case StorageTransferStatus.Completed: {
        return 'success';
      }
      case StorageTransferStatus.Failed: {
        return 'danger';
      }
      case StorageTransferStatus.Running: {
        return 'primary';
      }
      case StorageTransferStatus.Paused: {
        return 'warning';
      }
      default: {
        return 'secondary';
      }
    }
  };

  const directionLabel = (direction: StorageTransferDirection) => {
    switch (direction) {
      case StorageTransferDirection.Export: {
        return $t('admin.storage_target_export');
      }
      case StorageTransferDirection.Import: {
        return $t('admin.storage_target_import');
      }
      case StorageTransferDirection.Offload: {
        return $t('admin.storage_target_offload');
      }
      case StorageTransferDirection.Restore: {
        return $t('admin.storage_target_restore');
      }
    }
  };

  /** Pending and running can be paused; only a paused transfer can be resumed. */
  const canPause = (status: StorageTransferStatus) =>
    status === StorageTransferStatus.Pending || status === StorageTransferStatus.Running;
  const canResume = (status: StorageTransferStatus) => status === StorageTransferStatus.Paused;
  const canCancel = (status: StorageTransferStatus) => canPause(status) || canResume(status);

  /** Only a transfer with nothing left on the queue can leave the history. */
  const isFinished = (status: StorageTransferStatus) =>
    status === StorageTransferStatus.Completed ||
    status === StorageTransferStatus.Failed ||
    status === StorageTransferStatus.Cancelled;

  const hasFinished = $derived(transfers.some(({ status }) => isFinished(status)));

  const toggleFailures = (id: string) => {
    expandedIds = isExpanded(id) ? expandedIds.filter((expandedId) => expandedId !== id) : [...expandedIds, id];
  };

  const formatDate = (value: string | null) =>
    value ? DateTime.fromISO(value).setLocale($locale).toLocaleString(DateTime.DATETIME_MED) : '—';
</script>

<Card>
  <CardHeader>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <CardTitle>{$t('admin.storage_target_transfers', { values: { name: target.name } })}</CardTitle>

      {#if hasFinished}
        <Button
          size="small"
          shape="round"
          variant="ghost"
          color="secondary"
          leadingIcon={mdiBroom}
          onclick={() => handleClearTransferHistory(target)}
        >
          {$t('admin.storage_target_transfers_clear')}
        </Button>
      {/if}
    </div>
  </CardHeader>
  <CardBody>
    <div class="flex flex-col gap-2">
      {#each transfers as transfer (transfer.id)}
        <div class="flex flex-col gap-2 border-b border-subtle py-2 last:border-b-0">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-2">
              <Badge size="small" color="secondary">{directionLabel(transfer.direction)}</Badge>
              <Badge size="small" color={statusColor(transfer.status)}>{transfer.status}</Badge>
            </div>

            <div class="flex flex-col">
              <Text size="small" color="secondary">
                {$t('admin.storage_target_transfer_progress', {
                  values: {
                    completed: transfer.completedCount,
                    total: transfer.totalCount,
                    failed: transfer.failedCount,
                  },
                })}
              </Text>

              <!-- Skipped items are not in the total, so a run that skipped everything would otherwise read as nothing to do. -->
              {#if transfer.skippedCount > 0}
                <Text size="tiny" color="warning">
                  {$t('admin.storage_target_transfer_skipped', { values: { count: transfer.skippedCount } })}
                </Text>
              {/if}
            </div>

            <Text size="small" color="secondary">{formatDate(transfer.startedAt)}</Text>

            <div class="flex items-center gap-1">
              {#if transfer.failedCount > 0}
                <IconButton
                  size="small"
                  variant="ghost"
                  color={isExpanded(transfer.id) ? 'primary' : 'danger'}
                  icon={mdiAlertCircleOutline}
                  aria-label={isExpanded(transfer.id)
                    ? $t('admin.storage_target_transfer_failures_hide')
                    : $t('admin.storage_target_transfer_failures_show')}
                  title={isExpanded(transfer.id)
                    ? $t('admin.storage_target_transfer_failures_hide')
                    : $t('admin.storage_target_transfer_failures_show')}
                  onclick={() => toggleFailures(transfer.id)}
                />
              {/if}

              {#if canPause(transfer.status)}
                <IconButton
                  size="small"
                  variant="ghost"
                  color="secondary"
                  icon={mdiPause}
                  aria-label={$t('admin.storage_target_transfer_pause')}
                  title={$t('admin.storage_target_transfer_pause')}
                  onclick={() => handlePauseTransfer(transfer)}
                />
              {/if}

              {#if canResume(transfer.status)}
                <IconButton
                  size="small"
                  variant="ghost"
                  color="primary"
                  icon={mdiPlay}
                  aria-label={$t('admin.storage_target_transfer_resume')}
                  title={$t('admin.storage_target_transfer_resume')}
                  onclick={() => handleResumeTransfer(transfer)}
                />
              {/if}

              {#if canCancel(transfer.status)}
                <IconButton
                  size="small"
                  variant="ghost"
                  color="danger"
                  icon={mdiCloseCircleOutline}
                  aria-label={$t('admin.storage_target_transfer_cancel')}
                  title={$t('admin.storage_target_transfer_cancel')}
                  onclick={() => handleCancelTransfer(transfer)}
                />
              {/if}

              {#if isFinished(transfer.status)}
                <IconButton
                  size="small"
                  variant="ghost"
                  color="secondary"
                  icon={mdiTrashCanOutline}
                  aria-label={$t('admin.storage_target_transfer_delete')}
                  title={$t('admin.storage_target_transfer_delete')}
                  onclick={() => handleDeleteTransfer(transfer)}
                />
              {/if}
            </div>
          </div>

          {#if transfer.error}
            <Text size="tiny" color="danger">{transfer.error}</Text>
          {/if}

          {#if isExpanded(transfer.id) && transfer.failedCount > 0}
            <TransferFailures {transfer} />
          {/if}
        </div>
      {/each}
    </div>
  </CardBody>
</Card>
