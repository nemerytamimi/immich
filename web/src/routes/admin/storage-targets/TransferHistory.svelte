<script lang="ts">
  import { StorageTransferDirection, StorageTransferStatus, type StorageTransferResponseDto } from '@immich/sdk';
  import { Badge, Card, CardBody, CardHeader, CardTitle, IconButton, Text } from '@immich/ui';
  import { mdiCloseCircleOutline, mdiPause, mdiPlay } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import {
    handleCancelTransfer,
    handlePauseTransfer,
    handleResumeTransfer,
  } from '$lib/services/storage-target.service';
  import { locale } from '$lib/stores/preferences.store';

  type Props = {
    name: string;
    transfers: StorageTransferResponseDto[];
  };

  const { name, transfers }: Props = $props();

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

  const formatDate = (value: string | null) =>
    value ? DateTime.fromISO(value).setLocale($locale).toLocaleString(DateTime.DATETIME_MED) : '—';
</script>

<Card>
  <CardHeader>
    <CardTitle>{$t('admin.storage_target_transfers', { values: { name } })}</CardTitle>
  </CardHeader>
  <CardBody>
    <div class="flex flex-col gap-2">
      {#each transfers as transfer (transfer.id)}
        <div class="flex items-center justify-between gap-4 border-b border-subtle py-2 last:border-b-0">
          <div class="flex items-center gap-2">
            <Badge size="small" color="secondary">{directionLabel(transfer.direction)}</Badge>
            <Badge size="small" color={statusColor(transfer.status)}>{transfer.status}</Badge>
          </div>

          <Text size="small" color="secondary">
            {$t('admin.storage_target_transfer_progress', {
              values: {
                completed: transfer.completedCount,
                total: transfer.totalCount,
                failed: transfer.failedCount,
              },
            })}
          </Text>

          <Text size="small" color="secondary">{formatDate(transfer.startedAt)}</Text>

          <div class="flex items-center gap-1">
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
          </div>
        </div>

        {#if transfer.error}
          <Text size="tiny" color="danger">{transfer.error}</Text>
        {/if}
      {/each}
    </div>
  </CardBody>
</Card>
