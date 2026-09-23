import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { APPROVED_CASE } from '../../common/review-state';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateModuleDto } from './dto/create-module.dto';
import { UpdateModuleDto } from './dto/update-module.dto';

@Injectable()
export class ProjectModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async list(projectId: string) {
    await this.projects.requireProject(projectId);
    const modules = await this.prisma.projectModule.findMany({
      where: { projectId },
      orderBy: { code: 'asc' },
      include: { _count: { select: { testCases: { where: APPROVED_CASE } } } },
    });
    return modules.map((m) => ({ id: m.id, name: m.name, code: m.code, caseCount: m._count.testCases }));
  }

  async create(projectId: string, dto: CreateModuleDto) {
    await this.projects.requireProject(projectId);
    await this.assertCodeFree(projectId, dto.code);
    return this.prisma.projectModule.create({ data: { projectId, name: dto.name, code: dto.code } });
  }

  async update(id: string, dto: UpdateModuleDto) {
    const module = await this.requireModule(id);
    if (dto.code && dto.code !== module.code) await this.assertCodeFree(module.projectId, dto.code);
    return this.prisma.projectModule.update({ where: { id }, data: { name: dto.name, code: dto.code } });
  }

  async remove(id: string): Promise<void> {
    await this.requireModule(id);
    if ((await this.prisma.testCase.count({ where: { moduleId: id } })) > 0) {
      throw new ConflictException('Only modules without test cases can be deleted');
    }
    await this.prisma.projectModule.delete({ where: { id } });
  }

  private async requireModule(id: string) {
    const module = await this.prisma.projectModule.findUnique({ where: { id } });
    if (!module) throw new NotFoundException('Module not found');
    return module;
  }

  private async assertCodeFree(projectId: string, code: string): Promise<void> {
    if (await this.prisma.projectModule.findUnique({ where: { projectId_code: { projectId, code } } })) {
      throw new ConflictException(`Module code "${code}" already exists in this project`);
    }
  }
}
