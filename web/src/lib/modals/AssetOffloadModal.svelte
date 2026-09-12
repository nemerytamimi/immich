<script lang="ts">
  import { getAvailableStorageTargets, type StorageTargetResponseDto } from '@immich/sdk';
  import { Field, FormModal, Select, Text } from '@immich/ui';
  import { mdiCloudUploadOutline, mdiRestore } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { handleOffloadAssets } from '$lib/services/asset.service';

  type Props = {
    assetIds: string[];
    restore?: boolean;
    onClose: (confirmed?: boolean) => void;
  };

  const { assetIds, restore = false, onClose }: Props = $props();

  let targets = $state<StorageTargetResponseDto[]>([]);
  let targetId = $state('');
  let loaded = $state(false);

  onMount(async () => {
    targets = await getAvailableStorageTargets();
    targetId = targets[0]?.id ?? '';
    loaded = true;
  });

  const targetOptions = $derived(targets.map((target) => ({ value: target.id, label: target.name })));

  const onSubmit = async () => {
    if (!targetId) {
      return;
    }

    const success = await handleOffloadAssets({ assetIds, targetId, restore });
    if (success) {
      onClose(true);
    }
  };
</script>

<FormModal
  title={restore ? $t('restore_from_storage_target') : $t('offload_to_storage_target')}
  icon={restore ? mdiRestore : mdiCloudUploadOutline}
  {onClose}
  {onSubmit}
  size="small"
  submitText={restore ? $t('restore') : $t('offload')}
  disabled={!targetId}
>
  <div class="flex flex-col gap-4">
    <Text size="small">
      {restore
        ? $t('restore_assets_description', { values: { count: assetIds.length } })
        : $t('offload_assets_description', { values: { count: assetIds.length } })}
    </Text>

    {#if loaded && targets.length === 0}
      <Text size="small" color="danger">{$t('no_storage_targets_available')}</Text>
    {:else}
      <Field label={$t('admin.storage_target_location')} required>
        <Select bind:value={targetId} options={targetOptions} />
      </Field>
    {/if}
  </div>
</FormModal>
