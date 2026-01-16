import process from 'node:process';
import Debug from 'debug';
import chalk from 'chalk';
import { table, getBorderCharacters } from 'table';
import pMap from 'p-map';
import {
  getArticlesFromFiles,
  getArticlesFromRemoteData,
  prepareArticleForDevto,
  checkIfArticleNeedsUpdate,
  updateLocalArticle,
  saveArticleToFile,
  reconcileLocalArticles,
  checkArticleForOfflineImages
} from '../article.js';
import { getAllArticles, updateRemoteArticle } from '../api.js';
import { getBranch, getRepository } from '../repo.js';
import { SyncStatus, PublishedStatus } from '../status.js';
import { createSpinner } from '../spinner.js';
import { replaceDiagramsInArticle } from '../diagram.js';
import { type Article, type Repository } from '../models.js';

const debug = Debug('push');

export type PushOptions = {
  devtoKey: string;
  repo: string;
  branch: string;
  dryRun: boolean;
  reconcile: boolean;
  checkImages: boolean;
};

export type PushResult = {
  article: Article;
  status: string;
  publishedStatus: string;
  errors?: string[];
};

export function formatErrors(results: PushResult[]) {
  const errors = results.filter((result) => result.errors);
  let output = '';
  for (const result of errors) {
    output += chalk.red(`${chalk.bold(result.article.file!)} has error(s):\n`);
    for (const error of result.errors!) {
      output += chalk.red(`- ${error}\n`);
    }
  }

  return output;
}

export function formatResultsTable(results: PushResult[]) {
  const rows = results.map((r) => [r.status, r.publishedStatus, r.article.data.title]);
  const availableWidth = process.stdout.columns || 80;
  const tableConfig: any = {
    drawHorizontalLine: () => false,
    border: getBorderCharacters('void'),
    columnDefault: { paddingLeft: 0, paddingRight: 1 }
  };
  if (availableWidth >= 80) {
    const usedWidth = 27;
    const maxTitleWidth = Math.max(availableWidth - usedWidth, 8);
    tableConfig.columns = { 2: { truncate: Math.min(maxTitleWidth, availableWidth - 30), width: Math.min(maxTitleWidth, availableWidth - 30) } };
  }
  try {
    return table(rows, tableConfig).slice(0, -1);
  } catch (tableError) {
    // Fallback without column config
    return table(rows, {
      drawHorizontalLine: () => false,
      border: getBorderCharacters('void'),
      columnDefault: { paddingLeft: 0, paddingRight: 1 }
    }).slice(0, -1);
  }
}

async function getRemoteArticles(devtoKey: string): Promise<Article[]> {
  const remoteData = await getAllArticles(devtoKey);
  const remoteArticles = getArticlesFromRemoteData(remoteData);
  debug('Retrieved %s article(s)', remoteArticles.length);
  return remoteArticles;
}

async function processArticles(
  localArticles: Article[],
  remoteArticles: Article[],
  repository: Repository,
  branch: string,
  options: Partial<PushOptions>
): Promise<PushResult[]> {
  const processArticle = async (article: Article) => {
    // Replace diagrams with images before processing (in memory only)
    let articleWithImages = article;
    try {
      articleWithImages = await replaceDiagramsInArticle(article);
    } catch (error) {
      debug('Warning: Could not replace diagrams in article %s: %s', article.file, String(error));
    }

    let newArticle = prepareArticleForDevto(articleWithImages, repository, branch);
    const needsUpdate = checkIfArticleNeedsUpdate(remoteArticles, newArticle);
    let status = newArticle.hasChanged ? SyncStatus.reconciled : SyncStatus.upToDate;
    let updateResult = null;
    const errors = [];

    if (needsUpdate) {
      try {
        const offlineImage = options.checkImages && (await checkArticleForOfflineImages(newArticle));

        if (!options.dryRun && !offlineImage) {
          updateResult = await updateRemoteArticle(newArticle, options.devtoKey!);
          // Update metadata on the ORIGINAL article (with diagrams), not the modified one
          const updatedOriginalArticle = await updateLocalArticle(article, updateResult);

          // Save the original article with updated metadata
          if (updateResult) {
            try {
              await saveArticleToFile(updatedOriginalArticle);
            } catch (error) {
              debug('Cannot save article "%s": %s', updatedOriginalArticle.data.title, String(error));
              status = SyncStatus.outOfSync;
            }
          }
        }

        if (offlineImage) {
          status = SyncStatus.imageOffline;
          errors.push(`Image ${offlineImage} is offline`);
        } else {
          status = newArticle.data.id ? SyncStatus.updated : SyncStatus.created;
        }
      } catch (error: any) {
        debug('Article update failed: %s', String(error));
        status = SyncStatus.failed;

        // Extract detailed error information
        let errorMessage = String(error);
        if (error?.response?.statusCode) {
          errorMessage = `HTTP ${error.response.statusCode} - ${error.response.statusMessage || 'Error'}`;
          if (error.response.body) {
            const body = typeof error.response.body === 'string'
              ? error.response.body
              : JSON.stringify(error.response.body, null, 2);
            errorMessage += `\nResponse: ${body}`;
          }
        }

        errors.push(`Update failed: ${errorMessage}`);
      }
    }

    return {
      article: newArticle,
      status,
      publishedStatus: newArticle.data.published ? PublishedStatus.published : PublishedStatus.draft,
      errors: errors.length > 0 ? errors : undefined
    };
  };

  return pMap(localArticles, processArticle, { concurrency: 5 });
}

