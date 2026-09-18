import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { CreateTestCaseDto } from './dto/create-test-case.dto';
import { ListTestCasesQuery } from './dto/list-test-cases.query';
import { UpdateTestCaseDto } from './dto/update-test-case.dto';
import { TestCasesService } from './test-cases.service';

@ApiTags('Test Cases')
@ApiBearerAuth()
@Controller()
export class TestCasesController {
  constructor(private readonly testCases: TestCasesService) {}

  @Get('projects/:projectId/test-cases')
  list(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: ListTestCasesQuery) {
    return this.testCases.list(projectId, query);
  }

  @Post('projects/:projectId/test-cases')
  create(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateTestCaseDto, @CurrentUser() user: AuthUser) {
    return this.testCases.create(projectId, dto, user);
  }

  @Get('test-cases/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.testCases.findOne(id);
  }

  @Patch('test-cases/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTestCaseDto, @CurrentUser() user: AuthUser) {
    return this.testCases.update(id, dto, user);
  }

  @Delete('test-cases/:id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.testCases.remove(id, user);
  }
}
