import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Debug from 'debug';
import fs from 'fs-extra';
import got from 'got';
import pako from 'pako';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { HttpsProxyAgent } from 'hpagent';
import { type Article } from './models.js';

const debug = Debug('diagram');

export type DiagramBlock = {
  type: 'mermaid' | 'plantuml' | 'graphviz' | 'ditaa' | 'blockdiag' | 'svgbob' | 'gitlab-ci';
  content: string;
  name: string;
  originalText: string;
  imagePath?: string;
};

const KROKI_URL = 'https://kroki.io';
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';
const SUPPORTED_DIAGRAM_TYPES = ['mermaid', 'plantuml', 'graphviz', 'ditaa', 'blockdiag', 'svgbob', 'gitlab-ci'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITLAB_CI_ICONS_DIR = path.join(__dirname, '..', 'assets', 'icons');

// Configure proxy for corporate environments
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent({
  proxy: proxyUrl,
  rejectUnauthorized: false // For corporate proxies with self-signed certificates
}) : undefined;

/**
 * Add a white background to a PNG image with transparency
 */
async function addWhiteBackground(pngBuffer: Buffer): Promise<Buffer> {
  try {
    const image = sharp(pngBuffer);
    const metadata = await image.metadata();
    const { width = 100, height = 100 } = metadata;

    // Create white background and composite the image on top
    return await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite([{ input: pngBuffer }])
      .png()
      .toBuffer();
  } catch (error) {
    debug('Failed to add white background, using original image: %s', error);
    return pngBuffer;
  }
}

/**
 * Calculate a checksum (short hash) of the diagram content
 */
export function calculateChecksum(content: string): string {
  // Normalize line endings to ensure consistent checksums across platforms
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 7);
}

/**
 * Convert gitlab-ci CSV pipeline definition to Graphviz DOT format
 */
