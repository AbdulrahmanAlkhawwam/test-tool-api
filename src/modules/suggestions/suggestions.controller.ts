import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { SuggestionsService } from './suggestions.service';

@ApiTags('AI suggestions')
@ApiBearerAuth()
@Controller()
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  /**
   * `@Res({ passthrough: false })` because Nest's default response handling sends an *empty*
   * body for a handler that returns `null` — Express never calls `res.json` at all in that case.
   * A caller must be able to tell "no pending suggestion" (an explicit JSON `null`) apart from a
   * network hiccup that truncated the body, so the body is written out here explicitly.
   */
  @Get('test-cases/:id/suggestion')
  @ApiOkResponse({
    description: "The test case's pending AI suggestion, or null when it has none.",
    schema: {
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        testCaseId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['PENDING'] },
        changes: {
          type: 'object',
          description: 'Template field → { from, to }, for the fields the suggestion proposes to change.',
        },
        rationale: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        createdBy: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
        },
      },
    },
  })
  async pending(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: false }) res: Response): Promise<void> {
    const result = await this.suggestions.pendingFor(id);
    res.status(200).json(result);
  }

  @Post('suggestions/:id/accept')
  @HttpCode(200)
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.suggestions.accept(id, user);
  }

  @Post('suggestions/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.suggestions.reject(id, user);
  }
}
