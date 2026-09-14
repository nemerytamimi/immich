import {
  cancelStorageTransfer,
  clearStorageTargetTransfers,
  createStorageTarget,
  deleteStorageTarget,
  deleteStorageTransfer,
  exportToStorageTarget,
  importFromStorageTarget,
  offloadToStorageTarget,
  pauseStorageTransfer,
  restoreFromStorageTarget,
  resumeStorageTransfer,
  retryStorageTransferItems,
  StorageTargetKind,
  testStorageTarget,
  updateStorageTarget,
  type StorageTargetCreateDto,
  type StorageTargetResponseDto,
  type StorageTargetUpdateDto,
  type StorageTransferCreateDto,
  type StorageTransferItemDto,
  type StorageTransferResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiCloudUploadOutline,
  mdiConnection,
  mdiDownloadOutline,
  mdiPencilOutline,
  mdiPlusBoxOutline,
  mdiRestore,
  mdiTrashCanOutline,
  mdiUploadOutline,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';
import StorageTargetEditModal from '$lib/modals/StorageTargetEditModal.svelte';
import StorageTargetTransferModal from '$lib/modals/StorageTargetTransferModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getStorageTargetsActions = ($t: MessageFormatter) => {
  const Create: ActionItem = {
    title: $t('admin.storage_target_create'),
    icon: mdiPlusBoxOutline,
    onAction: () => modalManager.show(StorageTargetEditModal, {}),
    shortcuts: { shift: true, key: 'n' },
  };

  return { Create };
};

export const getStorageTargetActions = ($t: MessageFormatter, target: StorageTargetResponseDto) => {
  const Test: ActionItem = {
    icon: mdiConnection,
    title: $t('admin.storage_target_test'),
    onAction: () => handleTestStorageTarget(target),
  };

  const Edit: ActionItem = {
    icon: mdiPencilOutline,
    title: $t('edit'),
    onAction: () => modalManager.show(StorageTargetEditModal, { target }),
  };

  const Export: ActionItem = {
    icon: mdiUploadOutline,
    title: $t('admin.storage_target_export'),
    onAction: () => modalManager.show(StorageTargetTransferModal, { target, direction: 'export' }),
  };

  const Import: ActionItem = {
    icon: mdiDownloadOutline,
    title: $t('admin.storage_target_import'),
    onAction: () => modalManager.show(StorageTargetTransferModal, { target, direction: 'import' }),
  };

  const Offload: ActionItem = {
    icon: mdiCloudUploadOutline,
    title: $t('admin.storage_target_offload'),
    onAction: () => modalManager.show(StorageTargetTransferModal, { target, direction: 'offload' }),
  };

  const Restore: ActionItem = {
    icon: mdiRestore,
    title: $t('admin.storage_target_restore'),
    onAction: () => modalManager.show(StorageTargetTransferModal, { target, direction: 'restore' }),
  };

  const Delete: ActionItem = {
    icon: mdiTrashCanOutline,
    title: $t('delete'),
    color: 'danger',
    onAction: () => handleDeleteStorageTarget(target),
  };

  return { Test, Edit, Export, Import, Offload, Restore, Delete };
};

export const handleCreateStorageTarget = async (dto: StorageTargetCreateDto) => {
  const $t = await getFormatter();

  try {
    const target = await createStorageTarget({ storageTargetCreateDto: dto });
    toastManager.info($t('admin.storage_target_created'));
    eventManager.emit('StorageTargetUpdate', target);
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_create_storage_target'));
    return false;
  }
};

export const handleUpdateStorageTarget = async (id: string, dto: StorageTargetUpdateDto) => {
  const $t = await getFormatter();

  try {
    const target = await updateStorageTarget({ id, storageTargetUpdateDto: dto });
    toastManager.info($t('admin.storage_target_updated'));
    eventManager.emit('StorageTargetUpdate', target);
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_storage_target'));
    return false;
  }
};

const handleDeleteStorageTarget = async (target: StorageTargetResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('admin.storage_target_delete'),
    prompt: $t('admin.storage_target_delete_prompt', { values: { name: target.name } }),
    confirmText: $t('delete'),
    confirmColor: 'danger',
  });

  if (!confirmed) {
    return;
  }

  try {
    await deleteStorageTarget({ id: target.id });
    toastManager.info($t('admin.storage_target_deleted'));
    eventManager.emit('StorageTargetUpdate', target);
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_storage_target'));
  }
};

const handleTestStorageTarget = async (target: StorageTargetResponseDto) => {
  const $t = await getFormatter();

  try {
    const result = await testStorageTarget({ id: target.id });
    if (result.ok) {
      toastManager.info($t('admin.storage_target_test_succeeded', { values: { name: target.name } }));
    } else {
      // A failed connection test is expected while credentials are being sorted
      // out, so it is surfaced as a message rather than an error toast.
      toastManager.danger(
        $t('admin.storage_target_test_failed', { values: { name: target.name, error: result.error ?? '' } }),
      );
    }
  } catch (error) {
    handleError(error, $t('errors.unable_to_test_storage_target'));
  }
};

export type TransferDirection = 'export' | 'import' | 'offload' | 'restore';

const TRANSFER_STARTERS = {
  export: exportToStorageTarget,
  import: importFromStorageTarget,
  offload: offloadToStorageTarget,
  restore: restoreFromStorageTarget,
} as const;

