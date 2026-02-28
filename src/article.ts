import path from 'node:path';
import Debug from 'debug';
import fs from 'fs-extra';
import { globby } from 'globby';
import matter from 'gray-matter';
import slugify from 'slugify';
import got, { RequestError } from 'got';
import pMap from 'p-map';
import { HttpsProxyAgent } from 'hpagent';
import { updateRelativeImageUrls, getImageUrls } from './util.js';
import { type Article, type ArticleMetadata, type RemoteArticleData, type Repository } from './models.js';

const debug = Debug('article');
export const defaultArticlesFolder = 'posts';

// Configure proxy for corporate environments
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyAgent = proxyUrl ? new HttpsProxyAgent({ proxy: proxyUrl }) : undefined;

/**
 * Updates the article content with a footer file content.
 * The footer replaces everything from the first line of the footer file to the end of the article.
 * @param article The article to update
 * @param footerFilePath Path to the footer file (absolute or relative to cwd or article file)
 * @returns The updated article with footer, or the original article if not published
 * @throws Error if footer file is configured but not found or empty
 */
export async function updateArticleFooter(article: Article, footerFilePath: string | undefined): Promise<Article> {
  if (!footerFilePath) {
    return article;
  }

  // Only apply footer to published articles
  if (!article.data.published) {
    debug('Article "%s" is not published, skipping footer update', article.data.title);
    return article;
  }

  // Resolve the footer file path
  let resolvedPath = footerFilePath;

  // If path is relative, try to resolve it
  if (!path.isAbsolute(footerFilePath)) {
    // First try relative to current working directory
    const cwdPath = path.resolve(process.cwd(), footerFilePath);
    if (await fs.pathExists(cwdPath)) {
      resolvedPath = cwdPath;
    } else if (article.file) {
      // Then try relative to the article file
      const articleDir = path.dirname(path.resolve(article.file));
      const articleRelPath = path.resolve(articleDir, footerFilePath);
      if (await fs.pathExists(articleRelPath)) {
        resolvedPath = articleRelPath;
      }
    }
  }

  if (!await fs.pathExists(resolvedPath)) {
    throw new Error(`Footer file not found: ${footerFilePath} (resolved to: ${resolvedPath})`);
  }

  const footerContent = (await fs.readFile(resolvedPath, 'utf8')).replace(/\r\n/g, '\n');
  const footerLines = footerContent.split('\n');

  if (footerLines.length === 0) {
    throw new Error(`Footer file is empty: ${resolvedPath}`);
  }

  // Get the first non-empty line of the footer as the marker
  const firstFooterLine = footerLines.find(line => line.trim().length > 0);
  if (!firstFooterLine) {
    throw new Error(`Footer file has no non-empty lines: ${resolvedPath}`);
  }

  // Find the marker in the article content
  const articleLines = article.content.split(/\r?\n/);
  const markerIndex = articleLines.findIndex(line => line.trim() === firstFooterLine.trim());

  if (markerIndex === -1) {
    debug('Footer marker "%s" not found in article "%s", article unchanged', firstFooterLine.trim(), article.data.title);
    return article;
  }

  // Replace from marker to end with footer content
  const newContent = [...articleLines.slice(0, markerIndex), footerContent].join('\n');
  debug('Updated footer in article "%s" (marker found at line %d)', article.data.title, markerIndex + 1);

  return { ...article, content: newContent };
}

export async function getArticlesFromFiles(filesGlob: string[]): Promise<Article[]> {
  const files: string[] = await globby(filesGlob);
  const articles = await Promise.all(files.map(getArticleFromFile));
  return articles.filter((article) => article !== null);
}

async function getArticleFromFile(file: string): Promise<Article | null> {
  const content = await fs.readFile(file, 'utf8');
  const article = matter(content, { language: 'yaml' });

  // An article must have a least a title property and sync should not be disabled
  if (!article.data.title || (article.data.devto_sync !== undefined && !article.data.devto_sync)) {
    debug('File "%s" do not have a title or has sync disabled, skipping', file);
    return null;
  }

  return { file, ...article };
}

export function getArticlesFromRemoteData(data: RemoteArticleData[]): Article[] {
  return (data || []).map(getArticleFromRemoteData);
}

function generateFrontMatterMetadata(remoteData: RemoteArticleData): ArticleMetadata {
  const { data: frontmatter } = matter(remoteData.body_markdown);
  // Note: series info is missing here as it's not available through the dev.to API yet
  const metadata: ArticleMetadata = {
    title: frontmatter.title ? null : remoteData.title,
    description: frontmatter.description ? null : remoteData.description,
    tags: frontmatter.tags ? null : remoteData.tag_list.join(', '),
    cover_image: frontmatter.cover_image ? null : remoteData.cover_image,
    organization: null,  // Never auto-generate organization field
    canonical_url:
      frontmatter.canonical_url || remoteData.url === remoteData.canonical_url ? null : remoteData.canonical_url,
    published: remoteData.published ? true : null,
    id: remoteData.id,
    date: remoteData.published_at,
    link: remoteData.published ? remoteData.url : `${remoteData.url}?preview=fixme`
  };

  // Clean up unset properties
  for (const p in metadata) {
    if (metadata[p] === null || metadata[p] === undefined) {
      delete metadata[p];
    }
  }

  return metadata;
}

function getArticleFromRemoteData(data: RemoteArticleData): Article {
  const article = matter(data.body_markdown);
  return {
    ...article,
    file: null,
    data: {
      ...article.data,
      ...generateFrontMatterMetadata(data)
    }
  };
}

