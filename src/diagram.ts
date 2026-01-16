import path from 'node:path';
import crypto from 'node:crypto';
import Debug from 'debug';
import fs from 'fs-extra';
import got from 'got';
import pako from 'pako';
import sharp from 'sharp';
import { HttpsProxyAgent } from 'hpagent';
import { type Article } from './models.js';

const debug = Debug('diagram');

export type DiagramBlock = {
  type: 'mermaid' | 'plantuml' | 'graphviz' | 'ditaa' | 'blockdiag' | 'svgbob';
  content: string;
  name: string;
  originalText: string;
  imagePath?: string;
};

const KROKI_URL = 'https://kroki.io';
const SUPPORTED_DIAGRAM_TYPES = ['mermaid', 'plantuml', 'graphviz', 'ditaa', 'blockdiag', 'svgbob'];

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
    const codeBlockMatch = lines[i].match(/^```(\w+)/);
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

        diagrams.push({
          type: type as DiagramBlock['type'],
          content: diagramContent,
          name: diagramName,
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

  try {
    // Normalize line endings to LF (Unix style) for Kroki
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
      debug('Warning: Diagram image not found: %s', imagePath);
      debug('Run "dev diaggen" first to generate diagram images');
    }
  }

  if (diagramMap.size === 0) {
    return article;
  }

  const updatedContent = replaceDiagramsWithImages(article.content, diagramMap, article.file!);

  return {
    ...article,
    content: updatedContent
  };
}
