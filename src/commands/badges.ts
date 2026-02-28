import process from 'node:process';
import path from 'node:path';
import Debug from 'debug';
import chalk from 'chalk';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { getArticlesFromFiles } from '../article.js';
import { getAllArticles } from '../api.js';
import { createSpinner } from '../spinner.js';
import { type Article, type RemoteArticleData, type Repository } from '../models.js';

const debug = Debug('badges');

const hostUrl = 'https://raw.githubusercontent.com';
const badgesDir = 'images/badges';
const badgeWidth = 500;
const badgeHeight = 208;

type BadgesOptions = {
  devtoKey: string;
  repo: string;
  branch: string;
  output: string;
  jpg: boolean;
};

type BadgeArticle = {
  title: string;
  coverImageUrl: string;
  coverImageLocalPath: string | null;
  link: string;
  views: number;
  readingTime: number;
  date: string;
  category: string;
  slug: string;
  stars: number;
};

const categoryConfig: Record<string, { emoji: string; label: string; order: number }> = {
  GITLAB: { emoji: '🦊', label: 'GitLab / 🔀 Git', order: 1 },
  K8S: { emoji: '☸️', label: 'Kubernetes', order: 2 },
  MISC: { emoji: '📝', label: 'Miscellaneous', order: 3 }
};

function extractCategory(filename: string): string | null {
  const base = path.basename(filename, '.md');
  // Pattern: YY_MM_DD_CATEGORY_slug or CATEGORY_slug
  const match = /^(?:\d{2}_\d{2}_\d{2}_)?([A-Z0-9]+)_/.exec(base);
  return match?.[1] ?? null;
}

function extractSlug(filename: string): string {
  const base = path.basename(filename, '.md');
  // Remove date prefix and category: YY_MM_DD_CATEGORY_slug -> slug
  return base.replace(/^(?:\d{2}_\d{2}_\d{2}_)?[A-Z0-9]+_/, '');
}

function getCoverImageLocalPath(article: Article, repository: Repository, branch: string): string | null {
  const coverImage = article.data.cover_image;
  if (!coverImage) {
    return null;
  }

  const basePath = path.dirname(article.file!);

  // Absolute GitHub raw URL: extract relative path
  const prefix = `${hostUrl}/${repository.user}/${repository.name}/${branch}/`;
  if (coverImage.startsWith(prefix)) {
    const relativePath = coverImage.slice(prefix.length);
    return path.normalize(relativePath);
  }

  // Skip other absolute URLs
  if (/^https?:\/\//.test(coverImage)) {
    return null;
  }

  // Relative path
  return path.normalize(path.join(basePath, coverImage));
}

function getCoverImageUrl(article: Article, repository: Repository, branch: string): string | null {
  const coverImage = article.data.cover_image;
  if (!coverImage) {
    return null;
  }

  // Already an absolute URL
  if (/^https?:\/\//.test(coverImage)) {
    return coverImage;
  }

  // Relative path: build GitHub raw URL
  const basePath = path.dirname(article.file!);
  const fullPath = path.normalize(path.join(basePath, coverImage)).replace(/\\/g, '/');
  return `${hostUrl}/${repository.user}/${repository.name}/${branch}/${fullPath}`;
}

function parseRepository(repo: string): Repository {
  const [user, name] = repo.split('/');
  return { user, name };
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function sanitizeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripEmojis(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]/gu, '').replace(/^\s+/, '');
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 3);
}

function computeStars(articles: BadgeArticle[]): void {
  const sorted = [...articles].sort((a, b) => b.views - a.views);
  if (sorted.length < 2 || sorted[0].views === 0) return;
  // Use the 2nd most viewed as reference (the 1st often runs away in views)
  const refViews = sorted[1].views;
  for (const article of articles) {
    if (article.views >= refViews * 0.9) {
      article.stars = 3;
    } else if (article.views >= refViews * 0.5) {
      article.stars = 2;
    } else if (article.views >= refViews * 0.25) {
      article.stars = 1;
    }
  }
}

function renderStarsSvg(stars: number): string {
  if (stars === 0) return '';
  const starPath = 'M10,1 L12.9,7 L19.5,7.6 L14.5,12 L16,18.5 L10,15 L4,18.5 L5.5,12 L0.5,7.6 L7.1,7 Z';
  const elements: string[] = [];
  for (let i = 0; i < stars; i++) {
    const x = badgeWidth - 48 - (i * 44);
    elements.push(`<g transform="translate(${x}, 4) scale(2.2)"><path d="${starPath}" fill="#FFD700" stroke="black" stroke-width="0.6"/></g>`);
  }
  return elements.join('\n    ');
}

