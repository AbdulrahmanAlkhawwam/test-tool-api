import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultStatus, RunStatus } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateResultDto } from './dto/update-result.dto';

@Injectable()
export class ResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async update(runId: string, resultId: string, dto: UpdateResultDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      // Share-lock the run row so a concurrent completion (which locks it FOR UPDATE)
      // either waits for this save to commit or makes this save see COMPLETED.
      const [run] = await tx.$queryRaw<{ status: RunStatus }[]>`
        SELECT status FROM "TestRun" WHERE id = ${runId} FOR SHARE`;
      const result = run && (await tx.testResult.findFirst({ where: { id: resultId, runId } }));
      if (!result) throw new NotFoundException('Result not found in this run');
      if (run.status === RunStatus.COMPLETED) {
        throw new ConflictException('Run is completed – results are read-only');
      }

      const status = dto.status ?? result.status;
      const executed = status !== ResultStatus.NOT_EXECUTED;
      return tx.testResult.update({
        where: { id: resultId },
        data: {
          status,
          actualResult: dto.actualResult,
          notes: dto.notes,
          executedById: executed ? user.id : null,
          executedAt: executed ? new Date() : null,
        },
        include: { executedBy: { select: { id: true, name: true } } },
      });
    });
  }
}
