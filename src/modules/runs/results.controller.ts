import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { UpdateResultDto } from './dto/update-result.dto';
import { ResultsService } from './results.service';

@ApiTags('Runs')
@ApiBearerAuth()
@Controller('runs/:runId/results')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Patch(':resultId')
  update(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: UpdateResultDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.results.update(runId, resultId, dto, user);
  }
}
