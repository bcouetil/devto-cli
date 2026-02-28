import Debug from 'debug';
import { type Article } from './models.js';

const debug = Debug('ansi');

// Default color palette (hex values)
const BASE_COLORS: Record<string, string> = {
  BLACK: '#1e1e1e',
  RED: '#ff6161',
  GREEN: '#5cf759',
  YELLOW: '#f4d03f',
  ORANGE: '#ffaf00',
  BLUE: '#5797ff',
  MAGENTA: '#8e44ad',
  CYAN: '#00bdbd',
  WHITE: '#ecf0f1',
  GRAY: '#bcbcbc'
};

// Light background colors get dark text instead of white
const LIGHT_BG = new Set(['CYAN', 'WHITE']);

type AnsiColors = Record<string, string>;

/**
 * Build default color map: 9 text + 9 bold + 8 bg (no BG_GRAY)
 */
function buildDefaultColors(): AnsiColors {
  const colors: AnsiColors = {};
  for (const [name, hex] of Object.entries(BASE_COLORS)) {
    colors[name] = hex;
    colors[`BOLD_${name}`] = hex;
    if (name !== 'GRAY') {
      colors[`BG_${name}`] = hex;
    }
  }

  return colors;
}

export const DEFAULT_ANSI_COLORS = buildDefaultColors();

/**
 * Load ANSI colors from process.env (ANSI_XXX variables), merged with defaults
 */
export function loadAnsiColors(): AnsiColors {
  const colors = { ...DEFAULT_ANSI_COLORS };

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ANSI_') && value) {
      const colorName = key.slice(5); // Remove "ANSI_" prefix
      colors[colorName] = value;
      debug('Override color %s = %s', colorName, value);
    }
  }

  return colors;
}

/**
 * Convert a tag name to a CSS style attribute value
 */
export function ansiTagToStyle(tagName: string, colors: AnsiColors): string | undefined {
  const hex = colors[tagName];
  if (!hex) {
    return undefined;
  }

  // Bold variant
  if (tagName.startsWith('BOLD_')) {
    return `color:${hex};font-weight:bold`;
  }

  // Background variant
  if (tagName.startsWith('BG_')) {
    const baseName = tagName.slice(3); // Remove "BG_"
    const isLight = LIGHT_BG.has(baseName);
    if (isLight) {
      return `background-color:${hex};color:#1e1e1e`;
    }

    return `background-color:${hex};color:white;font-weight:bold`;
  }

  // Plain text color
  return `color:${hex}`;
}

// Max visible line length in dev.to code blocks (measured from article source)
const MAX_LINE_LENGTH = 75;

/**
 * Soft-wrap a single line at MAX_LINE_LENGTH, preserving words when possible.
 * Returns the line split into multiple lines joined by \n.
 */
function softWrapLine(line: string, maxLen: number = MAX_LINE_LENGTH): string {
  if (line.length <= maxLen) {
    return line;
  }

  const lines: string[] = [];
  let remaining = line;

  while (remaining.length > maxLen) {
    // Look for a space to break at, searching backwards from maxLen
    let breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) {
      // No space found, force break at maxLen
      breakAt = maxLen;
    }

    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^ /, ''); // Remove leading space after break
  }

  if (remaining.length > 0) {
    lines.push(remaining);
  }

  return lines.join('\n');
}

/**
 * Replace {{TAG}}...{{/}} with <span style="...">...</span> inside a single ansi block.
 * {{/}} is optional: if missing, the style applies until the next {{TAG}} or end of block.
 */
function processAnsiBlockContent(content: string, colors: AnsiColors): string {
  // Match {{TAG}}...{{/}} or {{TAG}}... until next tag or end of block
  return content.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}([\s\S]*?)(?:\{\{\/\}\}|(?=\{\{[A-Z_][A-Z0-9_]*\}\})|$)/g, (_match, tag: string, text: string) => {
    const style = ansiTagToStyle(tag, colors);
    if (!style) {
      debug('Unknown ANSI tag: %s', tag);
      return text; // Unknown tag: return text without wrapping
    }

    // Soft-wrap each line within the styled span
    const wrapped = text.split('\n').map((line) => softWrapLine(line)).join('\n');
    return `<span style="${style}">${wrapped}</span>`;
  });
}

/**
 * Find ```ansi blocks in markdown content and replace them with HTML <pre><code>
 */
export function replaceAnsiBlocks(content: string, colors: AnsiColors): string {
  return content.replace(/```ansi\n([\s\S]*?)```/g, (_match, blockContent: string) => {
    const html = processAnsiBlockContent(blockContent, colors);
    // Remove trailing newline from block content if present
    const trimmed = html.endsWith('\n') ? html.slice(0, -1) : html;
    return `<pre><code>${trimmed}</code></pre>`;
  });
}

/**
 * Replace ANSI blocks in an article (in memory only)
 */
export function replaceAnsiBlocksInArticle(article: Article, colors: AnsiColors): Article {
  const updatedContent = replaceAnsiBlocks(article.content, colors);
  if (updatedContent === article.content) {
    return article;
  }

  debug('Replaced ANSI blocks in %s', article.file);
  return {
    ...article,
    content: updatedContent
  };
}