function gitlabCiToDot(csvContent: string): string {
  const lines = csvContent.replace(/\r\n?/g, '\n').trim().split('\n').filter(l => l.trim());
  const header = lines[0].split(';').map(h => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iName = col('name'), iStage = col('stage'), iWhen = col('when');
  const iAllow = col('allowFailure'), iNeeds = col('needs');

  const jobs = lines.slice(1).map(line => {
    const parts = line.split(';');
    const needsRaw = parts[iNeeds] || '';
    const needs = needsRaw.replace(/^\[|\]$/g, '').split(',').map(n => n.trim()).filter(Boolean);
    return { name: parts[iName], stage: parts[iStage], when: parts[iWhen], allowFailure: parts[iAllow], needs };
  });

  const stages: string[] = [];
  const byStage: Record<string, typeof jobs> = {};
  for (const job of jobs) {
    if (!stages.includes(job.stage)) {
      stages.push(job.stage);
      byStage[job.stage] = [];
    }
    byStage[job.stage].push(job);
  }

  const ICON_W = 25;
  const ICON_H = 25;
  const ROW_H = 35;    // row height: icon (25) + ~5px padding top/bottom
  const CHAR_W = 5.3;  // approximate character width (Arial 11pt in graphviz pts)
  const CELL_PAD = 4;
  const RIGHT_MARGIN = 12; // breathing room before the right border
  const MIN_WIDTH = 128;
  const MAX_WIDTH = 200;
  const MAX_TEXT_W = MAX_WIDTH - ICON_W;

  function icon(when: string, allowFailure: string): string {
    if (when === 'manual') return 'manual.png';
    if (allowFailure.toLowerCase() === 'true' || allowFailure.startsWith('[')) return 'warning.png';
    return 'success.png';
  }

  // Sanitize job name for use as a Graphviz port identifier
  function pid(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  // Word-aware wrap: break at spaces (before), [  (before), hyphens/underscores/commas (after)
  function wrapName(name: string, maxChars: number): string {
    if (name.length <= maxChars) return name;
    const parts: string[] = [];
    let remaining = name;
    while (remaining.length > maxChars) {
      let breakAt = -1;
      for (let k = maxChars; k > 0; k--) {
        if (remaining[k] === ' ' || remaining[k] === '[' ||
          remaining[k - 1] === '-' || remaining[k - 1] === '_' || remaining[k - 1] === ',') {
          breakAt = k;
          break;
        }
      }
      if (breakAt <= 0) breakAt = maxChars;
      parts.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).replace(/^ /, '');
    }
    if (remaining) parts.push(remaining);
    // Trailing <BR ALIGN="LEFT"/> ensures the last line is also left-aligned
    return parts.join('<BR ALIGN="LEFT"/>') + '<BR ALIGN="LEFT"/>';
  }

  const nodes = stages.map((stage) => {
    const stageId = pid(stage); // safe DOT identifier (no emoji, no spaces)
    const stageJobs = byStage[stage];

    // Each stage adapts its own width to its longest job name
    const maxNameLen = Math.max(...stageJobs.map(j => j.name.length));
    const desiredW = Math.ceil(maxNameLen * CHAR_W) + CELL_PAD * 2 + RIGHT_MARGIN + ICON_W;
    // WIDTH is clamped between MIN and MAX; TEXT_W is always WIDTH - ICON_W so rows fill exactly
    const WIDTH = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, desiredW));
    const TEXT_W = WIDTH - ICON_W;
    const MAX_CHARS = Math.floor((TEXT_W - CELL_PAD * 2) / CHAR_W);

    const rows = stageJobs.map(j =>
      `          <TR><TD FIXEDSIZE="TRUE" WIDTH="${ICON_W}" HEIGHT="${ROW_H}" PORT="${pid(j.name)}_in"><IMG SRC="${icon(j.when, j.allowFailure)}" SCALE="TRUE"/></TD><TD ALIGN="LEFT" WIDTH="${TEXT_W}" HEIGHT="${ROW_H}" VALIGN="MIDDLE" PORT="${pid(j.name)}_out">${wrapName(j.name, MAX_CHARS)}</TD></TR>`
    ).join('\n');

    // Outer gray rounded container (stage background) + inner white rounded card (job list)
    return `  ${stageId} [label=<
    <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" BGCOLOR="#e9ecef" STYLE="rounded">
      <TR><TD PORT="hdr" ALIGN="LEFT" CELLPADDING="8"><B>${stage}</B></TD></TR>
      <TR><TD CELLPADDING="5">
        <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="${CELL_PAD}" BGCOLOR="white" STYLE="rounded">
${rows}
        </TABLE>
      </TD></TR>
    </TABLE>>]`;
  });

  const stageEdges = stages.slice(0, -1).map((s, i) => `  ${pid(s)}:hdr:e -> ${pid(stages[i + 1])}:hdr:w`).join('\n');

  const jobByName = new Map(jobs.map(j => [j.name, j]));
  const needsEdges: string[] = [];
  for (const job of jobs) {
    const stageIdx = stages.indexOf(job.stage);
    for (const needName of job.needs) {
      const needed = jobByName.get(needName);
      if (!needed) continue;
      const neededStageIdx = stages.indexOf(needed.stage);
      if (stageIdx - neededStageIdx !== 1) continue;
      needsEdges.push(`  ${pid(needed.stage)}:${pid(needed.name)}_out:e -> ${pid(job.stage)}:${pid(job.name)}_in:w [color="#bbbbbb" penwidth=1.5 constraint=false]`);
    }
  }

  const splines = needsEdges.length > 0 ? ' splines=false' : '';
  return `digraph {
  rankdir=LR ranksep=0.3${splines}
  node [shape=none margin=0 fontname="Helvetica Neue" fontsize=11]
  edge [dir=none color="#bbbbbb" penwidth=1.5]

${nodes.join('\n\n')}

${stageEdges}${needsEdges.length > 0 ? '\n' + needsEdges.join('\n') : ''}
}`;
}

