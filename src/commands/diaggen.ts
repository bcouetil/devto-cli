import Debug from 'debug';
import chalk from 'chalk';
import pMap from 'p-map';
import { getArticlesFromFiles, FrontmatterValidationError } from '../article.js';
import { generateDiagramsForArticle, getKrokiUrl } from '../diagram.js';
import { createSpinner } from '../spinner.js';
import { reportFrontmatterValidationError } from './push.js';

const debug = Debug('diaggen');

export type DiaggenOptions = {
  noCache?: boolean;
};

export async function generateDiagrams(filesGlob?: string[], options: DiaggenOptions = {}) {
  const spinner = createSpinner(debug);

  try {
    // Default to *.md if no files specified
    const patterns = filesGlob && filesGlob.length > 0 ? filesGlob : ['*.md'];

    spinner.start('Loading articles...');
    const articles = await getArticlesFromFiles(patterns);
    spinner.stop();

    if (articles.length === 0) {
      console.log(chalk.yellow('No articles found.'));
      return;
    }

    console.log(chalk.gray(`Kroki server: ${getKrokiUrl()} (fence language = diagram type; gitlab-ci and chart render locally)`));

    if (articles.length > 1) {
      console.log(chalk.blue(`Found ${articles.length} article(s), scanning for diagrams...\n`));
    }

    let generated = 0;
    let upToDate = 0;
    let articlesWithDiagrams = 0;

    await pMap(
      articles,
      async (article) => {
        try {
          spinner.start(`Processing ${article.file}...`);

          const diagramMap = await generateDiagramsForArticle(article, {
            noCache: options.noCache
          });
          const images = [...diagramMap.values()];
          const fresh = images.filter(image => !image.cached);
          const cached = images.filter(image => image.cached);

          spinner.stop();

          if (images.length === 0) {
            if (articles.length > 1) {
              console.log(chalk.gray(`- ${article.file}: no diagrams found`));
            }
            return;
          }

          articlesWithDiagrams++;
          generated += fresh.length;
          upToDate += cached.length;

          if (fresh.length === 0) {
            console.log(chalk.gray(`· ${article.file}: ${cached.length} diagram image(s) up-to-date`));
            return;
          }

          const suffix = cached.length > 0 ? chalk.gray(`, ${cached.length} up-to-date`) : '';
          console.log(chalk.green(`✓ ${article.file}: generated ${fresh.length} diagram image(s)`) + suffix);
          for (const image of fresh) {
            console.log(chalk.green(`  → ${image.imagePath}`));
          }
        } catch (error) {
          spinner.stop();
          console.error(chalk.red(`✗ ${article.file}: ${String(error)}`));
          debug('Error processing article: %s', error);
        }
      },
      { concurrency: 5 }
    );

    if (articles.length > 1 || articlesWithDiagrams > 0) {
      console.log();
      if (generated + upToDate > 0) {
        console.log(`Generated: ${chalk.green(generated)} | Up-to-date: ${chalk.gray(upToDate)}`);
      } else if (articles.length > 1) {
        console.log(chalk.yellow('No diagrams found in any articles.'));
      }
    }
  } catch (error) {
    spinner.stop();
    if (error instanceof FrontmatterValidationError) {
      reportFrontmatterValidationError(error);
      return;
    }
    console.error(chalk.red('Error:'), String(error));
    throw error;
  }
}
