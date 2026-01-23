import process from 'node:process';
import Debug from 'debug';
import chalk from 'chalk';
import dotenv from 'dotenv';
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
  checkArticleForOfflineImages,
  updateArticleFooter
} from '../article.js';
import { getAllArticles, updateRemoteArticle, getUserOrganizations, getOrganizationId } from '../api.js';
import { getBranch, getRepository } from '../repo.js';
import { SyncStatus, PublishedStatus } from '../status.js';
import { createSpinner } from '../spinner.js';
import { replaceDiagramsInArticle } from '../diagram.js';
import { updateToc, needsTocUpdate } from '../toc.js';
import { type Article, type Repository } from '../models.js';

const debug = Debug('push');

export type PushOptions = {
  devtoKey: string;
  repo: string;
  branch: string;
  dryRun: boolean;
  reconcile: boolean;
  checkImages: boolean;
  useOrganization: boolean;
  updateToc: boolean;
};

export type PushResult = {
  article: Article;
  status: string;
  publishedStatus: string;
  errors?: string[];
  url?: string;
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
  options: Partial<PushOptions>,
  spinner: any
): Promise<PushResult[]> {
  const results: PushResult[] = [];

  // Process articles sequentially to show progress and stop on first error
  for (let article of localArticles) {
    // Update footer FIRST if DEVTO_FOOTER_FILE is set (so TOC reflects final content)
    const footerFilePath = process.env.DEVTO_FOOTER_FILE;
    let footerWasUpdated = false;
    if (footerFilePath) {
      const articleWithFooter = await updateArticleFooter(article, footerFilePath);
      if (articleWithFooter.content !== article.content) {
        article = { ...article, content: articleWithFooter.content };
        footerWasUpdated = true;
        debug('Updated footer for %s', article.file);
      }
    }

    // Update TOC if enabled and article has a TOC marker (after footer so TOC reflects final structure)
    let tocWasUpdated = false;
    if (options.updateToc && needsTocUpdate(article.content)) {
      debug('Updating TOC for %s', article.file);
      const updatedContent = updateToc(article.content);
      if (updatedContent !== article.content) {
        article = { ...article, content: updatedContent };
        tocWasUpdated = true;
      }
    }

    // Save local file if footer or TOC was updated
    if ((footerWasUpdated || tocWasUpdated) && !options.dryRun) {
      try {
        await saveArticleToFile(article);
        debug('Saved article with updated footer/TOC: %s', article.file);
      } catch (error) {
        debug('Warning: Could not save article update for %s: %s', article.file, String(error));
      }
    }

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
          errors.push(`Image is offline: ${offlineImage}`);
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

    // For preview articles, prefer the link from the header (with token) over the remote URL
    const articleUrl = !newArticle.data.published && newArticle.data.link
      ? newArticle.data.link
      : updateResult?.url || newArticle.data.link || undefined;

    const result = {
      article: newArticle,
      status,
      publishedStatus: newArticle.data.published ? PublishedStatus.published : PublishedStatus.draft,
      errors: errors.length > 0 ? errors : undefined,
      url: articleUrl
    };

    results.push(result);

    // Display result immediately
    spinner.stop();
    const statusStr = `[${status}]`.padEnd(14);
    const pubStr = `[${result.publishedStatus}]`.padEnd(12);
    console.log(`${statusStr} ${pubStr} ${newArticle.data.title}`);
    if (result.url && localArticles.length === 1) {
      console.log(chalk.cyan(`  → ${result.url}`));
    }
    if (errors.length > 0) {
      console.error(chalk.red(`  Error: ${errors.join(', ')}`));
    }
    spinner.start();

    // Stop on first error
    if (status === SyncStatus.failed || status === SyncStatus.imageOffline) {
      spinner.stop();
      console.error(chalk.red('\n❌ Stopping due to error. Fix the issue and retry.'));
      process.exitCode = -1;
      return results;
    }
  }

  return results;
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
    // Reload .env from current directory to get DEVTO_ORG and other local settings
    dotenv.config();
    debug('Loaded .env from %s', process.cwd());

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

    // Get organization info if useOrganization is enabled
    let orgInfo: { id: number; username: string } | null = null;
    if (options.useOrganization) {
      spinner.text = 'Getting organization info…';
      orgInfo = await getUserOrganizations(options.devtoKey);
      if (orgInfo) {
        debug('Will use organization: %s (ID: %s)', orgInfo.username, orgInfo.id);
        // Process all articles to set organization info
        let updatedCount = 0;
        for (const article of articles) {
          // Set organization only for articles that don't have it
          // '<none>' is an explicit choice by the author and should never be replaced
          if (!article.data.organization) {
            article.data.organization = orgInfo.username;
            if (!options.dryRun) {
              await saveArticleToFile(article);
            }
            updatedCount++;
          }

          // Resolve organization_id from organization name for API calls (not saved to file)
          // Skip if organization is explicitly set to '<none>'
          if (article.data.organization && article.data.organization !== '<none>') {
            const articleOrgId = await getOrganizationId(article.data.organization, options.devtoKey);
            if (articleOrgId) {
              article.data.organization_id = articleOrgId;
            }
          }
        }
        if (updatedCount > 0) {
          console.info(`Added organization ${chalk.cyan(orgInfo.username)} to ${chalk.green(updatedCount)} new article(s)`);
        }
      }
    }

    const remoteArticles = await getRemoteArticles(options.devtoKey);

    if (options.reconcile) {
      spinner.text = 'Reconciling articles…';
      articles = reconcileLocalArticles(remoteArticles, articles);
    }

    spinner.text = 'Pushing articles to dev.to…';
    const results = await processArticles(articles, remoteArticles, repository, branch, options, spinner);

    spinner.stop();

    // Don't show table at end since we already showed results during processing
    // console.error(formatErrors(results));
    // console.info(formatResultsTable(results));

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
