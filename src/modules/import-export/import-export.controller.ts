import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { ExportFile, ExportService } from './export.service';
import { ImportService } from './import.service';

@ApiTags('Import / Export')
@ApiBearerAuth()
@Controller('projects/:projectId')
export class ImportExportController {
  constructor(
    private readonly importer: ImportService,
    private readonly exporter: ExportService,
  ) {}

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

  @Get('test-cases/export')
  async exportTestCases(@Param('projectId', ParseUUIDPipe) projectId: string, @Res({ passthrough: true }) res: Response) {
    return sendXlsx(res, await this.exporter.exportTestCases(projectId));
  }
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendXlsx(res: Response, file: ExportFile): StreamableFile {
  res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${file.filename}"` });
  return new StreamableFile(file.buffer);
}

@ApiTags('Import / Export')
@ApiBearerAuth()
@Controller('runs/:runId')
export class RunExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get('export')
  async exportRun(@Param('runId', ParseUUIDPipe) runId: string, @Res({ passthrough: true }) res: Response) {
    return sendXlsx(res, await this.exporter.exportRun(runId));
  }
}