/**
 * Generate a PNG from a gitlab-ci pipeline definition using local dot binary
 */
async function generateGitlabCiImage(diagram: DiagramBlock, outputPath: string): Promise<void> {
  // Check that dot is available in PATH
  if (spawnSync(WHICH_CMD, ['dot'], { env: process.env }).status !== 0) {
    const hint = process.platform === 'win32'
      ? `  PowerShell: $env:PATH += ";C:/path/to/tool-dir"\n  CMD:        set PATH=%PATH%;C:/path/to/tool-dir`
      : `  export PATH="/path/to/tool-dir:$PATH"`;
    throw new Error(
      `Missing tool in PATH — required for gitlab-ci diagram rendering:\n` +
      `  - Graphviz (dot) — install Graphviz and add its bin/ directory to your PATH\n` +
      `Add it temporarily:\n${hint}`
    );
  }

  const dotSource = gitlabCiToDot(diagram.content);
  debug('Generated DOT from gitlab-ci:\n%s', dotSource);

  // Convert SVG icons to PNG in a temp dir (dot only supports raster images)
  const tmpIconsDir = path.join(os.tmpdir(), `gitlab-ci-icons-${Date.now()}`);
  await fs.ensureDir(tmpIconsDir);
  for (const name of ['success', 'failed', 'warning', 'manual']) {
    const svgData = await fs.readFile(path.join(GITLAB_CI_ICONS_DIR, `${name}.svg`));
    await sharp(svgData).resize(64, 64).png().toFile(path.join(tmpIconsDir, `${name}.png`));
  }

  const tmpDot = path.join(os.tmpdir(), `gitlab-ci-${Date.now()}.dot`);
  const tmpSvg = path.join(os.tmpdir(), `gitlab-ci-${Date.now()}.svg`);
  await fs.writeFile(tmpDot, dotSource);

  const result = spawnSync('dot', ['-Tsvg', `-Gimagepath=${tmpIconsDir}`, tmpDot, '-o', tmpSvg], {
    env: process.env
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || result.error?.message || 'unknown error';
    throw new Error(`dot failed (exit ${result.status}): ${stderr}`);
  }

  // Inline PNG icons as base64 data URIs so the SVG is self-contained for Chrome
  let svg = await fs.readFile(tmpSvg, 'utf8');
  svg = svg.replace(/xlink:href="([^"]+\.png)"/g, (_match: string, href: string) => {
    const iconPath = path.isAbsolute(href) ? href : path.join(tmpIconsDir, path.basename(href));
    if (fs.existsSync(iconPath)) {
      const data = fs.readFileSync(iconPath);
      return `xlink:href="data:image/png;base64,${data.toString('base64')}"`;
    }
    return _match;
  });

  // Extract SVG viewport dimensions (in pt) and convert to px for Chrome window size.
  // Use 2x height to avoid content being cut when dot underestimates the required height.
  const svgDims = svg.match(/<svg[^>]*width="([\d.]+)pt"[^>]*height="([\d.]+)pt"/);
  const ptToPx = (pt: number) => Math.round(pt * 4 / 3);
  const svgW = svgDims ? ptToPx(parseFloat(svgDims[1])) : 1200;
  const svgH = svgDims ? ptToPx(parseFloat(svgDims[2])) : 800;

  // Use puppeteer to render SVG → PNG with proper emoji color support
  const tmpHtml = path.join(os.tmpdir(), `gitlab-ci-render-${Date.now()}.html`);
  await fs.writeFile(tmpSvg, svg);
  await fs.writeFile(tmpHtml, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; }
