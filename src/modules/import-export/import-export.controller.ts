import { BadRequestException, Body, Controller, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { ImportService } from './import.service';

@ApiTags('Import / Export')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class ImportExportController {
  constructor(private readonly importer: ImportService) {}

  @Post('import/preview')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.importer.preview(projectId, file, user);
  }

  @Post('import/confirm')
  confirm(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: ConfirmImportDto, @CurrentUser() user: AuthUser) {
    return this.importer.confirm(projectId, dto, user);
  }
}
