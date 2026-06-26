import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_ASSETS_DIR = path.join(__dirname, '..', 'assets', 'chart');

export type ParsedChartBlock = {
  attrsStr: string;
  csvContent: string;
};

export type ChartAttrs = Record<string, string> & { type: string };

/**
 * Split a ```chart block body into attribute line and CSV body.
 */
export function parseChartBlock(content: string): ParsedChartBlock {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const newline = normalized.indexOf('\n');
  if (newline === -1) {
    return { attrsStr: normalized, csvContent: '' };
  }
  return {
    attrsStr: normalized.slice(0, newline).trim(),
    csvContent: normalized.slice(newline + 1).trim()
  };
}

export function parseChartAttrs(attrsStr: string): ChartAttrs {
  const parts = attrsStr.split(',');
  const result: ChartAttrs = { type: parts[0].trim() };
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq >= 0) {
      const key = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      result[key] = value;
    }
  }
  return result;
}

function parseCSV(csvContent: string): Array<Array<string | number>> {
  return csvContent
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map((line) =>
      line.split(',').map((cell) => {
        const t = cell.trim();
        const n = Number(t);
        return t !== '' && !Number.isNaN(n) ? n : t;
      })
    );
}

function toFileUrl(p: string): string {
  return `file://${p.replace(/\\/g, '/')}`;
}

/**
 * Build a self-contained HTML page that renders a C3.js chart.
 */
export function buildChartHTML(attrsStr: string, csvContent: string): string {
  const a = parseChartAttrs(attrsStr);
  const columns = parseCSV(csvContent);

  const type = a.type || 'bar';
  const height = a.height || '500';
  const width = a.width || '1000';
  const horizontal = a.horizontal || 'false';
  const xType = a['x-type'] || 'indexed';
  const xTickAngle = a['x-tick-angle'] || '0';
  const xLabel = a['x-label'] ? `'${a['x-label']}'` : 'undefined';
  const yLabel = a['y-label'] ? `'${a['y-label']}'` : 'undefined';
  const dataLabels = a['data-labels'] || 'false';
  const rawOrder = a.order;
  const order = rawOrder === undefined ? "'desc'" : rawOrder === 'null' ? 'null' : `'${rawOrder}'`;
  const yRange = (a['y-range'] || 'undefined_undefined').split('_');
  const legend = a.legend || 'bottom';

  const xData = xType === 'category' ? "x: 'x'," : '';

  let groupsLine = '';
  if (a.stacked === 'true') {
    const names = columns.slice(1).map((r) => `'${r[0]}'`).join(', ');
    groupsLine = `,\n          groups: [[${names}]]`;
  }

  const d3Url = toFileUrl(path.join(CHART_ASSETS_DIR, 'd3.v5-7-0.min.js'));
  const c3JsUrl = toFileUrl(path.join(CHART_ASSETS_DIR, 'c3.v0-6-11.min.js'));
  const c3CssUrl = toFileUrl(path.join(CHART_ASSETS_DIR, 'c3.v0-6-11.min.css'));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${c3CssUrl}">
<script src="${d3Url}"></script>
<script src="${c3JsUrl}"></script>
<style>* { margin:0; padding:0; box-sizing:border-box; } body { background:white; }</style>
</head><body>
<div id="chart"></div>
<script>
c3.generate({
  bindto: '#chart',
  size: { height: ${height}, width: ${width} },
  data: {
    ${xData}
    columns: ${JSON.stringify(columns)},
    type: '${type}',
    labels: ${dataLabels},
    order: ${order}${groupsLine}
  },
  axis: {
    rotated: ${horizontal},
    x: {
      type: '${xType}',
      tick: { rotate: ${xTickAngle}, multiline: false },
      label: ${xLabel}
    },
    y: { min: ${yRange[0]}, max: ${yRange[1]}, label: ${yLabel} }
  },
  legend: { position: '${legend}' },
  color: {
    pattern: ['#8DBF44','#555555','#53A3DA','#D6D6B1','#D61F50','#888888','#FFE119','#000075','#E8575C','#56A29A']
  }
});
</script>
</body></html>`;
}

/**
 * Render a ```chart block body to a PNG file using Puppeteer + C3.js.
 */
export async function renderChartPNG(content: string, outputPath: string): Promise<void> {
  const { attrsStr, csvContent } = parseChartBlock(content);
  const a = parseChartAttrs(attrsStr);
  const w = Number.parseInt(a.width || '1000', 10);
  const h = Number.parseInt(a.height || '500', 10);

  const html = buildChartHTML(attrsStr, csvContent);
  const tmpFile = path.join(os.tmpdir(), `chart-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.html`);
  await fs.writeFile(tmpFile, html, 'utf8');

  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w + 50, height: h + 100 });
    await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#chart svg', { timeout: 5000 });
    const el = await page.$('#chart');
    if (!el) {
      throw new Error('Chart element not found');
    }
    await el.screenshot({ path: outputPath });
  } finally {
    await browser.close();
    await fs.remove(tmpFile);
  }
}
