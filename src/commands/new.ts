import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import { createNewArticle } from '../article.js';
import { getUserOrganizations } from '../api.js';

export async function createNew(file?: string, devtoKey?: string) {
  if (!file) {
    process.exitCode = -1;
    console.error(chalk.red(`red No file name provided.`));
    return;
  }

  const newFile = path.extname(file).toLowerCase() === '.md' ? file : file + '.md';
  if (await fs.pathExists(newFile)) {
    process.exitCode = -1;
    console.error(chalk.red(`File "${newFile}" already exists.`));
    return;
  }

  try {
    // Try to get organization username from environment
    dotenv.config();
    const organization = process.env.DEVTO_ORG || null;

    await createNewArticle(newFile, organization);
    console.info(`Created ${chalk.green(newFile)}.`);
    if (organization) {
      console.info(`  Organization: ${chalk.cyan(organization)}`);
    }
  } catch (error) {
    process.exitCode = -1;
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    console.error('New article creation failed.');
  }
}
