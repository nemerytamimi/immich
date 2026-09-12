<script lang="ts">
  import { invalidate } from '$app/navigation';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import {
    getStorageTargetActions,
    getStorageTargetsActions,
    storageTargetKindLabel,
  } from '$lib/services/storage-target.service';
  import {
    getStorageTargetTransfers,
    StorageTargetKind,
    StorageTransferStatus,
    type StorageTargetResponseDto,
    type StorageTransferResponseDto,
  } from '@immich/sdk';
  import {
    Badge,
    CommandPaletteDefaultProvider,
    Container,
    ContextMenuButton,
    MenuItemType,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import type { PageData } from './$types';
  import TransferHistory from './TransferHistory.svelte';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  /** Often enough to watch a transfer move, rarely enough to be cheap. */
  const REFRESH_INTERVAL_MS = 5000;

  /** Ticks between refreshes when nothing is moving, so 30s at the interval above. */
  const IDLE_REFRESH_TICKS = 6;

  const targets = $derived(data.targets);

  let polled = $state<Record<string, StorageTransferResponseDto[]>>();

  // A poll speaks only for the targets it was made against, so adding or removing
  // one falls back to what the page loaded until the next tick lands.
  const transfers = $derived(polled && targets.every(({ id }) => id in polled!) ? polled : data.transfers);

  /** Only pending and running transfers have counters that move. */
  const isMoving = $derived(
    Object.values(transfers).some((list) =>
      list.some(({ status }) => status === StorageTransferStatus.Running || status === StorageTransferStatus.Pending),
    ),
  );

  const refresh = async () => {
    try {
      const entries = await Promise.all(
        targets.map(async ({ id }) => [id, await getStorageTargetTransfers({ id })] as const),
      );
      polled = Object.fromEntries(entries);
    } catch {
      // A failed tick leaves the last good numbers on screen; the next one tries again.
    }
  };

  /**
   * Watch closely while something is moving, and idle slowly when nothing is.
   *
   * The slow cadence is not decoration: a transfer started from another session
   * would otherwise never appear here, because with nothing moving there would
   * be nothing to prompt a refresh. Costing one round-trip per target, polling a
   * quiet server every five seconds forever is not worth paying for that.
   */
  onMount(() => {
    let ticks = 0;

    const interval = setInterval(() => {
      ticks++;
      if (isMoving || ticks % IDLE_REFRESH_TICKS === 0) {
        void refresh();
      }
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  });

  const onStorageTargetUpdate = () => {
    polled = undefined;
    return invalidate('app:storage-targets');
  };

  // Pausing, resuming or cancelling changes a transfer's status and counters,
  // which are part of the same page load as the targets themselves. The polled
  // copy is dropped so the reloaded data shows immediately rather than being
  // shadowed until the next tick.
  const onStorageTransferUpdate = () => {
    polled = undefined;
    return invalidate('app:storage-targets');
  };

  const { Create } = $derived(getStorageTargetsActions($t));

  const getActionsForTarget = (target: StorageTargetResponseDto) => {
    const { Test, Export, Import, Offload, Restore, Edit, Delete } = getStorageTargetActions($t, target);
    return [Test, Export, Import, Offload, Restore, Edit, MenuItemType.Divider, Delete];
  };

  /** Where the target actually points, condensed to one line for the table. */
  const describeLocation = ({ kind, config }: StorageTargetResponseDto) => {
    switch (kind) {
      case StorageTargetKind.S3: {
        return `${config.endpoint || 's3.amazonaws.com'}/${config.bucket}`;
      }
      case StorageTargetKind.Webdav: {
        return config.baseUrl;
      }
      case StorageTargetKind.Local: {
        return config.basePath;
      }
      default: {
        return '';
      }
    }
  };

  const classes = {
    column1: 'w-3/12',
    column2: 'w-2/12',
    column3: 'w-4/12',
    column4: 'w-2/12',
    column5: 'w-1/12 flex justify-end',
  };
</script>

<OnEvents {onStorageTargetUpdate} {onStorageTransferUpdate} />

<CommandPaletteDefaultProvider name={$t('admin.storage_targets')} actions={[Create]} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[Create]}>
  <Container size="large" center class="my-4">
    <div class="flex flex-col gap-6" in:fade={{ duration: 500 }}>
      <Text size="small" color="secondary">{$t('admin.storage_targets_description')}</Text>

      {#if targets.length > 0}
        <Table striped size="small" spacing="small">
          <TableHeader>
            <TableHeading class={classes.column1}>{$t('name')}</TableHeading>
            <TableHeading class={classes.column2}>{$t('admin.storage_target_kind')}</TableHeading>
            <TableHeading class={classes.column3}>{$t('admin.storage_target_location')}</TableHeading>
            <TableHeading class={classes.column4}>{$t('status')}</TableHeading>
            <TableHeading class={classes.column5}></TableHeading>
          </TableHeader>
          <TableBody>
            {#each targets as target (target.id)}
              <TableRow>
                <TableCell class={classes.column1}>{target.name}</TableCell>
                <TableCell class={classes.column2}>{storageTargetKindLabel($t, target.kind)}</TableCell>
                <TableCell class={classes.column3}>
                  <span class="font-mono text-xs">{describeLocation(target)}</span>
                </TableCell>
                <TableCell class={classes.column4}>
                  <div class="flex gap-1">
                    <Badge color={target.isEnabled ? 'success' : 'secondary'} size="small">
                      {target.isEnabled ? $t('enabled') : $t('disabled')}
                    </Badge>
                    {#if !target.hasCredentials}
                      <Badge color="warning" size="small">{$t('admin.storage_target_no_credentials')}</Badge>
                    {/if}
                  </div>
                </TableCell>
                <TableCell class={classes.column5}>
                  <ContextMenuButton items={getActionsForTarget(target)} />
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        {#each targets as target (target.id)}
          {@const targetTransfers = transfers[target.id] ?? []}
          {#if targetTransfers.length > 0}
            <TransferHistory name={target.name} transfers={targetTransfers} />
          {/if}
        {/each}
      {:else}
        <EmptyPlaceholder text={$t('admin.storage_targets_empty')} onClick={() => Create.onAction(Create)} />
      {/if}
    </div>
  </Container>
</AdminPageLayout>
