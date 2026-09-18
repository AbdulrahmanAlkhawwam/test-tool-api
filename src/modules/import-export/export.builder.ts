import { Priority, ResultStatus } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PRIORITY_LABELS, STATUS_LABELS } from './labels';

export const TEMPLATE_COLUMNS = [
  'ID', 'Module', 'Test Case Name', 'Description', 'Preconditions', 'Test Steps',
  'Test Data', 'Expected Result', 'Actual Result', 'Priority', 'Status', 'Notes',
] as const;

const COLUMN_WIDTHS = [14, 18, 36, 40, 32, 44, 26, 40, 40, 10, 14, 30];

export interface ExportRow {
  code: string;
  module: string;
  name: string;
  description: string | null;
  preconditions: string | null;
  steps: string | null;
  testData: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  priority: Priority;
  status: ResultStatus;
  notes: string | null;
}

export async function buildTemplateWorkbook(sheetName: string, rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const safeName = sheetName.replace(/[[\]:*?/\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Test Cases';
  const ws = wb.addWorksheet(safeName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = TEMPLATE_COLUMNS.map((header, i) => ({ header, key: `c${i}`, width: COLUMN_WIDTHS[i] }));
  for (const r of rows) {
    ws.addRow([
      r.code, r.module, r.name, r.description ?? '', r.preconditions ?? '', r.steps ?? '', r.testData ?? '',
      r.expectedResult ?? '', r.actualResult ?? '', PRIORITY_LABELS[r.priority], STATUS_LABELS[r.status], r.notes ?? '',
    ]);
  }
  ws.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: 'top' };
  });
  ws.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
