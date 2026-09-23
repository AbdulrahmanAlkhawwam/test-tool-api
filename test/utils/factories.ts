import { ApiTokenPurpose, CreatedVia, Priority, ReviewState, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { apiTokenPrefix, generateApiToken, hashApiToken } from '../../src/modules/api-tokens/api-token';
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

/** Stores a PENDING AI suggestion directly (the only producer in the app is the MCP tool). */
export async function seedSuggestion(
  prisma: PrismaService,
  data: { testCaseId: string; userId: string; changes: Record<string, { from: string | null; to: string | null }>; rationale?: string },
) {
  return prisma.testCaseSuggestion.create({
    data: {
      testCaseId: data.testCaseId,
      createdById: data.userId,
      changes: data.changes,
      rationale: data.rationale ?? 'The steps were missing the submit action',
    },
  });
}

/** Creates a usable PAT and returns both the raw value and the stored row. */
export async function seedApiToken(
  prisma: PrismaService,
  userId: string,
  overrides: { name?: string; expiresAt?: Date; revokedAt?: Date | null; lastUsedAt?: Date | null } = {},
) {
  const token = generateApiToken();
  const record = await prisma.apiToken.create({
    data: {
      userId,
      name: overrides.name ?? 'Test token',
      purpose: ApiTokenPurpose.MCP,
      tokenHash: hashApiToken(token),
      prefix: apiTokenPrefix(token),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 90 * 86_400_000),
      revokedAt: overrides.revokedAt ?? null,
      lastUsedAt: overrides.lastUsedAt ?? null,
    },
  });
  return { token, record };
}
