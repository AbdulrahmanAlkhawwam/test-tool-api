import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';
import { ProjectModulesService } from './project-modules.service';

@ApiTags('Modules')
@ApiBearerAuth()
@Controller()
export class ProjectModulesController {
  constructor(private readonly modules: ProjectModulesService) {}

  @Get('projects/:projectId/modules')
  list(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.modules.list(projectId);
  }

  @Post('projects/:projectId/modules')
  create(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateModuleDto) {
    return this.modules.create(projectId, dto);
  }

  @Patch('modules/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateModuleDto) {
    return this.modules.update(id, dto);
  }

  @Delete('modules/:id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.modules.remove(id);
  }
}
