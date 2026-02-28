import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import fs from 'fs-extra';
import matter from 'gray-matter';
import { globby } from 'globby';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'with', 'of', 'in', 'on', 'at', 'by', 'from',
  'as', 'that', 'which', 'your', 'you', 'how', 'what', 'why', 'when', 'where',
  'who', 'and', 'or', 'is', 'are', 'it', 'i', 'my', 'we', 'our', 'its', 'be',
  'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'must', 'shall', 'this', 'these', 'those', 'am',
  'was', 'were', 'been', 'being', 'but', 'if', 'so', 'than', 'too', 'very',
  'just', 'about', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'any', 'both', 'while'
]);

// Map of category prefixes to words to filter from title (includes synonyms)
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  'k8s': ['k8s', 'kubernetes'],
  'gitlab': ['gitlab'],
  'git': ['git'],
  'misc': ['misc'],
};

/**
 * Generate a filename from an article title following the naming strategy:
 * 1. Remove leading emoji and colon separator (keep all words)
 * 2. Remove stop words, numbers, and category words
 * 3. Keep the first 5 remaining words
 * 4. Convert to kebab-case (lowercase, hyphens between words)
 * @param title The article title
 * @param categoryPrefix The category prefix from filename (e.g., "K8S", "GITLAB")
 */
export function generateNameFromTitle(title: string, categoryPrefix?: string): string {
  // Build category words to filter based on prefix
  const categoryWords = new Set<string>();
  if (categoryPrefix) {
    const key = categoryPrefix.toLowerCase();
    const synonyms = CATEGORY_SYNONYMS[key];
    if (synonyms) {
      for (const word of synonyms) {
        categoryWords.add(word);
      }
    } else {
      categoryWords.add(key);
    }
  }

  // Step 1: Remove leading emoji (any non-ASCII chars at the start) and replace ":" with space
  let processed = title
    .replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+\s*/u, '')
    .replace(/:/g, ' ')
    .trim();

  // Step 2: Extract words and filter
  const words = processed
    .split(/\s+/)
    .map(word => {
      return word
        .replace(/\//g, '-')  // CI/CD -> CI-CD, AWS/EKS -> AWS-EKS
        .replace(/[^a-zA-Z0-9-]/g, '')
        .toLowerCase();
    })
    .filter(word => {
      if (word.length === 0) return false;
      if (STOP_WORDS.has(word)) return false;
      if (categoryWords.has(word)) return false;
      if (/^\d+$/.test(word)) return false;  // Filter pure numbers
      return true;
    });

  // Step 3: Keep the first 5 words
  const selectedWords = words.slice(0, 5);

  // Step 4: Convert to kebab-case
  return selectedWords.join('-');
}

/**
 * Rename a file based on the article title, keeping the prefix before the last "_"
 */
export async function renameArticle(file: string, options?: { dryRun?: boolean }): Promise<void> {
  if (!file) {
    process.exitCode = -1;
    console.error(chalk.red('No file provided.'));
    return;
  }

  // Resolve the file path
  const filePath = path.resolve(file);

  if (!await fs.pathExists(filePath)) {
    process.exitCode = -1;
    console.error(chalk.red(`File not found: ${file}`));
    return;
  }

  // Read the article and extract title
  const content = await fs.readFile(filePath, 'utf8');
  const { data } = matter(content);

  if (!data.title) {
    process.exitCode = -1;
    console.error(chalk.red(`No title found in front matter: ${file}`));
    return;
  }

  // Get the current filename without extension
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);

  // Find the last underscore to preserve the prefix and extract category
  const lastUnderscoreIndex = basename.lastIndexOf('_');

  let categoryPrefix: string | undefined;
  let newBasename: string;

  if (lastUnderscoreIndex !== -1) {
    // Extract category (word between second-to-last and last underscore)
    const prefix = basename.slice(0, lastUnderscoreIndex);
    const secondLastUnderscoreIndex = prefix.lastIndexOf('_');
    if (secondLastUnderscoreIndex !== -1) {
      categoryPrefix = prefix.slice(secondLastUnderscoreIndex + 1);
    } else {
      categoryPrefix = prefix;
    }
  }

  // Generate new name from title, filtering category words
  const generatedName = generateNameFromTitle(data.title, categoryPrefix);
  if (!generatedName) {
    process.exitCode = -1;
    console.error(chalk.red(`Could not generate a name from title: ${data.title}`));
    return;
  }

  if (lastUnderscoreIndex !== -1) {
    // Keep everything up to and including the last underscore
    const prefixWithUnderscore = basename.slice(0, lastUnderscoreIndex + 1);
    newBasename = prefixWithUnderscore + generatedName;
  } else {
    // No underscore found, just use the generated name
    newBasename = generatedName;
  }

  const newFilePath = path.join(dir, newBasename + ext);

  // Check if the name would change
  if (filePath === newFilePath) {
    console.log(chalk.gray(`· ${file} (already named correctly)`));
    return;
  }

  // Check if target already exists
  if (await fs.pathExists(newFilePath)) {
    process.exitCode = -1;
    console.error(chalk.red(`Target file already exists: ${newBasename}${ext}`));
    return;
  }

  if (options?.dryRun) {
    console.log(chalk.yellow(`Would rename: ${basename}${ext}`));
    console.log(chalk.yellow(`         to: ${newBasename}${ext}`));
  } else {
    await fs.rename(filePath, newFilePath);
    console.log(chalk.green(`✓ Renamed: ${basename}${ext}`));
    console.log(chalk.green(`       to: ${newBasename}${ext}`));
  }
}

export async function rename(filesGlob: string[], options?: { dryRun?: boolean }): Promise<void> {
  if (filesGlob.length === 0) {
    process.exitCode = -1;
    console.error(chalk.red('No file(s) provided.'));
    console.error('Usage: dev rename <file|glob> [--dry-run]');
    return;
  }

  // Expand globs to get actual file paths
  const files: string[] = await globby(filesGlob);

  if (files.length === 0) {
    process.exitCode = -1;
    console.error(chalk.red('No matching files found.'));
    return;
  }

  for (const file of files) {
    await renameArticle(file, options);
  }
}
