import ExcelJS from 'exceljs';
import { buildTemplateWorkbook, TEMPLATE_COLUMNS } from './export.builder';
import { parseImportRows } from './import.parser';
import { readTabular } from './tabular-reader';

const row = {
  code: 'TC-AUTH-004',
  module: 'Authentication',
  name: 'Login with Magic Link (Success)',
  description: 'Verify magic link login',
  preconditions: 'User can access email',
  steps: '1. Open Login\n2. Select Magic Link login',
  testData: 'Registered email',
  expectedResult: 'User is authenticated',
  actualResult: 'Opens a new tab',
  priority: 'HIGH' as const,
  status: 'FAILED' as const,
  notes: null,
};

describe('buildTemplateWorkbook', () => {
  it('writes the exact template header and human labels', async () => {
    const table = await readTabular(await buildTemplateWorkbook('NINJA', [row]), 'x.xlsx');
    expect(table[0]).toEqual([...TEMPLATE_COLUMNS]);
    expect(table[1]).toEqual([
      'TC-AUTH-004', 'Authentication', 'Login with Magic Link (Success)', 'Verify magic link login', 'User can access email',
      '1. Open Login\n2. Select Magic Link login', 'Registered email', 'User is authenticated', 'Opens a new tab', 'High', 'Failed',
    ]);
  });

  it('round-trips through the importer', async () => {
    const table = await readTabular(await buildTemplateWorkbook('NINJA', [row]), 'x.xlsx');
    expect(parseImportRows(table)[0]).toMatchObject({
      code: 'TC-AUTH-004', moduleCode: 'AUTH', steps: row.steps, priority: 'HIGH', status: 'FAILED', errors: [],
    });
  });

  it('freezes and bolds the header and sanitizes the sheet name', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildTemplateWorkbook('Sprint 12: RC/1?', [row])) as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe('Sprint 12 RC1');
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
});
