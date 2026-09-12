import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { StorageTargetResponseDto } from 'src/dtos/storage-target.dto';
import { ApiTag, Permission } from 'src/enum';
import { Authenticated } from 'src/middleware/auth.guard';
import { StorageTargetService } from 'src/services/storage-target.service';

/**
 * The non-admin half of storage targets. Offloading is a user-level action, so a
 * user has to be able to see which targets they may offload to -- but only the
 * names, and only the ones that are usable. Everything about configuring a target
 * stays behind the admin controller.
 */
@ApiTags(ApiTag.StorageTargets)
@Controller('storage-targets')
export class StorageTargetController {
  constructor(private service: StorageTargetService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetOffload })
  @Endpoint({
    summary: 'Retrieve storage targets available for offloading',
    description:
      'Retrieve the enabled storage targets that assets can be offloaded to. Credentials and connection details ' +
      'are never included.',
    history: new HistoryBuilder().added('v3').beta('v3'),
  })
  getAvailableStorageTargets(): Promise<StorageTargetResponseDto[]> {
    return this.service.getAvailable();
  }
}
