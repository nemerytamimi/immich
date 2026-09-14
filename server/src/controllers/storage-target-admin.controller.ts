import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  StorageTargetCreateDto,
  StorageTargetResponseDto,
  StorageTargetTestResponseDto,
  StorageTargetUpdateDto,
  StorageTransferCountResponseDto,
  StorageTransferCreateDto,
  StorageTransferItemSearchDto,
  StorageTransferItemsResponseDto,
  StorageTransferResponseDto,
  StorageTransferRetryDto,
} from 'src/dtos/storage-target.dto';
import { ApiTag, Permission } from 'src/enum';
import { Authenticated } from 'src/middleware/auth.guard';
import { StorageTargetService } from 'src/services/storage-target.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.StorageTargets)
@Controller('admin/storage-targets')
export class StorageTargetAdminController {
  constructor(private service: StorageTargetService) {}

  @Get()
  @Authenticated({ permission: Permission.AdminStorageTargetRead, admin: true })
  @Endpoint({
    summary: 'Retrieve storage targets',
    description: 'Retrieve all configured external storage targets. Credentials are never included.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getStorageTargets(): Promise<StorageTargetResponseDto[]> {
    return this.service.getAll();
  }

  @Post()
  @Authenticated({ permission: Permission.AdminStorageTargetCreate, admin: true })
  @Endpoint({
    summary: 'Create a storage target',
    description: 'Create an external storage target for importing and exporting assets.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  createStorageTarget(@Body() dto: StorageTargetCreateDto): Promise<StorageTargetResponseDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AdminStorageTargetRead, admin: true })
  @Endpoint({
    summary: 'Retrieve a storage target',
    description: 'Retrieve a specific storage target by its ID. Credentials are never included.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getStorageTarget(@Param() { id }: UUIDParamDto): Promise<StorageTargetResponseDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @Endpoint({
    summary: 'Update a storage target',
    description: 'Update a storage target. Omitting credentials keeps the stored ones.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  updateStorageTarget(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTargetUpdateDto,
  ): Promise<StorageTargetResponseDto> {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AdminStorageTargetDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a storage target',
    description: 'Delete a storage target. Objects already written to the remote system are left in place.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  deleteStorageTarget(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(id);
  }

  @Post(':id/test')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Test a storage target',
    description: 'Verify connectivity and write access by round-tripping a small marker object.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  testStorageTarget(@Param() { id }: UUIDParamDto): Promise<StorageTargetTestResponseDto> {
    return this.service.test(id);
  }

  @Post(':id/export')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @Endpoint({
    summary: 'Export assets to a storage target',
    description: "Queue a transfer that uploads a user's original files, and their sidecars, to the target.",
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  exportToStorageTarget(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTransferCreateDto,
  ): Promise<StorageTransferResponseDto> {
    return this.service.startExport(id, dto);
  }

  @Post(':id/import')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @Endpoint({
    summary: 'Import assets from a storage target',
    description: 'Queue a transfer that scans the target and imports supported files as new assets.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  importFromStorageTarget(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTransferCreateDto,
  ): Promise<StorageTransferResponseDto> {
    return this.service.startImport(id, dto);
  }

  @Post(':id/offload')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @Endpoint({
    summary: 'Offload assets to a storage target',
    description:
      "Queue a transfer that uploads a user's original files to the target and then removes the local copies. " +
      'The assets stay in the library: thumbnails, metadata and album membership are untouched, and the originals ' +
      'are fetched back from the target on demand.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  offloadToStorageTarget(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTransferCreateDto,
  ): Promise<StorageTransferResponseDto> {
    return this.service.startOffload(id, dto);
  }

  @Post(':id/restore')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @Endpoint({
    summary: 'Restore offloaded assets from a storage target',
    description:
      'Queue a transfer that downloads offloaded originals back onto local storage. Assets keep their existing ' +
      'IDs and metadata; nothing is re-imported as a new asset.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  restoreFromStorageTarget(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTransferCreateDto,
  ): Promise<StorageTransferResponseDto> {
    return this.service.startRestore(id, dto);
  }

  @Post('transfers/:id/pause')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Pause a transfer',
    description:
      'Stop a running or pending transfer without ending it. Work already queued drains without acting, and whatever ' +
      'has already been transferred is kept.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  pauseStorageTransfer(@Param() { id }: UUIDParamDto): Promise<StorageTransferResponseDto> {
    return this.service.pauseTransfer(id);
  }

  @Post('transfers/:id/resume')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Resume a paused transfer',
    description:
      'Re-queue a paused transfer under a new run. Every direction is idempotent, so it picks up whatever is still ' +
      'outstanding rather than repeating completed work, and work queued before the pause no longer acts. Completed ' +
      'items stay counted, except for an export, whose count restarts because its walk re-counts what is already on ' +
      'the target.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  resumeStorageTransfer(@Param() { id }: UUIDParamDto): Promise<StorageTransferResponseDto> {
    return this.service.resumeTransfer(id);
  }

  @Post('transfers/:id/cancel')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Cancel a transfer',
    description:
      'End a transfer for good. Whatever has already been transferred stays transferred; this stops the run rather ' +
      'than reversing it.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  cancelStorageTransfer(@Param() { id }: UUIDParamDto): Promise<StorageTransferResponseDto> {
    return this.service.cancelTransfer(id);
  }

  @Get('transfers/:id/items')
  @Authenticated({ permission: Permission.AdminStorageTargetRead, admin: true })
  @Endpoint({
    summary: 'Retrieve the failed items of a transfer',
    description:
      'List the files a transfer failed on, with the file name, size, reason and attempt count for each, most ' +
      'recent first. An item leaves the list once a later attempt succeeds.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getStorageTransferItems(
    @Param() { id }: UUIDParamDto,
    @Query() dto: StorageTransferItemSearchDto,
  ): Promise<StorageTransferItemsResponseDto> {
    return this.service.getTransferFailures(id, dto);
  }

  @Post('transfers/:id/retry')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Retry the failed items of a transfer',
    description:
      'Queue failed items again under the transfer, without walking the whole library. Omit the item list to retry ' +
      'every failure. A paused transfer retries its failures when it is resumed instead.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  retryStorageTransferItems(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageTransferRetryDto,
  ): Promise<StorageTransferCountResponseDto> {
    return this.service.retryTransferFailures(id, dto);
  }

  @Delete('transfers/:id')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a transfer from the history',
    description:
      'Delete a completed, failed or cancelled transfer and its failure records. Nothing that was transferred is ' +
      'affected. Cancel a transfer that is still going before removing it.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  deleteStorageTransfer(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteTransfer(id);
  }

  @Delete(':id/transfers')
  @Authenticated({ permission: Permission.AdminStorageTargetUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Clear finished transfers from the history',
    description:
      'Delete every completed, failed and cancelled transfer for a storage target, with their failure records. ' +
      'Pending, running and paused transfers are kept, and nothing that was transferred is affected.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  clearStorageTargetTransfers(@Param() { id }: UUIDParamDto): Promise<StorageTransferCountResponseDto> {
    return this.service.clearTransferHistory(id);
  }

  @Get(':id/transfers')
  @Authenticated({ permission: Permission.AdminStorageTargetRead, admin: true })
  @Endpoint({
    summary: 'Retrieve transfer history',
    description: 'Retrieve recent import and export transfers for a storage target, including progress.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getStorageTargetTransfers(@Param() { id }: UUIDParamDto): Promise<StorageTransferResponseDto[]> {
    return this.service.getTransfers(id);
  }
}
