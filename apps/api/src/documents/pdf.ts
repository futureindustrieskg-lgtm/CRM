/** Сборка PDF-документов (pdfkit) с кириллическим шрифтом DejaVu Sans (свободная лицензия). */
import PDFDocument from 'pdfkit';

const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const FONT_SERIF_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf');

export type Doc = PDFKit.PDFDocument;

export function createDoc(opts: { landscape?: boolean; title: string }): Doc {
  const doc = new PDFDocument({
    size: 'A4',
    layout: opts.landscape ? 'landscape' : 'portrait',
    margins: { top: 50, bottom: 50, left: 56, right: 50 },
    info: { Title: opts.title, Producer: 'Deutschzentrum CRM' },
    bufferPages: true,
  });
  doc.registerFont('R', FONT);
  doc.registerFont('B', FONT_BOLD);
  doc.registerFont('SB', FONT_SERIF_BOLD);
  doc.font('R').fontSize(10);
  return doc;
}

/** Готовый PDF в Buffer. */
export function finish(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export const width = (doc: Doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

export function title(doc: Doc, text: string, sub?: string) {
  doc.moveDown(0.5).font('B').fontSize(14).text(text, { align: 'center' });
  if (sub) doc.font('R').fontSize(10).text(sub, { align: 'center' });
  doc.moveDown(0.8).font('R').fontSize(10);
}

export function heading(doc: Doc, text: string) {
  doc.moveDown(0.4).font('B').fontSize(10.5).text(text).moveDown(0.2).font('R').fontSize(10);
}

export function para(doc: Doc, text: string, opts: PDFKit.Mixins.TextOptions = {}) {
  doc.font('R').fontSize(10).text(text, { align: 'justify', lineGap: 1.5, ...opts });
  doc.moveDown(0.3);
}

/** Строка «слева — справа» (город и дата). */
export function leftRight(doc: Doc, left: string, right: string) {
  const y = doc.y;
  const w = width(doc);
  doc.text(left, doc.page.margins.left, y, { width: w / 2 });
  doc.text(right, doc.page.margins.left + w / 2, y, { width: w / 2, align: 'right' });
  doc.x = doc.page.margins.left;
  doc.moveDown(0.6);
}

/** Таблица с рамками; ширины колонок — доли от ширины страницы. */
export function table(doc: Doc, cols: { title: string; w: number; align?: 'left' | 'right' | 'center' }[], rows: string[][], opts: { bold?: boolean } = {}) {
  const x0 = doc.page.margins.left;
  const W = width(doc);
  const widths = cols.map((c) => c.w * W);
  const pad = 4;
  const drawRow = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'B' : 'R').fontSize(9);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c ?? '', { width: widths[i] - pad * 2 }))) + pad * 2;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    let x = x0;
    cells.forEach((c, i) => {
      doc.rect(x, y, widths[i], h).stroke('#999');
      doc.fillColor('#000').text(c ?? '', x + pad, y + pad, { width: widths[i] - pad * 2, align: cols[i].align ?? 'left' });
      x += widths[i];
    });
    doc.x = x0;
    doc.y = y + h;
  };
  drawRow(cols.map((c) => c.title), true);
  rows.forEach((r) => drawRow(r, !!opts.bold));
  doc.moveDown(0.6).font('R').fontSize(10);
}

/** Две колонки: реквизиты и подписи сторон. */
export function twoColumns(doc: Doc, left: { title: string; lines: string[]; sign?: string }, right: { title: string; lines: string[]; sign?: string }) {
  const x0 = doc.page.margins.left;
  const W = width(doc);
  const colW = W / 2 - 10;
  if (doc.y > doc.page.height - 230) doc.addPage();
  const y0 = doc.y;
  const col = (c: typeof left, x: number) => {
    doc.font('B').fontSize(10).text(c.title, x, y0, { width: colW });
    doc.font('R').fontSize(9);
    for (const l of c.lines) doc.text(l, x, doc.y, { width: colW });
    if (c.sign) {
      doc.moveDown(1.5);
      doc.text(`_________________ / ${c.sign} /`, x, doc.y, { width: colW });
      doc.fontSize(8).fillColor('#666').text('подпись', x + 30, doc.y, { width: colW }).fillColor('#000');
    }
    return doc.y;
  };
  const yl = col(left, x0);
  const yr = col(right, x0 + W / 2 + 10);
  doc.x = x0;
  doc.y = Math.max(yl, yr) + 10;
  doc.font('R').fontSize(10);
}

/** Нумерация страниц и пометка внизу каждой страницы. */
export function footer(doc: Doc, text: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Колонтитул ниже поля страницы: временно снимаем нижнее поле, иначе pdfkit добавит новую страницу.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - bottom + 18;
    doc.font('R').fontSize(7.5).fillColor('#888');
    doc.text(`${text} · стр. ${i + 1} из ${range.count}`, doc.page.margins.left, y, { width: width(doc), align: 'center', lineBreak: false });
    doc.fillColor('#000');
    doc.page.margins.bottom = bottom;
  }
}
