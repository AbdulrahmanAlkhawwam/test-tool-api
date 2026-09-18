import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @Get()
  list(@Query('includeArchived') includeArchived?: string) {
    return this.projects.list(includeArchived === 'true');
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthUser) {
    return this.projects.create(dto, user);
  }

  @Get(':key')
  getByKey(@Param('key') key: string) {
    return this.projects.getByKey(key);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, dto);
  }
}
