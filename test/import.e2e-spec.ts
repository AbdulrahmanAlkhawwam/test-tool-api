import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, makeXlsx, resetDb, TestContext } from './utils/test-app';

const HEADER = ['ID', 'Module', 'Test Case Name', 'Description', 'Preconditions', 'Test Steps', 'Test Data', 'Expected Result', 'Actual Result', 'Priority', 'Status ', 'Notes'];
const SHEET = [
  HEADER,
  ['TC-AUTH-001', 'Authentication', 'Login with Realy user (Email)', 'Login with valid Email and password', 'User has a registered account',
    'Enter credentials → Login', 'Valid email/password', 'User reaches organization screen', 'Like Exp Result', 'High', 'Successed', ''],
  ['TC-AUTH-004', 'Authentication', 'Login with Magic Link (Success)', 'Verify magic link login', 'User can access email',
    '1. Open Login\n2. Select Magic Link login\n3. Enter registered email', 'Registered email', 'User is authenticated and redirected',
    'Opens a new tab', 'High', 'Successed', ''],
  ['TC-AUTH-007', 'Authentication', 'Magic Link – Unregistered Email', '', 'Email is not registered', '', 'Unregistered email',
    'No unauthorized access', 'Registers the user without permission', 'High', 'Failed', ''],
  ['', 'Authentication', 'Register with Empty Required Fields', '', 'Registration screen is open', '', 'Empty', 'Validation shown', '', 'High', 'Not Executed', ''],
  ['TC-AUTH-099', 'Authentication', '', '', '', '', '', '', '', 'High', '', ''],
];

