import { CreatedVia, Priority, ReviewState, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hashPassword } from '../../src/common/password';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TestContext } from './test-app';

export const PASSWORD = 'Passw0rd!';

export async function seedUser(
  prisma: PrismaService,
  data: { email?: string; name?: string; role?: Role; active?: boolean; password?: string } = {},
) {
  return prisma.user.create({
    data: {
      email: data.email ?? `user-${randomUUID().slice(0, 8)}@ejad.test`,
      name: data.name ?? 'Test User',
      role: data.role ?? Role.TESTER,
      active: data.active ?? true,
      passwordHash: await hashPassword(data.password ?? PASSWORD),
    },
  });
}

export async function login(ctx: TestContext, email: string, password = PASSWORD): Promise<string> {
  const res = await ctx.http().post('/api/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

export async function seedActors(ctx: TestContext) {
  const admin = await seedUser(ctx.prisma, { email: 'admin@ejad.test', name: 'Admin', role: Role.ADMIN });
  const tester = await seedUser(ctx.prisma, { email: 'tester@ejad.test', name: 'Tess Tester', role: Role.TESTER });
  return {
    admin,
    tester,
    adminAuth: { Authorization: `Bearer ${await login(ctx, admin.email)}` },
    testerAuth: { Authorization: `Bearer ${await login(ctx, tester.email)}` },
  };
}

export async function seedProject(prisma: PrismaService, createdById: string, data: { key?: string; name?: string } = {}) {
  return prisma.project.create({
    data: { key: data.key ?? 'NINJA', name: data.name ?? 'Ninja Store', createdById },
  });
}

export async function seedModule(prisma: PrismaService, projectId: string, data: { code?: string; name?: string } = {}) {
  return prisma.projectModule.create({
    data: { projectId, code: data.code ?? 'AUTH', name: data.name ?? 'Authentication' },
  });
}

export async function seedCase(
  prisma: PrismaService,
  data: {
    projectId: string;
    moduleId: string;
    userId: string;
    code: string;
    name?: string;
    priority?: Priority;
    reviewState?: ReviewState;
    createdVia?: CreatedVia;
    expectedResult?: string;
  },
) {
  return prisma.testCase.create({
    data: {
      projectId: data.projectId,
      moduleId: data.moduleId,
      code: data.code,
      name: data.name ?? `Case ${data.code}`,
      priority: data.priority ?? Priority.MEDIUM,
      expectedResult: data.expectedResult ?? 'Works',
      reviewState: data.reviewState ?? ReviewState.APPROVED,
      createdVia: data.createdVia ?? CreatedVia.WEB,
      createdById: data.userId,
      updatedById: data.userId,
    },
  });
}
