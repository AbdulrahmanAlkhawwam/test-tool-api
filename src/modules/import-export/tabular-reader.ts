import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { extname } from 'path';

export async function readTabular(buffer: Buffer, filename: string): Promise<string[][]> {
  const ext = extname(filename).toLowerCase();
  if (ext === '.csv') {
    return parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][];
  }
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    // exceljs's Buffer typing lags behind @types/node.
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
      rows.push(trimTrailingEmpty(cells));
    }
    return rows;
  }
  throw new BadRequestException('Only .xlsx and .csv files are supported');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return value.result === undefined || value.result === null ? '' : String(value.result);
    if ('text' in value) return String(value.text);
    return '';
  }
  return String(value);
}

function trimTrailingEmpty(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}
