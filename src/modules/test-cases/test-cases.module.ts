import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { CaseReviewService } from './case-review.service';
import { TestCasesController } from './test-cases.controller';
import { TestCasesService } from './test-cases.service';

@Module({
  imports: [ProjectsModule],
  controllers: [TestCasesController],
  providers: [TestCasesService, CaseReviewService],
  exports: [TestCasesService, CaseReviewService],
})
export class TestCasesModule {}
