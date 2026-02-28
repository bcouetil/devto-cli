/**
 * Table of Contents (TOC) generator for dev.to
 * Based on bitdowntoc algorithm: https://github.com/derlin/bitdowntoc
 *
 * This implements the dev.to anchor generation algorithm as documented in:
 * https://github.com/forem/forem/blob/main/app/lib/redcarpet/render/html_rouge.rb
 */

import Debug from 'debug';

const debug = Debug('toc');

// TOC markers - using HTML comment style
const TOC_START = '<!-- TOC start -->';
const TOC_END = '<!-- TOC end -->';
const TOC_PLACEHOLDER = '[TOC]';

// Regex patterns
const HEADER_REGEX = /^(#{1,6}) +(.+)$/;
const CODE_BLOCK_REGEX = /^(\s*(?:\d+\.)?[*+-]?\s*)(`{3,}|~{3,})/;
const HTML_COMMENT_START_REGEX = /<!--/;
const HTML_COMMENT_END_REGEX = /-->/;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_TAGS_REGEX = /<[^>]*>/g;
const INLINE_CODE_REGEX = /`([^`]*)`/g;
const SPACES_REGEX = /\s+/g;

// Punctuation regex matching Ruby's [[:punct:]] class (used by dev.to)
// This includes: !"#$%&'()*+,./:;<=>?@[\]^_`{|}~՚Ꞌ′″‴〃-
const PUNCTUATION_REGEX = /[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~՚Ꞌ′″‴〃-]/gu;

// Common emojis that dev.to removes (simplified subset - the full list is huge)
// Dev.to removes RGI emojis using EmojiRegex::RGIEmoji
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

interface TocEntry {
  indent: number;
  title: string;
  link: string;
}

interface TocOptions {
  indentChars?: string;
  indentSpaces?: number;
  maxLevel?: number;
  trimTocIndent?: boolean;
  concatSpaces?: boolean;
}

const defaultOptions: Required<TocOptions> = {
  indentChars: '-*+',
  indentSpaces: 3,
  maxLevel: 2,
  trimTocIndent: true,
  concatSpaces: true, // dev.to concatenates multiple spaces/dashes
};

/**
 * Escape HTML entities (dev.to does this BEFORE stripping punctuation)
 */
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, 'amp')
    .replace(/</g, 'lt')
    .replace(/>/g, 'gt');
}

/**
 * Transform text inside inline code blocks
 */
function transformInlineCode(text: string, transform: (code: string) => string): string {
  return text.replace(INLINE_CODE_REGEX, (_, code) => `\`${transform(code)}\``);
}

/**
 * Replace backticks with raw/endraw markers (dev.to specific)
 */
function replaceBackticksWithRawMarker(text: string): string {
  let counter = 0;
  return text.split('').map(char => {
    if (char === '`') {
      return counter++ % 2 === 0 ? ' raw ' : ' endraw ';
    }
    return char;
  }).join('');
}

/**
 * Strip markdown links, keeping only the text part
 * [text](url) → text
 */
function stripMarkdownLinks(text: string): string {
  return text.replace(MARKDOWN_LINK_REGEX, '$1');
}

/**
 * Strip HTML tags
 */
function stripHtmlTags(text: string): string {
  return text.replace(HTML_TAGS_REGEX, '');
}

/**
 * Convert spaces to dashes
 */
function spacesToDash(text: string): string {
  return text.replace(SPACES_REGEX, '-');
}

/**
 * Concatenate multiple dashes into one
 */
function concatDashes(text: string): string {
  return text.replace(/-+/g, '-');
}

/**
 * Generate a dev.to compatible anchor from a heading title
 *
 * The algorithm follows dev.to's slugify function:
 * 1. Sanitize HTML
 * 2. Lowercase
 * 3. Remove emojis
 * 4. Trim
 * 5. Remove punctuation
 * 6. Replace spaces with dashes
 */
export function generateDevToAnchor(title: string): string {
  let anchor = title
    // 1. Lowercase
    .toLowerCase()
    // 2. Transform inline code - escape HTML entities inside backticks
    .replace(INLINE_CODE_REGEX, (_, code) => `\`${escapeHtmlEntities(code)}\``)
    // 3. Strip HTML tags
    .replace(HTML_TAGS_REGEX, '')
    // 4. Strip markdown links (keep text only)
    .replace(MARKDOWN_LINK_REGEX, '$1')
    // 5. Escape HTML entities (& < >) in the remaining text
    .replace(/&/g, 'amp')
    .replace(/</g, 'lt')
    .replace(/>/g, 'gt')
    // 6. Remove common emojis
    .replace(EMOJI_REGEX, '')
    // 7. Trim BEFORE removing punctuation
    .trim()
    // 8. Replace backticks with raw/endraw markers
    .replace(/`/g, (_, offset, str) => {
      const backticksBefore = (str.slice(0, offset).match(/`/g) || []).length;
      return backticksBefore % 2 === 0 ? ' raw ' : ' endraw ';
    })
    // 9. Remove punctuation
    .replace(PUNCTUATION_REGEX, '')
    // 10. Convert spaces to dashes
    .replace(SPACES_REGEX, '-')
    // 11. Concatenate multiple dashes
    .replace(/-+/g, '-');

  // Remove leading/trailing dashes that may result from the transformations
  anchor = anchor.replace(/^-+|-+$/g, '');

  return anchor;
}

/**
 * Parse a markdown line to extract header info
 */
function parseHeader(line: string): { level: number; title: string } | null {
  const match = HEADER_REGEX.exec(line);
  if (!match) return null;
  return {
    level: match[1].length,
    title: match[2].trim(),
  };
}

/**
 * Check if a line starts or is inside a code block
 */
