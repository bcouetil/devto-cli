import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';
import chalk from 'chalk';
import Debug from 'debug';
import { globby } from 'globby';
import got, { RequestError } from 'got';
import pMap from 'p-map';
import { HttpsProxyAgent } from 'hpagent';
import matter from 'gray-matter';

const debug = Debug('checklinks');

// Configure proxy for corporate environments
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent({ proxy: proxyUrl }) : undefined;

// Regex to match markdown links: [text](url)
const markdownLinkRegex = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;

export type LinkCheckResult = {
  url: string;
  status: 'ok' | 'broken' | 'error';
  statusCode?: number;
  error?: string;
};

// HTTP codes that indicate bot blocking, not actual broken links - treat as OK
const BOT_BLOCKED_CODES = [403, 429, 503];

export type FileCheckResult = {
  file: string;
  links: LinkCheckResult[];
};

/**
 * Extract all URLs from markdown content (only [text](url) format)
 */
export function extractUrls(content: string): string[] {
  const urls = new Set<string>();
  let match;

  while ((match = markdownLinkRegex.exec(content))) {
    const url = match[1];
    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
}

/**
 * Check if a single URL is accessible
 */
async function checkUrl(url: string): Promise<LinkCheckResult> {
  debug('Checking URL "%s"…', url);

  try {
    const requestOptions: any = {
      timeout: { request: 10000 },
      retry: { limit: 1 },
      throwHttpErrors: true,
      https: {
        rejectUnauthorized: false
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; devto-cli/1.0; +https://github.com/sinedied/devto-cli)'
      }
    };

    if (proxyAgent) {
      requestOptions.agent = { https: proxyAgent };
    }

    // Use HEAD first, fallback to GET if HEAD fails
    try {
      await got.head(url, requestOptions);
    } catch {
      // Some servers don't support HEAD, try GET
      await got.get(url, requestOptions);
    }

    return { url, status: 'ok' };
  } catch (error) {
    if (error instanceof RequestError) {
      const statusCode = error.response?.statusCode;
      const statusMessage = error.response?.statusMessage || error.message;

      if (statusCode) {
        // Bot blocking codes (403, 429, 503) are treated as OK
        if (BOT_BLOCKED_CODES.includes(statusCode)) {
          return { url, status: 'ok' };
        }

        return {
          url,
          status: 'broken',
          statusCode,
          error: statusMessage
        };
      }

      return {
        url,
        status: 'error',
        error: error.message
      };
    }

    return {
      url,
      status: 'error',
      error: String(error)
    };
  }
}

/**
 * Check all URLs in a markdown file
 */
async function checkFileLinks(filePath: string): Promise<FileCheckResult> {
  const content = await fs.readFile(filePath, 'utf8');
  const article = matter(content);

  // Only process articles with a title
  if (!article.data.title) {
    return { file: filePath, links: [] };
  }

  const urls = extractUrls(article.content);

  // Also check cover_image and canonical_url if they're URLs
  if (article.data.cover_image && article.data.cover_image.startsWith('http')) {
    urls.push(article.data.cover_image);
  }
  if (article.data.canonical_url && article.data.canonical_url.startsWith('http')) {
    urls.push(article.data.canonical_url);
  }

  // Remove duplicates
  const uniqueUrls = [...new Set(urls)];

  debug('Found %d unique URL(s) in "%s"', uniqueUrls.length, filePath);

  const links = await pMap(uniqueUrls, checkUrl, { concurrency: 5 });

  return { file: filePath, links };
}

/**
 * Format a link check result for display
 */
function formatLinkResult(result: LinkCheckResult): string {
  if (result.status === 'ok') {
    return chalk.green(`    ✓ ${result.url}`);
  } else if (result.status === 'broken') {
    return chalk.red(`    ✗ ${result.url} (HTTP ${result.statusCode})`);
  } else {
    return chalk.red(`    ✗ ${result.url} (${result.error})`);
  }
}

/**
 * Main command to check links in markdown files
 */
export async function checkLinks(files?: string[]): Promise<void> {
  const globs = files && files.length > 0 ? files : ['*.md'];
  const matchingFiles = await globby(globs);

  if (matchingFiles.length === 0) {
    console.log(chalk.yellow('No markdown files found'));
    return;
  }

  let filesWithBrokenLinks = 0;
  let filesOk = 0;
  let totalBrokenLinks = 0;
  let totalLinks = 0;
  let filesSkipped = 0;

  for (const file of matchingFiles) {
    const filePath = path.resolve(process.cwd(), file);

    try {
      const result = await checkFileLinks(filePath);

      if (result.links.length === 0) {
        console.log(chalk.gray(`· ${file} (no links or not an article)`));
        filesSkipped++;
        continue;
      }

      totalLinks += result.links.length;

      const brokenLinks = result.links.filter((l) => l.status !== 'ok');

      if (brokenLinks.length === 0) {
        filesOk++;
        console.log(chalk.green(`✓ ${file} (${result.links.length} link${result.links.length > 1 ? 's' : ''} OK)`));
      } else {
        filesWithBrokenLinks++;
        totalBrokenLinks += brokenLinks.length;
        console.log(chalk.yellow(`⚠ ${file} (${brokenLinks.length}/${result.links.length} broken)`));

        for (const link of brokenLinks) {
          console.log(formatLinkResult(link));
        }
      }
    } catch (error) {
      console.error(chalk.red(`✗ ${file}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  console.log('');
  console.log(
    `Files: ${chalk.green(filesOk)} OK | ${chalk.yellow(filesWithBrokenLinks)} with broken links | ${chalk.gray(filesSkipped)} skipped`
  );
  console.log(
    `Links: ${chalk.green(totalLinks - totalBrokenLinks)} OK | ${chalk.red(totalBrokenLinks)} broken`
  );

  if (totalBrokenLinks > 0) {
    console.log(chalk.yellow(`\n⚠ Found ${totalBrokenLinks} broken link${totalBrokenLinks > 1 ? 's' : ''} in ${filesWithBrokenLinks} file${filesWithBrokenLinks > 1 ? 's' : ''}`));
  }
}
