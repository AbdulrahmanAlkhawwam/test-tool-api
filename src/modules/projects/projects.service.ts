import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Project } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async requireProject(id: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async list(includeArchived: boolean) {
    const projects = await this.prisma.project.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { testCases: { where: { deletedAt: null } } } } },
    });
    return projects.map(({ _count, ...p }) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      description: p.description,
      archivedAt: p.archivedAt,
      createdAt: p.createdAt,
      caseCount: _count.testCases,
    }));
  }

  async create(dto: CreateProjectDto, user: AuthUser) {
    if (await this.prisma.project.findUnique({ where: { key: dto.key } })) {
      throw new ConflictException(`Project key "${dto.key}" is already used`);
    }
    return this.prisma.project.create({
      data: { name: dto.name, key: dto.key, description: dto.description, createdById: user.id },
    });
  }

  async getByKey(key: string) {
    const project = await this.prisma.project.findUnique({
      where: { key: key.toUpperCase() },
      include: {
        modules: {
          orderBy: { code: 'asc' },
          include: { _count: { select: { testCases: { where: { deletedAt: null } } } } },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    return {
      ...project,
      modules: project.modules.map((m) => ({ id: m.id, name: m.name, code: m.code, caseCount: m._count.testCases })),
    };
  }

  async update(id: string, dto: UpdateProjectDto) {
    await this.requireProject(id);
    return this.prisma.project.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        ...(dto.archived === undefined ? {} : { archivedAt: dto.archived ? new Date() : null }),
      },
    });
  }
}