function isCodeBlockMarker(line: string): string | null {
  const trimmed = line.replace(/^\s*(?:\d+\.)?[*+-]?\s*/, '');
  if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
    const char = trimmed[0];
    const match = trimmed.match(new RegExp(`^(${char}{3,})`));
    return match ? match[1] : null;
  }
  return null;
}

/**
 * Generate TOC entries from markdown content
 */
function extractTocEntries(content: string, options: Required<TocOptions>): TocEntry[] {
  const entries: TocEntry[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeBlockMarker = '';
  let inHtmlComment = false;

  for (const line of lines) {
    // Handle HTML comments (block level)
    if (!inCodeBlock) {
      if (HTML_COMMENT_START_REGEX.test(line) && !HTML_COMMENT_END_REGEX.test(line)) {
        inHtmlComment = true;
        continue;
      }
      if (inHtmlComment) {
        if (HTML_COMMENT_END_REGEX.test(line)) {
          inHtmlComment = false;
        }
        continue;
      }
    }

    // Handle code blocks
    const codeMarker = isCodeBlockMarker(line);
    if (codeMarker) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockMarker = codeMarker;
      } else if (line.trim().startsWith(codeBlockMarker)) {
        inCodeBlock = false;
        codeBlockMarker = '';
      }
      continue;
    }

    if (inCodeBlock || inHtmlComment) continue;

    // Parse headers
    const header = parseHeader(line);
    if (header && header.level <= options.maxLevel) {
      const anchor = generateDevToAnchor(header.title);
      // Note: dev.to does NOT handle duplicate anchors, so we don't add suffixes
      entries.push({
        indent: header.level - 1,
        title: stripMarkdownLinks(header.title),
        link: anchor,
      });
    }
  }

  return entries;
}

/**
 * Generate the TOC markdown from entries
 */
function generateTocMarkdown(entries: TocEntry[], options: Required<TocOptions>): string {
  if (entries.length === 0) return '';

  const minIndent = options.trimTocIndent ? Math.min(...entries.map(e => e.indent)) : 0;

  return entries.map(entry => {
    const adjustedIndent = entry.indent - minIndent;
    const spaces = ' '.repeat(adjustedIndent * options.indentSpaces);
    const bullet = options.indentChars[adjustedIndent % options.indentChars.length];
    return `${spaces}${bullet} [${entry.title}](#${entry.link})`;
  }).join('\n');
}

/**
 * Check if content has an existing TOC
 */
function hasToc(content: string): boolean {
  return content.includes(TOC_PLACEHOLDER) ||
    content.includes('{%- # TOC start') ||
    content.includes('{% comment %}TOC start') ||
    content.includes('<!-- TOC start');
}

/**
 * Find TOC position in content
 * Returns { startLine, endLine } or null if no TOC found
 */
function findTocPosition(content: string): { startLine: number; endLine: number } | null {
  const lines = content.split('\n');
  let startLine = -1;
  let endLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Check for TOC start markers
    if (trimmed.includes('TOC start') &&
      (trimmed.startsWith('{%-') || trimmed.startsWith('{% comment %}') || trimmed.startsWith('<!--'))) {
      startLine = i;
    }

    // Check for TOC end markers
    if (startLine !== -1 && trimmed.includes('TOC end')) {
      endLine = i;
      break;
    }

    // Check for simple [TOC] placeholder
    if (trimmed === TOC_PLACEHOLDER) {
      return { startLine: i, endLine: i };
    }
  }

  if (startLine !== -1 && endLine !== -1) {
    return { startLine, endLine };
  }

  return null;
}

/**
 * Find and remove existing TOC block, returning content and original position
 */
function removeExistingToc(content: string): { content: string; position: { startLine: number; endLine: number } | null } {
  const position = findTocPosition(content);

  if (!position) {
    return { content, position: null };
  }

  const lines = content.split('\n');
  const result = [
    ...lines.slice(0, position.startLine),
    ...lines.slice(position.endLine + 1)
  ];

  return { content: result.join('\n'), position };
}

/**
 * Update or generate TOC in markdown content
 */
export function updateToc(content: string, options?: TocOptions): string {
  const opts = { ...defaultOptions, ...options };

  // Remove existing TOC and get its position
  const { content: cleanContent, position: tocPosition } = removeExistingToc(content);

  // Extract TOC entries from the clean content
  const entries = extractTocEntries(cleanContent, opts);

  if (entries.length === 0) {
    debug('No headers found, skipping TOC generation');
    return content;
  }

  // Generate TOC markdown
  const tocMarkdown = generateTocMarkdown(entries, opts);

  // Wrap TOC with HTML comments (dev.to style)
  const wrappedToc = [
    TOC_START,
    '',
    tocMarkdown,
    '',
    TOC_END,
  ].join('\n');

  const lines = cleanContent.split('\n');

  // If TOC existed, insert at same position
  if (tocPosition) {
    const result = [
      ...lines.slice(0, tocPosition.startLine),
      wrappedToc,
      ...lines.slice(tocPosition.startLine)
    ];
    return result.join('\n');
  }

  // No existing TOC - insert at beginning
  // Add leading newline so matter.stringify produces a blank line after front matter
  const contentWithoutLeadingNewlines = cleanContent.replace(/^\n+/, '');
  return '\n' + wrappedToc + '\n\n' + contentWithoutLeadingNewlines;
}

/**
 * Check if article content needs TOC update
 */
export function needsTocUpdate(content: string): boolean {
  return hasToc(content);
}

/**
 * Generate TOC only (without modifying content)
 */
export function generateTocOnly(content: string, options?: TocOptions): string {
  const opts = { ...defaultOptions, ...options };
  const entries = extractTocEntries(content, opts);
  return generateTocMarkdown(entries, opts);
}
