import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { readTabular } from './tabular-reader';

describe('readTabular', () => {
  it('reads the first sheet of an xlsx, including rich text and multi-line cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('AUTH');
    ws.addRow(['ID', 'Test Case Name']);
    ws.addRow(['TC-AUTH-001', { richText: [{ text: 'Login ' }, { text: 'ok', font: { bold: true } }] }]);
    ws.addRow(['TC-AUTH-002', '1. Open\n2. Tap']);
    wb.addWorksheet('Other').addRow(['ignored']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    expect(await readTabular(buffer, 'cases.XLSX')).toEqual([
      ['ID', 'Test Case Name'],
      ['TC-AUTH-001', 'Login ok'],
      ['TC-AUTH-002', '1. Open\n2. Tap'],
    ]);
  });

  it('reads csv with BOM, quotes and embedded newlines', async () => {
    const csv = '﻿ID,Test Case Name,Test Steps\nTC-AUTH-001,"Login, email","1. Open\n2. Tap"\n';
    expect(await readTabular(Buffer.from(csv, 'utf8'), 'cases.csv')).toEqual([
      ['ID', 'Test Case Name', 'Test Steps'],
      ['TC-AUTH-001', 'Login, email', '1. Open\n2. Tap'],
    ]);
  });

  it('rejects other file types', async () => {
    await expect(readTabular(Buffer.from('x'), 'cases.pdf')).rejects.toThrow(BadRequestException);
  });
});
