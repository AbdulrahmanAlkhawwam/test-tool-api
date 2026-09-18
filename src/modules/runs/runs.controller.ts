import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { CreateRunDto } from './dto/create-run.dto';
import { UpdateRunDto } from './dto/update-run.dto';
import { RunsService } from './runs.service';

@ApiTags('Runs')
@ApiBearerAuth()
@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post('projects/:projectId/runs')
  create(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateRunDto, @CurrentUser() user: AuthUser) {
    return this.runs.create(projectId, dto, user);
  }

  @Get('projects/:projectId/runs')
  list(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.runs.list(projectId);
  }

  @Get('runs/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.findOne(id);
  }

  @Patch('runs/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRunDto) {
    return this.runs.update(id, dto);
  }
}
