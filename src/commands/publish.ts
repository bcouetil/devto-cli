import process from 'node:process';
import Debug from 'debug';
import chalk from 'chalk';
import { getArticlesFromFiles, saveArticleToFile, FrontmatterValidationError } from '../article.js';
import { openUrlInBrowser, prompt } from '../util.js';
import { type Article } from '../models.js';
import { push, reportFrontmatterValidationError, type PushOptions, type PushResult } from './push.js';

const debug = Debug('publish');

export type PublishOptions = PushOptions;

function buildDeleteConfirmUrl(article: Article): string | null {
  const link = article.data.link;
  if (!link || typeof link !== 'string') {
    return null;
  }

  try {
    const url = new URL(link);
    url.search = '';
    url.hash = '';
    // Avoid double /delete_confirm if already present
    if (!url.pathname.endsWith('/delete_confirm')) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/delete_confirm`;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

async function prepareArticleForPublish(article: Article, dryRun: boolean): Promise<'prepared' | 'skipped' | 'aborted'> {
  const file = article.file ?? '<unknown>';

  if (article.data.published) {
    console.log(chalk.gray(`· ${file} (already published)`));
    return 'skipped';
  }

  if (article.data.id) {
    const deleteUrl = buildDeleteConfirmUrl(article);
    if (!deleteUrl) {
      console.error(chalk.red(`✗ ${file}: has id but no link — cannot open delete confirmation`));
      console.error(chalk.red(`Process stopped. Delete the preview on dev.to, then retry.`));
      return 'aborted';
    }

    if (dryRun) {
      console.log(chalk.yellow(`⚠ ${file} (dry-run: would open ${deleteUrl})`));
    } else {
      console.log(chalk.cyan(`→ Opening delete confirmation for "${article.data.title}"`));
      console.log(chalk.cyan(`  ${deleteUrl}`));
      try {
        await openUrlInBrowser(deleteUrl);
      } catch (error) {
        debug('Could not open browser: %s', String(error));
        console.log(chalk.yellow(`⚠ Could not open browser — open the URL above manually`));
      }

      const answer = await prompt(
        chalk.green(`>`) +
          ` Delete the preview on dev.to, then press y to continue (anything else stops): `
      );
      if (!isAffirmative(answer)) {
        console.error(chalk.red(`✗ Preview not deleted — process stopped. Nothing was published.`));
        return 'aborted';
      }
    }
  }

  const data = { ...article.data, published: true };
  delete data.id;
  delete data.link;

  const prepared: Article = { ...article, data };

  if (!dryRun) {
    await saveArticleToFile(prepared);
  }

  console.log(chalk.green(`✓ ${file} (ready to publish as new article)`));
  return 'prepared';
}

export async function publish(files: string[], options?: Partial<PublishOptions>): Promise<PushResult[] | null> {
  options = options ?? {};

  if (files.length === 0) {
    process.exitCode = -1;
    console.error(
      `${chalk.red(`No files specified.`)}\nUsage: ${chalk.bold(`dev publish <file> [files...]`)}`
    );
    return null;
  }

  debug('files: %O', files);
  debug('options: %O', options);

  if (options.dryRun) {
    console.warn(chalk.yellow(`Running in dry run mode, local and remote changes will be skipped`));
  }

  let articles: Article[];
  try {
    articles = await getArticlesFromFiles(files);
  } catch (error) {
    if (error instanceof FrontmatterValidationError) {
      process.exitCode = -1;
      reportFrontmatterValidationError(error);
      return null;
    }
    throw error;
  }

  console.info(`Found ${chalk.green(articles.length)} article(s)`);

  if (articles.length === 0) {
    console.warn(`No articles to publish.`);
    return [];
  }

  let prepared = 0;
  let skipped = 0;
  const filesToPush: string[] = [];

  for (const article of articles) {
    const result = await prepareArticleForPublish(article, Boolean(options.dryRun));
    if (result === 'aborted') {
      process.exitCode = -1;
      return null;
    }

    if (result === 'prepared') {
      prepared++;
      if (article.file) {
        filesToPush.push(article.file);
      }
    } else {
      skipped++;
    }
  }

  console.log(`Prepared: ${chalk.green(prepared)} | Skipped: ${chalk.gray(skipped)}`);

  if (filesToPush.length === 0) {
    console.info(chalk.gray(`Nothing to push.`));
    return [];
  }

  if (options.dryRun) {
    console.info(
      chalk.yellow(
        `Dry-run: would push ${filesToPush.length} article(s) as newly published (no id, published: true)`
      )
    );
    for (const file of filesToPush) {
      console.log(chalk.gray(`  · ${file}`));
    }

    return [];
  }

  console.info(`Pushing ${chalk.green(filesToPush.length)} article(s) as newly published…`);
  return push(filesToPush, options);
}