describe('Import (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const preview = (buffer: Buffer, filename = 'auth.xlsx', auth = actors.testerAuth) =>
    ctx.http().post(`/api/projects/${projectId}/import/preview`).set(auth).attach('file', buffer, filename);
  const confirm = (body: Record<string, unknown>, auth = actors.testerAuth) =>
    ctx.http().post(`/api/projects/${projectId}/import/confirm`).set(auth).send(body);

  it('previews without writing anything', async () => {
    const res = await preview(await makeXlsx(SHEET)).expect(201);
    expect(res.body.importId).toEqual(expect.any(String));
    expect(res.body.summary).toEqual({ total: 5, valid: 4, withErrors: 1, duplicates: 0 });
    expect(res.body.rows[4].errors).toEqual(['Test Case Name is required']);
    expect(await ctx.prisma.testCase.count()).toBe(0);
  });

  it('confirms: creates the module, keeps IDs, generates missing ones and preserves multi-line steps', async () => {
    const { importId } = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    const res = await confirm({ importId }).expect(201);
    expect(res.body).toEqual({ created: 4, updated: 0, skipped: 1, runId: null, renamedModules: [] });

    const module = await ctx.prisma.projectModule.findUniqueOrThrow({ where: { projectId_code: { projectId, code: 'AUTH' } } });
    expect(module.name).toBe('Authentication');
    const cases = await ctx.prisma.testCase.findMany({ where: { projectId }, orderBy: { code: 'asc' } });
    expect(cases.map((c) => c.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-004', 'TC-AUTH-007', 'TC-AUTH-008']);
    expect(cases[1].steps).toBe('1. Open Login\n2. Select Magic Link login\n3. Enter registered email');
    expect(cases[0]).toMatchObject({ priority: 'HIGH', createdById: actors.tester.id });
    expect(await ctx.prisma.testRun.count()).toBe(0);
  });

  it('optionally creates a completed "Imported" run from the sheet statuses', async () => {
    const { importId } = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    const res = await confirm({ importId, createImportedRun: true, runName: 'Imported AUTH sheet' }).expect(201);

    const run = await ctx.prisma.testRun.findUniqueOrThrow({ where: { id: res.body.runId }, include: { results: { include: { testCase: true } } } });
    expect(run).toMatchObject({ name: 'Imported AUTH sheet', status: 'COMPLETED' });
    const byCode = Object.fromEntries(run.results.map((r) => [r.testCase!.code, r]));
    expect(byCode['TC-AUTH-001']).toMatchObject({ status: 'PASSED', actualResult: 'Like Exp Result', executedById: actors.tester.id });
    expect(byCode['TC-AUTH-007'].status).toBe('FAILED');
    expect(byCode['TC-AUTH-008']).toMatchObject({ status: 'NOT_EXECUTED', executedById: null });
  });

  it('flags duplicates and applies skip or update', async () => {
    const module = await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    await seedCase(ctx.prisma, { projectId, moduleId: module.id, userId: actors.admin.id, code: 'TC-AUTH-001', name: 'Old name' });

    const first = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    expect(first.summary.duplicates).toBe(1);
    expect(first.rows[0].duplicate).toBe(true);
    expect((await confirm({ importId: first.importId, duplicateStrategy: 'skip' }).expect(201)).body)
      .toEqual({ created: 3, updated: 0, skipped: 2, runId: null, renamedModules: [] });
    expect((await ctx.prisma.testCase.findFirstOrThrow({ where: { code: 'TC-AUTH-001' } })).name).toBe('Old name');

    const second = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    expect((await confirm({ importId: second.importId, duplicateStrategy: 'update' }).expect(201)).body)
      .toEqual({ created: 1, updated: 3, skipped: 1, runId: null, renamedModules: [] });
    const updated = await ctx.prisma.testCase.findFirstOrThrow({ where: { code: 'TC-AUTH-001' } });
    expect(updated).toMatchObject({ name: 'Login with Realy user (Email)', updatedById: actors.tester.id });
  });

  it('gives a module whose derived code is taken by a different module the next free code', async () => {
    const um = await seedModule(ctx.prisma, projectId, { code: 'UM', name: 'User Management' });
    await seedCase(ctx.prisma, { projectId, moduleId: um.id, userId: actors.admin.id, code: 'TC-UM-001' });
    const sheet = [
      HEADER,
      ['', 'Unit Measure', 'Convert kg to g', '', '', '', '', 'Shows 1000 g', '', 'Low', '', ''],
      ['', 'unit measure', 'Convert m to cm', '', '', '', '', 'Shows 100 cm', '', 'Low', '', ''],
      ['', 'User Management', 'Invite a user', '', '', '', '', 'Invite sent', '', 'High', '', ''],
    ];
    const { importId } = (await preview(await makeXlsx(sheet)).expect(201)).body;
    const res = await confirm({ importId }).expect(201);
    expect(res.body).toEqual({ created: 3, updated: 0, skipped: 0, runId: null, renamedModules: [{ name: 'Unit Measure', code: 'UM2' }] });

    const modules = await ctx.prisma.projectModule.findMany({ where: { projectId }, orderBy: { code: 'asc' } });
    expect(modules.map((m) => [m.code, m.name])).toEqual([['UM', 'User Management'], ['UM2', 'Unit Measure']]);
    const cases = await ctx.prisma.testCase.findMany({ where: { projectId }, orderBy: { code: 'asc' }, include: { module: true } });
    expect(cases.map((c) => [c.code, c.module.code])).toEqual([
      ['TC-UM-001', 'UM'], ['TC-UM-002', 'UM'], ['TC-UM2-001', 'UM2'], ['TC-UM2-002', 'UM2'],
    ]);
  });

  it('rejects null import options', async () => {
    const { importId } = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    await confirm({ importId, duplicateStrategy: null }).expect(400);
    await confirm({ importId, createImportedRun: null }).expect(400);
  });

  it('imports csv files', async () => {
    const csv = 'ID,Module,Test Case Name,Priority\nTC-CART-001,Cart,"Add to cart, then remove",Low\n';
    const { importId } = (await preview(Buffer.from(csv), 'cart.csv').expect(201)).body;
    expect((await confirm({ importId }).expect(201)).body.created).toBe(1);
  });

  it('rejects bad files', async () => {
    const noFile = await ctx.http().post(`/api/projects/${projectId}/import/preview`).set(actors.testerAuth).expect(400);
    expect(noFile.body.message).toBe('file is required');
    await preview(Buffer.from('%PDF'), 'cases.pdf').expect(400);
    const corrupt = await preview(Buffer.from('not really a workbook'), 'cases.xlsx').expect(400);
    expect(corrupt.body.message).toBe('Could not read the file – make sure it is a valid .xlsx or .csv');
    await preview(Buffer.from('ID,Test Case Name\n"unclosed'), 'cases.csv').expect(400);
    const noHeader = await preview(await makeXlsx([['foo', 'bar']])).expect(400);
    expect(noHeader.body.message).toBe('Could not find a header row with "ID" and "Test Case Name" columns');
  });

  it('import previews are single-use and private to the uploader and project', async () => {
    const { importId } = (await preview(await makeXlsx(SHEET)).expect(201)).body;
    await confirm({ importId }, actors.adminAuth).expect(404);
    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR' });
    await ctx.http().post(`/api/projects/${other.id}/import/confirm`).set(actors.testerAuth).send({ importId }).expect(404);
    await confirm({ importId }).expect(201);
    const reused = await confirm({ importId }).expect(404);
    expect(reused.body.message).toBe('Import preview expired or not found – upload the file again');
  });
});
