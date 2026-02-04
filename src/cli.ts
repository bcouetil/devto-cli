import process from 'node:process';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import debug from 'debug';
import minimist from 'minimist';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { init, createNew, push, showStats, generateDiagrams, updateTableOfContents, checkLinks, rename } from './commands/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Normalize file paths for cross-platform compatibility.
 * Removes leading .\ or ./ prefixes added by Windows tab completion.
 */
function normalizeFilePaths(files: string[]): string[] {
  return files.map(f => f.replace(/^\.[\\/]/, ''));
}

const help = `Usage: dev <init|new|push|stats|diaggen|toc|checklinks|rename> [options]

Commands:
  i, init               Init current dir as an article repository
    -p, --pull          Pull your articles from dev.to
    -s, --skip-git      Skip git repository init
  n, new <file>         Create new article
  r, rename <file>      Rename article file based on its title
    -d, --dry-run       Show what would be renamed without doing it
  d, diaggen [files]    Generate diagram images from code blocks [default: *.md]
  t, toc [files]        Update table of contents in articles [default: *.md]
  c, checklinks [files] Check for broken links in articles [default: *.md]
  p, push [files]       Push articles to dev.to [default: *.md]
    -d, --dry-run       Do not make actual changes on dev.to
    -e, --reconcile     Reconcile articles without id using their title
    --update-toc        Update table of contents before pushing
  s, stats              Display stats for your latest published articles
    -n, --number <n>    Number of articles to list stats for [default: 10]
    -j, --json          Format result as JSON

General options:
  -t, --token <token>   Use this dev.to API token
  -r, --repo <repo>     GitHub repository (in "user/repo" form)
  -b, --branch <branch> GitHub branch [default: master]
  -v, --version         Show version
  --verbose             Show detailed logs
  --help                Show this help
`;

export async function run(args: string[]) {
  const options = minimist(args, {
    string: ['token', 'repo', 'branch'],
    boolean: ['help', 'version', 'reconcile', 'dry-run', 'json', 'pull', 'skip-git', 'skip-check-images', 'verbose', 'update-toc'],
    alias: {
      v: 'version',
      e: 'reconcile',
      d: 'dry-run',
      n: 'number',
      t: 'token',
      j: 'json',
      p: 'pull',
      r: 'repo',
      b: 'branch',
      s: 'skip-git'
    }
  });

  if (options.version) {
    const pkg = await fs.readJSON(path.join(__dirname, '../package.json'));
    console.info(pkg.version);
    return;
  }

  if (options.help) {
    console.info(help);
    return;
  }

  if (options.verbose) {
    debug.enable('*');
  }

  if (!options.token) {
    dotenv.config();
    options.token = process.env.DEVTO_TOKEN;
  }

  const [command, ...parameters] = options._;
  switch (command) {
    case 'i':
    case 'init': {
      return init({
        devtoKey: options.token,
        repo: options.repo,
        branch: options.branch,
        pull: options.pull,
        skipGit: options['skip-git']
      });
    }

    case 'n':
    case 'new': {
      const file = parameters[0]?.replace(/^\.[\\/]/, '');
      return createNew(file, options.token);
    }

    case 'r':
    case 'rename': {
      return rename(normalizeFilePaths(parameters), {
        dryRun: options['dry-run']
      });
    }

    case 'd':
    case 'diaggen': {
      return generateDiagrams(normalizeFilePaths(parameters));
    }

    case 't':
    case 'toc': {
      return updateTableOfContents(normalizeFilePaths(parameters));
    }

    case 'c':
    case 'checklinks': {
      return checkLinks(normalizeFilePaths(parameters));
    }

    case 'p':
    case 'push': {
      return push(normalizeFilePaths(parameters), {
        devtoKey: options.token,
        repo: options.repo,
        useOrganization: options['use-organization'] !== false,
        branch: options.branch,
        dryRun: options['dry-run'],
        reconcile: options.reconcile,
        checkImages: !options['skip-check-images'],
        updateToc: options['update-toc']
      });
    }

    case 's':
    case 'stats': {
      return showStats({
        devtoKey: options.token,
        number: options.number,
        json: options.json
      });
    }

    default: {
      console.log(help);
    }
  }
}
