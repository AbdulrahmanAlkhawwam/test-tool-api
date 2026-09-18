import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ResultStatus, RunStatus } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateResultDto } from './dto/update-result.dto';

@Injectable()
export class ResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async update(runId: string, resultId: string, dto: UpdateResultDto, user: AuthUser) {
    const result = await this.prisma.testResult.findFirst({
      where: { id: resultId, runId },
      include: { run: { select: { status: true } } },
    });
    if (!result) throw new NotFoundException('Result not found in this run');
    if (result.run.status === RunStatus.COMPLETED) {
      throw new ConflictException('Run is completed – results are read-only');
    }

    const status = dto.status ?? result.status;
    const executed = status !== ResultStatus.NOT_EXECUTED;
    return this.prisma.testResult.update({
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
  }
}
