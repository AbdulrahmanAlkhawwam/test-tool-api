import { ApiTokensService } from './api-tokens.service';
import { generateApiToken, hashApiToken } from './api-token';

function makeService() {
  const prisma = { apiToken: { findUnique: jest.fn(), update: jest.fn() } };
  const service = new ApiTokensService(prisma as never);
  return { service, prisma };
}

const FUTURE = new Date(Date.now() + 86_400_000);

describe('ApiTokensService.verify — fails closed on a missing user row', () => {
  it('answers the uniform 401 instead of throwing when the joined user is null', async () => {
    const { service, prisma } = makeService();
    const token = generateApiToken();
    prisma.apiToken.findUnique.mockResolvedValueOnce({
      id: 't1',
      tokenHash: hashApiToken(token),
      expiresAt: FUTURE,
      revokedAt: null,
      lastUsedAt: null,
      user: null,
    });

    await expect(service.verify(token)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or expired access token',
    });
  });

  it('still answers the uniform 401 for an inactive user, and does not throw', async () => {
    const { service, prisma } = makeService();
    const token = generateApiToken();
    prisma.apiToken.findUnique.mockResolvedValueOnce({
      id: 't1',
      tokenHash: hashApiToken(token),
      expiresAt: FUTURE,
      revokedAt: null,
      lastUsedAt: null,
      user: { id: 'u1', email: 'gone@ejad.test', name: 'Gone', role: 'TESTER', active: false },
    });

    await expect(service.verify(token)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or expired access token',
    });
  });

  it('resolves normally for a valid token with an active user', async () => {
    const { service, prisma } = makeService();
    const token = generateApiToken();
    prisma.apiToken.findUnique.mockResolvedValueOnce({
      id: 't1',
      tokenHash: hashApiToken(token),
      expiresAt: FUTURE,
      revokedAt: null,
      lastUsedAt: null,
      user: { id: 'u1', email: 'tester@ejad.test', name: 'Tester', role: 'TESTER', active: true },
    });

    const result = await service.verify(token);

    expect(result).toEqual({
      tokenId: 't1',
      lastUsedAt: null,
      user: { id: 'u1', email: 'tester@ejad.test', name: 'Tester', role: 'TESTER' },
    });
  });
});