export async function push(files: string[], options?: Partial<PushOptions>): Promise<PushResult[] | null> {
  options = options ?? {};
  files = files.length > 0 ? files : ['*.md'];
  debug('files: %O', files);
  debug('options: %O', options);

  if (!options.devtoKey) {
    process.exitCode = -1;
    console.error(
      `${chalk.red(`No dev.to API key provided.`)}\nUse ${chalk.bold(`--token`)} option or ${chalk.bold(
        `.env`
      )} file to provide one.`
    );
    return null;
  }

  if (options.dryRun) {
    console.warn(chalk.yellow(`Running in dry run mode, local and remote changes will be skipped`));
  }

  const spinner = createSpinner(debug);

  try {
    const repository = await getRepository(options.repo);
    if (!repository) {
      process.exitCode = -1;
      console.error(
        `${chalk.red(`No GitHub repository provided.`)}\nUse ${chalk.bold(`--repo`)} option or ${chalk.bold(
          `.env`
        )} file to provide one.`
      );
      return null;
    }

    debug('repository: %O', repository);

    const branch = await getBranch(options.branch);
    if (!branch) {
      process.exitCode = -1;
      console.error(
        `${chalk.red(`No GitHub branch provided.`)}\nUse ${chalk.bold(`--branch`)} option or ${chalk.bold(
          `.env`
        )} file to provide one.`
      );
      return null;
    }

    debug('branch: %s', branch);

    let articles = await getArticlesFromFiles(files);
    console.info(`Found ${chalk.green(articles.length)} article(s)`);

    if (articles.length === 0) {
      console.warn(`No articles to push.`);
      return [];
    }

    spinner.text = 'Retrieving articles from dev.to…';
    spinner.start();
    const remoteArticles = await getRemoteArticles(options.devtoKey);

    if (options.reconcile) {
      spinner.text = 'Reconciling articles…';
      articles = reconcileLocalArticles(remoteArticles, articles);
    }

    spinner.text = 'Pushing articles to dev.to…';
    const results = await processArticles(articles, remoteArticles, repository, branch, options);

    spinner.stop();
    console.error(formatErrors(results));
    console.info(formatResultsTable(results));

    const outOfSync = results.some((r) => r.status === SyncStatus.outOfSync);
    if (outOfSync) {
      console.info(
        chalk.yellow(`Some local files are out of sync. Retry pushing with ${chalk.bold(`--reconcile`)} option.`)
      );
    }

    const failed = results.some((r) => r.status === SyncStatus.failed || r.status === SyncStatus.imageOffline);
    if (failed) {
      process.exitCode = -1;
    }

    return results;
  } catch (error: any) {
    spinner.stop();
    process.exitCode = -1;

    // Provide helpful hint for EACCES errors (typically proxy issues)
    if (error?.code === 'EACCES') {
      console.error('\n⚠️  Access denied (EACCES) when connecting to dev.to or GitHub');
      console.error('💡 If you are behind a corporate proxy, make sure HTTPS_PROXY is set:');
      console.error('   PowerShell: $env:HTTPS_PROXY = "http://proxy.example.com:3131"');
      console.error('   Bash/Zsh:   export HTTPS_PROXY="http://proxy.example.com:3131"\n');
    }

    console.error(chalk.red(`Error: ${(error as Error).message}`));
    console.error('Push failed');

    // Check if it's a validation error from dev.to
    if ((error as any)?.response?.statusCode === 422) {
      const responseBody = (error as any)?.response?.body;
      if (responseBody?.error) {
        console.error(chalk.red(`Dev.to validation error: ${responseBody.error}`));
        console.error('Please check your article markdown for syntax errors, especially image URLs.');
      }
    }

    return null;
  }
}
