import { Priority, ResultStatus } from '@prisma/client';
import { PRIORITY, STATUS } from './read-tools';
import { PRIORITY as WRITE_PRIORITY } from './write-tools';

/**
 * read-tools.ts and write-tools.ts hand-duplicate the Prisma `Priority` and `ResultStatus`
 * values as zod literal unions (see the comment above PRIORITY in read-tools.ts) because
 * z.nativeEnum is not identical across the zod 3/4 versions this project supports. That
 * duplication is only safe as long as it never drifts from the real Prisma enums, so this test
 * fails loudly the moment someone adds/renames/removes a Priority or ResultStatus value in
 * prisma/schema.prisma without updating the literal unions here.
 */
describe('MCP tool enum literal unions stay in sync with Prisma', () => {
  it('read-tools PRIORITY matches Priority', () => {
    expect([...PRIORITY.options].sort()).toEqual(Object.values(Priority).sort());
  });

  it('read-tools STATUS matches ResultStatus', () => {
    expect([...STATUS.options].sort()).toEqual(Object.values(ResultStatus).sort());
  });

  it('write-tools PRIORITY matches Priority', () => {
    expect([...WRITE_PRIORITY.options].sort()).toEqual(Object.values(Priority).sort());
  });
});