html, body { width: ${svgW}px; background: white; }
img { width: ${svgW}px; height: auto; display: block; }
</style></head><body><img src="file:///${tmpSvg.replace(/\\/g, '/')}"></body></html>`);

  const tmpPng = path.resolve(outputPath + '.tmp.png');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: svgW, height: svgH * 2 });
    await page.goto(`file:///${tmpHtml.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: tmpPng, fullPage: true });
  } finally {
    await browser.close();
  }

  // Trim white borders left by graphviz's SVG padding
  await sharp(tmpPng)
    .trim({ background: '#ffffff', threshold: 10 })
    .toFile(outputPath);
  await fs.remove(tmpPng);

  await fs.remove(tmpDot);
  await fs.remove(tmpSvg);
  await fs.remove(tmpHtml);
  await fs.remove(tmpIconsDir);
  debug('Generated gitlab-ci diagram image: %s', outputPath);
}

/**
 * Extract all diagram blocks from markdown content
 */
export function extractDiagrams(content: string): DiagramBlock[] {
  const diagrams: DiagramBlock[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Look for diagram name comment
    const nameMatch = line.match(/<!--\s*diagram-name:\s*(.+?)\s*-->/);
    let diagramName = 'unknown';

    if (nameMatch) {
      diagramName = nameMatch[1].trim();
      i++;
      if (i >= lines.length) break;
    }

    // Look for code block with diagram type
    const codeBlockMatch = lines[i].match(/^```([\w-]+)/);
    if (codeBlockMatch) {
      const type = codeBlockMatch[1].toLowerCase();

      if (SUPPORTED_DIAGRAM_TYPES.includes(type)) {
        const startLine = i;
        i++;

        // Collect diagram content until closing ```
        const diagramLines: string[] = [];
        while (i < lines.length && !lines[i].startsWith('```')) {
          diagramLines.push(lines[i]);
          i++;
        }

        const diagramContent = diagramLines.join('\n');

        // Build original text (including name comment if present)
        let originalText = '';
        if (nameMatch) {
          originalText = lines[startLine - 1] + '\n';
        }
        originalText += lines[startLine] + '\n' + diagramContent + '\n```';

        // gitlab-ci blocks default to 'pipeline' when no diagram-name is provided
        const effectiveName = (!nameMatch && type === 'gitlab-ci') ? 'pipeline' : diagramName;

        diagrams.push({
          type: type as DiagramBlock['type'],
          content: diagramContent,
          name: effectiveName,
          originalText
        });

        debug('Found %s diagram: %s', type, diagramName);
      }
    }

    i++;
  }

  return diagrams;
}

/**
 * Generate diagram image using Kroki.io
 */
export async function generateDiagramImage(
  diagram: DiagramBlock,
  outputDir: string
): Promise<string> {
  const checksum = calculateChecksum(diagram.content);
  const filename = `${diagram.name}-${checksum}.png`;
  const outputPath = path.join(outputDir, filename);

  // Check if image already exists
  if (await fs.pathExists(outputPath)) {
    debug('Image already exists: %s', outputPath);
    return outputPath;
  }

  await fs.ensureDir(outputDir);

  // gitlab-ci: local rendering via dot binary
  if (diagram.type === 'gitlab-ci') {
    await generateGitlabCiImage(diagram, outputPath);
    return outputPath;
  }

  try {
    const normalizedContent = diagram.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Use POST method to avoid URL length limits
    const url = `${KROKI_URL}/${diagram.type}/png`;
    debug('Requesting diagram from Kroki (POST): %s', url);
    debug('Diagram content length: %d bytes', normalizedContent.length);

    const requestOptions: any = {
      method: 'POST',
      body: normalizedContent,
      headers: {
        'Content-Type': 'text/plain'
      },
      responseType: 'buffer',
      timeout: {
        request: 30000
      },
      retry: {
        limit: 2
      },
      https: {
        rejectUnauthorized: false // For corporate proxies with self-signed certificates
      }
    };

    if (proxyAgent) {
      requestOptions.agent = { https: proxyAgent };
    }

    const response = await got(url, requestOptions);

    // Post-process: add white background to PNG
    const imageBuffer = await addWhiteBackground(response.body as any);

    // Save image
    await fs.ensureDir(outputDir);
    await fs.writeFile(outputPath, imageBuffer as any);

    debug('Generated diagram image: %s', outputPath);
    return outputPath;
  } catch (error: any) {
    // Provide helpful hint for EACCES errors (typically proxy issues)
    if (error?.code === 'EACCES') {
      console.error('\n⚠️  Access denied (EACCES) when connecting to Kroki.io');
      console.error('💡 If you are behind a corporate proxy, make sure HTTPS_PROXY is set:');
      console.error('   PowerShell: $env:HTTPS_PROXY = "http://proxy.example.com:3131"');
      console.error('   Bash/Zsh:   export HTTPS_PROXY="http://proxy.example.com:3131"\n');
    }

    const errorMessage = error?.response?.statusCode
      ? `HTTP ${error.response.statusCode}: ${error.response.statusMessage || 'Unknown error'}`
      : error?.message || String(error);
    debug('Full error details: %O', error);
    throw new Error(`Failed to generate diagram image for "${diagram.name}": ${errorMessage}`);
  }
}

