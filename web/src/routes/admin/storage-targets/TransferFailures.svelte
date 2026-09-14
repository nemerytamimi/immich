<script lang="ts">
  import {
    getStorageTransferItems,
    StorageTransferStatus,
    type StorageTransferItemDto,
    type StorageTransferItemsResponseDto,
    type StorageTransferResponseDto,
  } from '@immich/sdk';
  import {
    Button,
    IconButton,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { mdiRestart } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import { handleRetryTransferFailures } from '$lib/services/storage-target.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';

  type Props = {
    transfer: StorageTransferResponseDto;
  };

  const { transfer }: Props = $props();

  /** Enough to see what is going wrong; past this the rest are usually the same failure again. */
  const ITEM_LIMIT = 100;

  let failures = $state<StorageTransferItemsResponseDto>();

  // A paused transfer retries its failures when it resumes, and a cancelled one
  // cannot run again, so the server refuses both; the buttons follow suit.
  const canRetry = $derived(
    transfer.status === StorageTransferStatus.Running ||
      transfer.status === StorageTransferStatus.Completed ||
      transfer.status === StorageTransferStatus.Failed,
  );

  const load = async (id: string) => {
    try {
      failures = await getStorageTransferItems({ id, size: ITEM_LIMIT });
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_storage_transfer_failures'));
    }
  };

  // The failed count is what a new failure or a retry moves, so the list follows it
  // rather than polling on its own.
  $effect(() => {
    void transfer.failedCount;
    void load(transfer.id);
  });

  const retry = async (item?: StorageTransferItemDto) => {
    if (await handleRetryTransferFailures(transfer, item)) {
      await load(transfer.id);
    }
  };

  const describeItem = (item: StorageTransferItemDto) => item.fileName ?? item.remoteKey ?? item.assetId ?? item.id;

  const formatDate = (value: string) => DateTime.fromISO(value).setLocale($locale).toRelative();
</script>

<div class="flex flex-col gap-2 rounded-lg border border-subtle p-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Text size="small" class="font-semibold">{$t('admin.storage_target_transfer_failures')}</Text>

    {#if canRetry && failures && failures.total > 0}
      <Button size="small" shape="round" leadingIcon={mdiRestart} onclick={() => void retry()}>
        {$t('admin.storage_target_transfer_retry_all')}
      </Button>
    {/if}
  </div>

  {#if failures}
    {#if failures.items.length === 0}
      <Text size="small" color="secondary">{$t('admin.storage_target_transfer_failures_empty')}</Text>
    {:else}
      <Table striped spacing="tiny">
        <TableHeader>
          <TableHeading class="w-2/5 text-left">{$t('filename')}</TableHeading>
          <TableHeading class="w-2/5 text-left">{$t('admin.storage_target_transfer_reason')}</TableHeading>
          <TableHeading class="w-1/5 text-left">{$t('admin.storage_target_transfer_last_failed')}</TableHeading>
          {#if canRetry}
            <TableHeading class="w-16 text-right"></TableHeading>
          {/if}
        </TableHeader>

        <TableBody>
          {#each failures.items as item (item.id)}
            <TableRow>
              <TableCell class="px-4 text-left">
                <div class="flex flex-col gap-0.5">
                  <Text size="small" class="break-all">{describeItem(item)}</Text>
                  {#if item.remoteKey && item.remoteKey !== item.fileName}
                    <Text size="tiny" color="secondary" class="break-all font-mono">{item.remoteKey}</Text>
                  {/if}
                  <Text size="tiny" color="secondary">
                    {#if item.size !== null}
                      {getByteUnitString(item.size, $locale)} ·
                    {/if}
                    {$t('admin.storage_target_transfer_attempts', { values: { count: item.attempts } })}
                  </Text>
                </div>
              </TableCell>

              <TableCell class="px-4 text-left">
                <Text size="tiny" color="danger" class="wrap-break-word">{item.error}</Text>
              </TableCell>

              <TableCell class="px-4 text-left">
                <Text size="tiny" color="secondary">{formatDate(item.updatedAt)}</Text>
              </TableCell>

              {#if canRetry}
                <TableCell class="px-4 text-right">
                  <IconButton
                    icon={mdiRestart}
                    aria-label={$t('admin.storage_target_transfer_retry')}
                    title={$t('admin.storage_target_transfer_retry')}
                    size="small"
                    variant="ghost"
                    color="primary"
                    onclick={() => void retry(item)}
                  />
                </TableCell>
              {/if}
            </TableRow>
          {/each}
        </TableBody>
      </Table>

      {#if failures.total > failures.items.length}
        <Text size="tiny" color="secondary">
          {$t('admin.storage_target_transfer_failures_truncated', {
            values: { count: failures.items.length, total: failures.total },
          })}
        </Text>
      {/if}
    {/if}
  {/if}
</div>