export function prepareArticleForDevto(article: Article, repository: Repository, branch: string): Article {
  return updateRelativeImageUrls(article, repository, branch);
}

export async function saveArticleToFile(article: Article) {
  try {
    if (!article.file) {
      throw new Error('no filename provided');
    }

    // Create a copy of article data without organization_id (only used for API, not saved)
    const dataToSave = { ...article.data };
    delete dataToSave.organization_id;

    const markdown = matter.stringify(article.content, dataToSave, { lineWidth: -1 } as any);
    await fs.ensureDir(path.dirname(article.file));
    await fs.writeFile(article.file, markdown);
    debug('Saved article "%s" to file "%s"', article.data.title, article.file);
  } catch (error) {
    throw new Error(`Cannot write to file "${article.file ?? ''}": ${String(error)}`);
  }
}

export async function updateLocalArticle(article: Article, remoteData: RemoteArticleData): Promise<Article> {
  const data = { ...article.data };
  const newArticle = { ...article, data };
  let hasChanged = false;

  if (remoteData.id) {
    data.id = remoteData.id;
    hasChanged = true;
  }

  if (remoteData.published_at) {
    data.date = remoteData.published_at;
    hasChanged = true;
  }

  // Update link if not set, or if article is published (overwrite preview link)
  // Use published_at as indicator since API response may not include published field
  const isPublished = remoteData.published || !!remoteData.published_at;
  if (remoteData.url && (!data.link || isPublished)) {
    const newLink = isPublished ? remoteData.url : `${remoteData.url}?preview=fixme`;
    if (data.link !== newLink) {
      data.link = newLink;
      hasChanged = true;
    }
  }

  return { ...newArticle, hasChanged };
}

export function generateArticleFilename(article: Article): Article {
  if (!article.data?.title) {
    throw new Error('No title found');
  }

  // Slugify has a typing issue with latest versions of typescript
  const name = (slugify as any)(article.data.title, { lower: true, strict: true }) as string;
  const file = path.join(defaultArticlesFolder, name + '.md');
  return { ...article, file };
}

export function reconcileLocalArticles(remoteArticles: Article[], localArticles: Article[], idOnly = true): Article[] {
  return localArticles.map((article) => {
    if (article.data.id) {
      return article;
    }

    const title = article.data.title?.trim();
    const remoteArticle = remoteArticles.find((a) => a.data.title?.trim() === title);

    if (remoteArticle?.data.id) {
      debug('Reconciled article "%s" to ID %s', article.data.title, remoteArticle.data.id);
      const reconciledMetadata = idOnly ? { id: remoteArticle.data.id } : { ...remoteArticle.data };

      return {
        ...article,
        data: {
          ...article.data,
          ...reconciledMetadata
        },
        hasChanged: true
      };
    }

    return article;
  });
}

function areArticlesEqual(article1: Article, article2: Article): boolean {
  // Note: ignore date for comparison, since dev.to does not always format it the same way,
  // and it's not meant to be updated anyways.
  // Ignore link since it's auto-generated and may have ?preview=fixme suffix for drafts.
  const options: any = { lineWidth: -1 };
  const a1 = matter.stringify(article1, { ...article1.data, date: null, link: null }, options);
  const a2 = matter.stringify(article2, { ...article2.data, date: null, link: null }, options);
  return a1 === a2;
}

export function checkIfArticleNeedsUpdate(remoteArticles: Article[], article: Article): boolean {
  if (!article.data.id) {
    return true;
  }

  const remoteArticle = remoteArticles.find((a) => a.data.id === article.data.id);
  if (!remoteArticle) {
    throw new Error(`Cannot find published article on dev.to: ${article.data.title ?? '<no title>'}`);
  }

  return !areArticlesEqual(remoteArticle, article);
}

export async function createNewArticle(file: string, organization?: string | null) {
  const article = {
    file,
    content: `My article content`,
    data: {
      title: 'My article title',
      description: 'My article description',
      tags: '',
      cover_image: '',
      canonical_url: null,
      published: false,
      organization: organization || '<none>'
    }
  };

  await saveArticleToFile(article);
}

export async function checkArticleForOfflineImages(article: Article): Promise<string | null> {
  try {
    const urls = getImageUrls(article);
    debug('Found %s image(s) to check for "%s"', urls.length, article.data.title);

    const checkUrl = async (url: string) => {
      debug('Checking image "%s"…', url);
      const requestOptions: any = {
        https: {
          rejectUnauthorized: false
        }
      };

      if (proxyAgent) {
        requestOptions.agent = { https: proxyAgent };
      }

      await got(url, requestOptions);
      return null;
    };

    await pMap(urls, checkUrl, { concurrency: 5 });
    return null;
  } catch (error) {
    if (error instanceof RequestError) {
      const url = error.response?.requestUrl?.toString() || (error as any).options?.url?.toString() || 'unknown URL';
      if (error.response) {
        const statusCode = error.response.statusCode;
        const statusMessage = error.response.statusMessage || 'Unknown error';
        debug('Image "%s" appears to be offline: %s %s', url, statusCode, statusMessage);
        return `${url} (HTTP ${statusCode}: ${statusMessage})`;
      } else {
        // No response means network/connection error
        const errorMsg = error.message || String(error);
        debug('Image "%s" check failed: %s', url, errorMsg);
        return `${url} (${errorMsg})`;
      }
    }

    debug('Error while checking image: %s', String(error));
    return String(error);
  }
}
