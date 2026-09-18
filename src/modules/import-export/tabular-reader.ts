import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { extname } from 'path';

const UNREADABLE = 'Could not read the file – make sure it is a valid .xlsx or .csv';

export async function readTabular(buffer: Buffer, filename: string): Promise<string[][]> {
  const ext = extname(filename).toLowerCase();
  if (ext === '.csv') {
    try {
      return parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][];
    } catch {
      throw new BadRequestException(UNREADABLE);
    }
  }
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    try {
      // exceljs's Buffer typing lags behind @types/node.
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException(UNREADABLE);
    }
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
    // Error cells and formula results that are errors, e.g. { error: '#DIV/0!' }.
    if ('error' in value) return typeof value.error === 'string' ? value.error : '';
    // Formula results can themselves be objects (errors, dates) – never print "[object Object]".
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    // Hyperlink cells: text may be plain or rich text.
    if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
    return '';
  }
  return String(value);
}

function trimTrailingEmpty(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}
