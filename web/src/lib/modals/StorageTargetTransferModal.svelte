<script lang="ts">
  import {
    searchUsersAdmin,
    StorageTransferScopeType,
    type StorageTargetResponseDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Field, FormModal, Select, Text } from '@immich/ui';
  import { mdiCloudUploadOutline, mdiDownloadOutline, mdiRestore, mdiUploadOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { handleStartTransfer, type TransferDirection } from '$lib/services/storage-target.service';

  type Props = {
    target: StorageTargetResponseDto;
    direction: TransferDirection;
    onClose: () => void;
  };

  const { target, direction, onClose }: Props = $props();

  let users = $state<UserAdminResponseDto[]>([]);
  let ownerId = $state('');

  onMount(async () => {
    users = await searchUsersAdmin({ withDeleted: false });
    ownerId = users[0]?.id ?? '';
  });

  const userOptions = $derived(users.map((user) => ({ value: user.id, label: `${user.name} (${user.email})` })));

  const icon = $derived(
    {
      export: mdiUploadOutline,
      import: mdiDownloadOutline,
      offload: mdiCloudUploadOutline,
      restore: mdiRestore,
    }[direction],
  );

  const title = $derived.by(() => {
    switch (direction) {
      case 'export': {
        return $t('admin.storage_target_export');
      }
      case 'import': {
        return $t('admin.storage_target_import');
      }
      case 'offload': {
        return $t('admin.storage_target_offload');
      }
      case 'restore': {
        return $t('admin.storage_target_restore');
      }
    }
  });

  const description = $derived.by(() => {
    const values = { name: target.name };
    switch (direction) {
      case 'export': {
        return $t('admin.storage_target_export_description', { values });
      }
      case 'import': {
        return $t('admin.storage_target_import_description', { values });
      }
      case 'offload': {
        return $t('admin.storage_target_offload_description', { values });
      }
      case 'restore': {
        return $t('admin.storage_target_restore_description', { values });
      }
    }
  });

  const onSubmit = async () => {
    if (!ownerId) {
      return;
    }

    const success = await handleStartTransfer(target, direction, {
      ownerId,
      scope: { type: StorageTransferScopeType.All },
    });
    if (success) {
      onClose();
    }
  };
</script>

<FormModal {title} {icon} {onClose} {onSubmit} size="small" submitText={$t('start')}>
  <div class="flex flex-col gap-4">
    <Text size="small">{description}</Text>

    <Field label={$t('user')} required>
      <Select bind:value={ownerId} options={userOptions} />
    </Field>
  </div>
</FormModal>
