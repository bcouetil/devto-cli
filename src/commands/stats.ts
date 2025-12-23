import process from 'node:process';
import Debug from 'debug';
import chalk from 'chalk';
import { table } from 'table';
import { getLastArticlesStats } from '../api.js';
import { scaleNumber } from '../util.js';
import { createSpinner } from '../spinner.js';

const debug = Debug('init');

type ShowStatsOptions = {
  devtoKey: string;
  number: number;
  json: boolean;
};

export async function showStats(options?: Partial<ShowStatsOptions>) {
  options = options ?? {};
  options.number = options.number || 10;
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

  const spinner = createSpinner(debug);

  try {
    spinner.text = 'Retrieving articles from dev.to…';
    spinner.start();
    const stats = await getLastArticlesStats(options.devtoKey, options.number);
    spinner.stop();

    if (stats.length === 0) {
      console.info(`No published articles found.`);
      return;
    }

    if (options.json) {
      console.info(stats);
      return;
    }

    const availableWidth = process.stdout.columns || 80;
    debug('availableWidth: %s', availableWidth);

    const rows = stats.map((a) => [
      new Date(a.date).toLocaleDateString(),
      a.title,
      scaleNumber(a.views),
      scaleNumber(a.reactions),
      scaleNumber(a.comments)
    ]);
    rows.unshift(['Date', 'Title', 'Views', 'Likes', 'Comm.']);
    const tableConfig: any = {
      drawHorizontalLine: (index: number, size: number) => index === 0 || index === 1 || index === size
    };
    if (availableWidth >= 80) {
      const maxTitleWidth = Math.max(availableWidth - 42, 8);
      tableConfig.columns = { 1: { truncate: Math.min(maxTitleWidth, availableWidth - 40), width: Math.min(maxTitleWidth, availableWidth - 40) } };
    }
    try {
      console.info(table(rows, tableConfig));
    } catch (tableError) {
      debug('Table error: %s', (tableError as Error).message);
      // Fallback without column config
      console.info(table(rows, {
        drawHorizontalLine: (index: number, size: number) => index === 0 || index === 1 || index === size
      }));
    }
  } catch (error) {
    spinner.stop();
    process.exitCode = -1;
    console.error(chalk.red(`Error while showing stats: ${(error as Error).message}`));
    debug('Full error: %O', error);
  }
}
