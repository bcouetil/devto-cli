// eslint-disable-next-line import/no-extraneous-dependencies
import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/commands', () => ({
  __esModule: true,
  init: jest.fn(),
  push: jest.fn(),
  createNew: jest.fn(),
  showStats: jest.fn(),
  generateDiagrams: jest.fn(),
  updateTableOfContents: jest.fn(),
  checkLinks: jest.fn(),
  rename: jest.fn(),
  badges: jest.fn()
}));

const { run } = await import('../src/cli');

function mockConsole() {
  const methods = ['log', 'info', 'warn', 'error'];
  const originalConsole = { ...console };
  for (const method of methods) {
    (console as any)[method] = jest.fn();
  }

  return () => {
    global.console = originalConsole;
  };
}

describe('devto CLI', () => {
  let restoreConsole: Function;

  beforeEach(() => {
    restoreConsole = mockConsole();
  });

  afterEach(() => {
    restoreConsole();
  });

  it('should display help', async () => {
    await run(['--help']);
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/^Usage/));
  });

  it('should display version', async () => {
    await run(['--version']);
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/^\d+/));
  });

  it('should run init command', async () => {
    const { init } = await import('../src/commands');
    await run(['init', '--token=123', '--repo=git/repo', '--pull', '--skip-git']);
    expect(init).toHaveBeenCalledWith({
      devtoKey: '123',
      repo: 'git/repo',
      pull: true,
      skipGit: true
    });
  });

  it('should run push command', async () => {
    const { push } = await import('../src/commands');
    await run(['push', 'posts/*.md', '--token=123', '--repo=git/repo', '--dry-run', '--reconcile', '--check-img']);
    expect(push).toHaveBeenCalledWith(['posts/*.md'], {
      devtoKey: '123',
      repo: 'git/repo',
      branch: undefined,
      dryRun: true,
      reconcile: true,
      checkImages: true,
      useOrganization: true,
      updateToc: false
    });
  });

  it('should run new command', async () => {
    const { createNew } = await import('../src/commands');
    await run(['new', 'article']);
    // token comes from process.env.DEVTO_TOKEN when not provided via --token
    expect(createNew).toHaveBeenCalledWith('article', process.env.DEVTO_TOKEN);
  });

  it('should run stats command', async () => {
    const { showStats } = await import('../src/commands');
    await run(['stats', '--token=123', '--number=20']);
    expect(showStats).toHaveBeenCalledWith({
      devtoKey: '123',
      number: 20,
      json: false
    });
  });
});
