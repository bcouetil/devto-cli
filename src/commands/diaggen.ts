import Debug from 'debug';
import chalk from 'chalk';
import pMap from 'p-map';
import { getArticlesFromFiles } from '../article.js';
import { generateDiagramsForArticle } from '../diagram.js';
import { createSpinner } from '../spinner.js';

const debug = Debug('diaggen');

export type DiaggenOptions = {
  files?: string[];
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

    console.log(chalk.blue(`Found ${articles.length} article(s), scanning for diagrams...\n`));

    let totalDiagrams = 0;
    let processedArticles = 0;

    await pMap(
      articles,
      async (article) => {
        try {
          spinner.start(`Processing ${article.file}...`);

          const diagramMap = await generateDiagramsForArticle(article);
          const diagramCount = diagramMap.size;

          spinner.stop();

          if (diagramCount > 0) {
            console.log(
              chalk.green(`✓ ${article.file}: generated ${diagramCount} diagram image(s)`)
            );
            totalDiagrams += diagramCount;
            processedArticles++;
          } else {
            console.log(chalk.gray(`- ${article.file}: no diagrams found`));
          }
        } catch (error) {
          spinner.stop();
          console.error(chalk.red(`✗ ${article.file}: ${String(error)}`));
          debug('Error processing article: %s', error);
        }
      },
      { concurrency: 5 }
    );

    console.log();
    if (totalDiagrams > 0) {
      console.log(
        chalk.green.bold(
          `✓ Successfully generated ${totalDiagrams} diagram image(s) from ${processedArticles} article(s)`
        )
      );
    } else {
      console.log(chalk.yellow('No diagrams found in any articles.'));
    }
  } catch (error) {
    spinner.stop();
    console.error(chalk.red('Error:'), String(error));
    throw error;
  }
}