export const handleStartTransfer = async (
  target: StorageTargetResponseDto,
  direction: TransferDirection,
  dto: StorageTransferCreateDto,
) => {
  const $t = await getFormatter();

  try {
    await TRANSFER_STARTERS[direction]({ id: target.id, storageTransferCreateDto: dto });

    toastManager.info(transferStartedMessage($t, direction));
    eventManager.emit('StorageTargetUpdate', target);
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_start_storage_transfer'));
    return false;
  }
};

const transferStartedMessage = ($t: MessageFormatter, direction: TransferDirection) => {
  switch (direction) {
    case 'export': {
      return $t('admin.storage_target_export_started');
    }
    case 'import': {
      return $t('admin.storage_target_import_started');
    }
    case 'offload': {
      return $t('admin.storage_target_offload_started');
    }
    case 'restore': {
      return $t('admin.storage_target_restore_started');
    }
  }
};

export const handlePauseTransfer = async (transfer: StorageTransferResponseDto) => {
  const $t = await getFormatter();

  try {
    await pauseStorageTransfer({ id: transfer.id });
    toastManager.info($t('admin.storage_target_transfer_paused'));
    eventManager.emit('StorageTransferUpdate', transfer);
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_storage_transfer'));
  }
};

export const handleResumeTransfer = async (transfer: StorageTransferResponseDto) => {
  const $t = await getFormatter();

  try {
    await resumeStorageTransfer({ id: transfer.id });
    toastManager.info($t('admin.storage_target_transfer_resumed'));
    eventManager.emit('StorageTransferUpdate', transfer);
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_storage_transfer'));
  }
};

export const handleCancelTransfer = async (transfer: StorageTransferResponseDto) => {
  const $t = await getFormatter();

  // Cancelling stops the run but keeps whatever has already moved, which is not
  // obvious from the button alone, so it is spelled out before anything happens.
  const confirmed = await modalManager.showDialog({
    title: $t('admin.storage_target_transfer_cancel'),
    prompt: $t('admin.storage_target_transfer_cancel_prompt'),
    confirmText: $t('admin.storage_target_transfer_cancel'),
    confirmColor: 'danger',
  });

  if (!confirmed) {
    return;
  }

  try {
    await cancelStorageTransfer({ id: transfer.id });
    toastManager.info($t('admin.storage_target_transfer_cancelled'));
    eventManager.emit('StorageTransferUpdate', transfer);
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_storage_transfer'));
  }
};

/**
 * Tries failed files again, one or all of them, without walking the library.
 * Confirmed, because retrying before whatever broke them is fixed only fails
 * them a second time.
 */
export const handleRetryTransferFailures = async (
  transfer: StorageTransferResponseDto,
  item?: StorageTransferItemDto,
) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('admin.storage_target_transfer_retry_title'),
    prompt: item
      ? $t('admin.storage_target_transfer_retry_item_prompt', {
          values: { name: item.fileName ?? item.remoteKey ?? item.assetId ?? item.id },
        })
      : $t('admin.storage_target_transfer_retry_prompt', { values: { count: transfer.failedCount } }),
    confirmText: $t('admin.storage_target_transfer_retry'),
  });

  if (!confirmed) {
    return false;
  }

  try {
    const { count } = await retryStorageTransferItems({
      id: transfer.id,
      storageTransferRetryDto: item ? { itemIds: [item.id] } : {},
    });
    toastManager.info($t('admin.storage_target_transfer_retry_queued', { values: { count } }));
    eventManager.emit('StorageTransferUpdate', transfer);
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_retry_storage_transfer'));
    return false;
  }
};

/** Removes one finished transfer, and its failure details, from the history. */
export const handleDeleteTransfer = async (transfer: StorageTransferResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('admin.storage_target_transfer_delete'),
    prompt: $t('admin.storage_target_transfer_delete_prompt'),
    confirmText: $t('admin.storage_target_transfer_delete'),
    confirmColor: 'danger',
  });

  if (!confirmed) {
    return;
  }

  try {
    await deleteStorageTransfer({ id: transfer.id });
    toastManager.info($t('admin.storage_target_transfer_deleted'));
    eventManager.emit('StorageTransferUpdate', transfer);
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_storage_transfer'));
  }
};

/** Clears every finished transfer for a target out of the history, to keep the database small. */
export const handleClearTransferHistory = async (target: StorageTargetResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('admin.storage_target_transfers_clear'),
    prompt: $t('admin.storage_target_transfers_clear_prompt', { values: { name: target.name } }),
    confirmText: $t('admin.storage_target_transfers_clear'),
    confirmColor: 'danger',
  });

  if (!confirmed) {
    return;
  }

  try {
    const { count } = await clearStorageTargetTransfers({ id: target.id });
    toastManager.info($t('admin.storage_target_transfers_cleared', { values: { count } }));
    eventManager.emit('StorageTargetUpdate', target);
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_storage_transfer'));
  }
};

export const storageTargetKindLabel = ($t: MessageFormatter, kind: StorageTargetKind) => {
  switch (kind) {
    case StorageTargetKind.S3: {
      return $t('admin.storage_target_kind_s3');
    }
    case StorageTargetKind.Webdav: {
      return $t('admin.storage_target_kind_webdav');
    }
    case StorageTargetKind.Local: {
      return $t('admin.storage_target_kind_local');
    }
    default: {
      return kind;
    }
  }
};
