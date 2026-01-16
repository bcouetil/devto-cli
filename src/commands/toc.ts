import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';
import chalk from 'chalk';
import { globby } from 'globby';
import { updateToc, needsTocUpdate } from '../toc.js';

export async function updateTableOfContents(files?: string[]): Promise<void> {
  const globs = files && files.length > 0 ? files : ['*.md'];
  const matchingFiles = await globby(globs);

  if (matchingFiles.length === 0) {
    console.log(chalk.yellow('No markdown files found'));
    return;
  }

  let updatedCount = 0;
  let upToDateCount = 0;
  let noMarkersCount = 0;

  for (const file of matchingFiles) {
    const filePath = path.resolve(process.cwd(), file);

    try {
      const content = await fs.readFile(filePath, 'utf8');

      if (!needsTocUpdate(content)) {
        console.log(chalk.yellow(`⚠ ${file} (no TOC markers)`));
        noMarkersCount++;
        continue;
      }

      const updatedContent = updateToc(content);

      if (updatedContent !== content) {
        await fs.writeFile(filePath, updatedContent, 'utf8');
        console.log(chalk.green(`✓ ${file}`));
        updatedCount++;
      } else {
        console.log(chalk.gray(`· ${file} (up-to-date)`));
        upToDateCount++;
      }
    } catch (error) {
      console.error(chalk.red(`✗ ${file}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  console.log('');
  console.log(`Updated: ${chalk.green(updatedCount)} | Up-to-date: ${chalk.gray(upToDateCount)} | No markers: ${chalk.yellow(noMarkersCount)}`);
}
