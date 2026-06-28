import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_ASSETS_DIR = path.join(__dirname, '..', 'assets', 'chart');

/** Default font scale tuned for dev.to (images served at max width 800px). */
const DEFAULT_FONT_SCALE = 1.6;

/** C3 clips axis titles inside .c3-axis-* groups — unclip, raise, then fit the SVG viewBox. */
const CHART_ONRENDERED = `
, onrendered: function() {
  var svg = d3.select('#chart svg');
  svg.selectAll('.c3-axis-x, .c3-axis-y').attr('clip-path', null);
  svg.selectAll('.c3-axis-x-label, .c3-axis-y-label').raise();

  var yTicks = svg.selectAll('.c3-axis-y .tick').nodes();
  if (yTicks.length > 1) {
    d3.select(yTicks[yTicks.length - 1]).select('text').text('');
  }

  var xLabel = svg.select('.c3-axis-x-label');
  if (!xLabel.empty()) {
    xLabel.attr('transform', 'translate(0,-8)');
  }

  var xLabelEl = xLabel.node();
  var legendItems = svg.selectAll('.c3-legend-item').nodes();
  if (xLabelEl && legendItems.length) {
    var xBottom = xLabelEl.getBoundingClientRect().bottom;
    var legendTop = Math.min.apply(null, legendItems.map(function(n) {
      return n.getBoundingClientRect().top;
    }));
    var shift = xBottom + 4 - legendTop;
    if (shift > 0) {
      legendItems.forEach(function(node) {
        var sel = d3.select(node);
        var t = sel.attr('transform') || '';
        var m = t.match(/translate\\(([-\\d.]+)[, ]+([-\\d.]+)\\)/);
        var dx = m ? +m[1] : 0;
        var dy = m ? +m[2] : 0;
        sel.attr('transform', 'translate(' + dx + ',' + (dy + shift) + ')');
      });
    }
  }

  var bbox = svg.node().getBBox();
  var pad = 12;
  svg
    .attr('viewBox', [bbox.x - pad, bbox.y - pad, bbox.width + pad * 2, bbox.height + pad * 2].join(' '))
    .attr('width', bbox.width + pad * 2)
    .attr('height', bbox.height + pad * 2);
}`;

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

function resolveFontScale(raw: string | undefined): number {
  const scale = Number.parseFloat(raw ?? String(DEFAULT_FONT_SCALE));
  return Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_FONT_SCALE;
}

function jsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function dataMinValue(columns: Array<Array<string | number>>, xType: string): number {
  const startCol = xType === 'category' ? 1 : 0;
  let min = Infinity;
  for (const row of columns) {
    for (let i = startCol; i < row.length; i++) {
      const v = row[i];
      if (typeof v === 'number') {
        min = Math.min(min, v);
      }
    }
  }

  return min === Infinity ? 0 : min;
}

function buildXLabelJs(label: string | undefined): string {
  if (!label) {
    return 'undefined';
  }

  return `{ text: ${jsString(label)}, position: 'outer-right' }`;
}

function buildYAxisJs(a: ChartAttrs, columns: Array<Array<string | number>>, xType: string): string {
  const [rawMin, rawMax] = (a['y-range'] || 'undefined_undefined').split('_');
  const dataMin = dataMinValue(columns, xType);
  const min = rawMin !== 'undefined' ? rawMin : dataMin >= 0 ? '0' : 'undefined';
  const max = rawMax !== 'undefined' ? rawMax : 'undefined';
  const zeroBaseline = min === '0';
  const padding = zeroBaseline ? ', padding: { bottom: 0 }' : '';

  return `min: ${min}, max: ${max}${padding}`;
}

function buildFontStyles(fontScale: number): string {
  const base = Math.round(10 * fontScale);
  const legend = Math.round(12 * fontScale);
  const dataLabel = Math.round(12 * fontScale);

  return `
.c3 svg { font: ${base}px sans-serif; overflow: visible; }
.c3-legend-item, .c3-axis-x-label, .c3-axis-y-label { font-size: ${legend}px; }
.c3-axis-x-label, .c3-axis-y-label { font-style: italic; }
.c3-chart-text { font-size: ${dataLabel}px; font-weight: 600; }
.c3-chart-text .c3-text { fill: #333; }`;
}

function scaledHeight(baseHeight: number, fontScale: number, seriesCount: number): number {
  const legendRows = Math.max(1, Math.ceil(seriesCount / 4));
  const fontBonus = baseHeight * (fontScale - 1) * 0.1;
  const legendBonus = Math.max(0, legendRows - 1) * 12 * fontScale;

  return Math.round(baseHeight + fontBonus + legendBonus);
}

function resolveChartSize(
  a: ChartAttrs,
  columns: Array<Array<string | number>>
): { width: number; height: number } {
  const xType = a['x-type'] || 'indexed';
  const fontScale = resolveFontScale(a['font-scale']);
  const seriesCount = Math.max(0, columns.length - (xType === 'category' ? 1 : 0));

  return {
    width: Number.parseInt(a.width || '1000', 10),
    height: scaledHeight(Number.parseInt(a.height || '500', 10), fontScale, seriesCount)
  };
}

/**
 * Build a self-contained HTML page that renders a C3.js chart.
 */
export function buildChartHTML(attrsStr: string, csvContent: string): string {
  const a = parseChartAttrs(attrsStr);
  const columns = parseCSV(csvContent);

  const type = a.type || 'bar';
  const horizontal = a.horizontal || 'false';
  const xType = a['x-type'] || 'indexed';
  const xTickAngle = a['x-tick-angle'] || '0';
  const xLabel = buildXLabelJs(a['x-label']);
  const yLabel = a['y-label'] ? jsString(a['y-label']) : 'undefined';
  const dataLabels = a['data-labels'] || 'false';
  const rawOrder = a.order;
  const order = rawOrder === undefined ? "'desc'" : rawOrder === 'null' ? 'null' : `'${rawOrder}'`;
  const yAxis = buildYAxisJs(a, columns, xType);
  const legend = a.legend || 'bottom';
  const fontScale = resolveFontScale(a['font-scale']);
  const { width, height } = resolveChartSize(a, columns);
  const fontStyles = buildFontStyles(fontScale);

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
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:white; }
${fontStyles}
</style>
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
    y: { ${yAxis}, label: ${yLabel} }
  },
  legend: { position: '${legend}' },
  color: {
    pattern: ['#8DBF44','#555555','#53A3DA','#D6D6B1','#D61F50','#888888','#FFE119','#000075','#E8575C','#56A29A']
  }
${CHART_ONRENDERED}
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
  const columns = parseCSV(csvContent);
  const { width, height } = resolveChartSize(a, columns);

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
    await page.setViewport({ width: width + 50, height: height + 100, deviceScaleFactor: 2 });
    await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#chart svg', { timeout: 5000 });
    const el = await page.$('#chart svg');
    if (!el) {
      throw new Error('Chart SVG not found');
    }

    await el.screenshot({ path: outputPath });
  } finally {
    await browser.close();
    await fs.remove(tmpFile);
  }
}