/**
 * Generate all diagram images for an article
 */
export async function generateDiagramsForArticle(
  article: Article
): Promise<Map<string, string>> {
  const diagrams = extractDiagrams(article.content);

  if (diagrams.length === 0) {
    debug('No diagrams found in article: %s', article.file);
    return new Map();
  }

  const articleDir = article.file ? path.dirname(article.file) : '.';
  const outputDir = path.join(articleDir, 'images', 'diagrams');

  const diagramMap = new Map<string, string>();

  for (const diagram of diagrams) {
    try {
      const imagePath = await generateDiagramImage(diagram, outputDir);
      diagramMap.set(diagram.originalText, imagePath);
    } catch (error) {
      debug('Error generating diagram: %s', error);
      throw error;
    }
  }

  debug('Generated %d diagram(s) for article: %s', diagrams.length, article.file);
  return diagramMap;
}

/**
 * Replace diagram blocks with image links in markdown content
 */
export function replaceDiagramsWithImages(
  content: string,
  diagramMap: Map<string, string>,
  articleFile: string
): string {
  let updatedContent = content;
  const articleDir = path.dirname(articleFile);

  for (const [originalText, imagePath] of diagramMap.entries()) {
    // Calculate relative path from article to image
    const relativePath = path.relative(articleDir, imagePath).replace(/\\/g, '/');

    // Replace diagram block with image markdown
    const imageMarkdown = `![Diagram](${relativePath})`;
    updatedContent = updatedContent.replace(originalText, imageMarkdown);
  }

  return updatedContent;
}

/**
 * Replace diagrams with images in an article
 */
export async function replaceDiagramsInArticle(article: Article): Promise<Article> {
  const diagrams = extractDiagrams(article.content);

  if (diagrams.length === 0) {
    return article;
  }

  const articleDir = article.file ? path.dirname(article.file) : '.';
  const diagramsDir = path.join(articleDir, 'images', 'diagrams');

  // Build map of original text to image paths
  const diagramMap = new Map<string, string>();

  for (const diagram of diagrams) {
    const checksum = calculateChecksum(diagram.content);
    const filename = `${diagram.name}-${checksum}.png`;
    const imagePath = path.join(diagramsDir, filename);

    // Check if the image exists
    if (await fs.pathExists(imagePath)) {
      diagramMap.set(diagram.originalText, imagePath);
    } else {
      throw new Error(
        `Diagram image not found: ${imagePath}\n` +
        `Run "dev diaggen" first to generate diagram images, then commit and push to GitHub.`
      );
    }
  }

  const updatedContent = replaceDiagramsWithImages(article.content, diagramMap, article.file!);

  return {
    ...article,
    content: updatedContent
  };
}