async function generateBadgePng(article: BadgeArticle): Promise<Buffer> {
  const coverBuffer = await fs.readFile(article.coverImageLocalPath!);

  // Resize cover to badge dimensions
  const cover = sharp(coverBuffer).resize(badgeWidth, badgeHeight, { fit: 'cover' });

  // Build text overlay as SVG (avoid emojis - Pango can't render them)
  const title = sanitizeSvgText(stripEmojis(article.title));
  const titleLines = wrapText(title, 36);
  const stats = `${formatDate(article.date)}  |  ${article.views} views  |  ${article.readingTime} min read`;

  const titleY = badgeHeight - 25 - (titleLines.length * 30);
  const titleElements = titleLines
    .map((line, i) => `<text x="15" y="${titleY + i * 30}" class="title">${line}</text>`)
    .join('\n    ');
  const statsY = badgeHeight - 12;

  const starsElements = renderStarsSvg(article.stars);

  const overlaySvg = `<svg width="${badgeWidth}" height="${badgeHeight}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.75"/>
      </linearGradient>
    </defs>
    <style>
      .title { fill: white; font-family: sans-serif; font-size: 24px; font-weight: 700; }
      .stats { fill: rgba(255,255,255,0.85); font-family: sans-serif; font-size: 15px; }
    </style>
    <rect x="0" y="0" width="${badgeWidth}" height="${badgeHeight}" fill="url(#fade)"/>
    ${starsElements}
    ${titleElements}
    <text x="15" y="${statsY}" class="stats">${sanitizeSvgText(stats)}</text>
</svg>`;

  const overlayBuffer = Buffer.from(overlaySvg);

  return cover
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

function renderCategoryHtml(categoryKey: string, articles: BadgeArticle[]): string {
  const config = categoryConfig[categoryKey] ?? { emoji: '📄', label: categoryKey, order: 99 };
  const lines: string[] = [];
  lines.push(`## ${config.emoji} ${config.label}`);
  lines.push('');
  lines.push('<table>');

  for (const article of articles) {
    lines.push('<tr>');
    lines.push(`<td width="40%" valign="top">`);
    lines.push(`<a href="${article.link}"><img src="${article.coverImageUrl}" width="100%" alt="${article.title.replace(/"/g, '&quot;')}"></a>`);
    lines.push('</td>');
    lines.push(`<td width="60%" valign="top">`);
    lines.push(`<b><a href="${article.link}">${article.title}</a></b><br>`);
    lines.push(`<sub>📅 ${formatDate(article.date)} · 👁 ${article.views} · ⏱ ${article.readingTime} min</sub>`);
    lines.push('</td>');
    lines.push('</tr>');
  }

  lines.push('</table>');
  return lines.join('\n');
}

function renderCategorySvg(categoryKey: string, articles: BadgeArticle[], badgeUrls: Map<string, string>, repository: Repository, branch: string): string {
  const config = categoryConfig[categoryKey] ?? { emoji: '📄', label: categoryKey, order: 99 };
  const baseUrl = `${hostUrl}/${repository.user}/${repository.name}/${branch}/`;
  const cacheBuster = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const lines: string[] = [];
  lines.push(`## ${config.emoji} ${config.label}`);
  lines.push('');
  lines.push('<table>');

  for (let i = 0; i < articles.length; i += 2) {
    const left = articles[i];
    const right = articles[i + 1];
    lines.push('<tr>');
    lines.push(`<td width="50%" valign="top">`);
    const leftImg = badgeUrls.get(left.slug) ?? '';
    lines.push(`<a href="${left.link}"><img src="${baseUrl}${leftImg}?v=${cacheBuster}" width="100%" alt="${left.title.replace(/"/g, '&quot;')}"></a>`);
    lines.push('</td>');
    lines.push(`<td width="50%" valign="top">`);
    if (right) {
      const rightImg = badgeUrls.get(right.slug) ?? '';
      lines.push(`<a href="${right.link}"><img src="${baseUrl}${rightImg}?v=${cacheBuster}" width="100%" alt="${right.title.replace(/"/g, '&quot;')}"></a>`);
    }
    lines.push('</td>');
    lines.push('</tr>');
  }

  lines.push('</table>');
  return lines.join('\n');
}

export async function badges(files?: string[], options?: Partial<BadgesOptions>) {
  options = options ?? {};
  const outputFile = options.output ?? '_ARTICLES.md';
  debug('options: %O', options);

  if (!options.devtoKey) {
    process.exitCode = -1;
    console.error(
      `${chalk.red(`No dev.to API key provided.`)}\nUse ${chalk.bold(`--token`)} option or ${chalk.bold(
        `.env`
      )} file to provide one.`
    );
    return;
  }

  if (!options.repo) {
    dotenv.config();
    options.repo = process.env.DEVTO_REPO;
  }

  if (!options.repo) {
    process.exitCode = -1;
    console.error(
      `${chalk.red(`No GitHub repository provided.`)}\nUse ${chalk.bold(`--repo`)} option or ${chalk.bold(
        `DEVTO_REPO`
      )} in .env file.`
    );
    return;
  }

  const branch = options.branch ?? process.env.DEVTO_BRANCH ?? 'main';
  const repository = parseRepository(options.repo);
  const spinner = createSpinner(debug);

  try {
    // 1. Load local articles
    spinner.text = 'Loading local articles…';
    spinner.start();
    const localArticles = await getArticlesFromFiles(files?.length ? files : ['*.md']);
    debug('Found %s local articles', localArticles.length);

    // 2. Filter published articles with a date
    const publishedArticles = localArticles.filter(
      (a) => a.data.published && a.data.date && a.data.id
    );
    debug('Found %s published articles', publishedArticles.length);

    if (publishedArticles.length === 0) {
      spinner.stop();
      console.info(chalk.yellow('⚠ No published articles found.'));
      return;
    }

    // 3. Fetch remote stats
    spinner.text = 'Fetching stats from dev.to…';
    const remoteArticles = await getAllArticles(options.devtoKey);
    spinner.stop();

    // Build a map of remote articles by ID for quick lookup
    const remoteMap = new Map<number, RemoteArticleData>();
    for (const remote of remoteArticles) {
      remoteMap.set(remote.id, remote);
    }

    // 4. Build badge articles
    const badgeArticles: BadgeArticle[] = [];
    for (const article of publishedArticles) {
      const category = extractCategory(article.file ?? '');
      if (!category) {
        debug('Skipping "%s": no category in filename', article.data.title);
        console.log(chalk.gray(`· ${article.file} (no category in filename)`));
        continue;
      }

      const coverImageUrl = getCoverImageUrl(article, repository, branch);
      if (!coverImageUrl) {
        debug('Skipping "%s": no cover image', article.data.title);
        console.log(chalk.yellow(`⚠ ${article.file} (no cover image)`));
        continue;
      }

      const remote = remoteMap.get(article.data.id as number);
      const views = remote?.page_views_count ?? 0;
      const readingTime = remote ? Math.ceil(remote.body_markdown.split(/\s+/).length / 265) : 0;
      const link = article.data.link ?? `https://dev.to/p/${article.data.id}`;
      const slug = extractSlug(article.file ?? '');

      badgeArticles.push({
        title: article.data.title!,
        coverImageUrl,
        coverImageLocalPath: getCoverImageLocalPath(article, repository, branch),
        link,
        views,
        readingTime,
        date: article.data.date!,
        category,
        slug,
        stars: 0
      });
    }

    // 5. Group by category (merge GIT into GITLAB)
    const grouped = new Map<string, BadgeArticle[]>();
    for (const badge of badgeArticles) {
      const key = badge.category === 'GIT' ? 'GITLAB' : badge.category;
      const list = grouped.get(key) ?? [];
      list.push(badge);
      grouped.set(key, list);
    }

    // Sort articles within each category by date descending
    for (const [, list] of grouped) {
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }

    // Sort categories by configured order
    const sortedCategories = [...grouped.entries()].sort((a, b) => {
      const orderA = categoryConfig[a[0]]?.order ?? 99;
      const orderB = categoryConfig[b[0]]?.order ?? 99;
      return orderA - orderB;
    });

    // 6. Compute popularity stars
    computeStars(badgeArticles);

    // 7. Generate JPEG badges if --jpg
    const badgeUrls = new Map<string, string>();
    if (options.jpg) {
      await fs.ensureDir(badgesDir);
      let badgeCount = 0;
      for (const badge of badgeArticles) {
        if (!badge.coverImageLocalPath) {
          throw new Error(`Cover image not found locally for "${badge.title}" (${badge.slug})`);
        }

        if (!await fs.pathExists(badge.coverImageLocalPath)) {
          throw new Error(`Cover image file does not exist: ${badge.coverImageLocalPath} (${badge.title})`);
        }

        const pngFile = path.join(badgesDir, `${badge.slug}.jpg`);
        const pngBuffer = await generateBadgePng(badge);
        await fs.writeFile(pngFile, pngBuffer);
        badgeUrls.set(badge.slug, pngFile);
        badgeCount++;
        debug('Generated JPEG badge: %s', pngFile);
      }

      console.log(chalk.green(`✓ ${badgesDir}/ (${badgeCount} badges)`));
    }

    // 8. Generate markdown
    const sections: string[] = ['# 📰 Articles', ''];
    sections.push('Here are my articles, grouped by theme and sorted by publication date (newest first), with view counts and highlights for the most read ones ⭐');
    sections.push('');

    for (const [categoryKey, articles] of sortedCategories) {
      if (options.jpg) {
        sections.push(renderCategorySvg(categoryKey, articles, badgeUrls, repository, branch));
      } else {
        sections.push(renderCategoryHtml(categoryKey, articles));
      }

      sections.push('');
    }

    const today = new Date().toISOString().slice(0, 10);
    sections.push(`_Generated by [a fork of devto-cli](https://github.com/bcouetil/devto-cli) on ${today}_`);
    sections.push('');

    const markdown = sections.join('\n');
    await fs.writeFile(outputFile, markdown);

    console.log(chalk.green(`✓ ${outputFile}`));
    console.log(
      `Articles: ${chalk.green(String(badgeArticles.length))} | Categories: ${chalk.green(String(sortedCategories.length))}`
    );
  } catch (error) {
    spinner.stop();
    process.exitCode = -1;
    console.error(chalk.red(`✗ Error generating badges: ${(error as Error).message}`));
    debug('Full error: %O', error);
  }
}
