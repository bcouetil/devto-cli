import { generateDevToAnchor, updateToc, needsTocUpdate, generateTocOnly } from '../src/toc.js';

describe('generateDevToAnchor', () => {
  it('should convert basic heading to anchor', () => {
    expect(generateDevToAnchor('Hello World')).toBe('hello-world');
  });

  it('should remove punctuation', () => {
    expect(generateDevToAnchor("It's awesome!")).toBe('its-awesome');
  });

  it('should handle ampersand', () => {
    expect(generateDevToAnchor('Hello & goodbye')).toBe('hello-amp-goodbye');
  });

  it('should strip markdown links', () => {
    expect(generateDevToAnchor('Check out [bitdowntoc](https://example.com)')).toBe('check-out-bitdowntoc');
  });

  it('should handle inline code with HTML', () => {
    expect(generateDevToAnchor('Code: `<tag>` here')).toBe('code-raw-lttaggt-endraw-here');
  });

  it('should handle bold/italic with underscores', () => {
    expect(generateDevToAnchor('Some __bold__ text')).toBe('some-bold-text');
  });

  it('should handle quotes', () => {
    expect(generateDevToAnchor('"Hello" means \'Bonjour\'')).toBe('hello-means-bonjour');
  });

  it('should concatenate multiple spaces/dashes', () => {
    expect(generateDevToAnchor('Hello   World')).toBe('hello-world');
  });
});

describe('needsTocUpdate', () => {
  it('should return true for content with [TOC] marker', () => {
    expect(needsTocUpdate('# Title\n\n[TOC]\n\n## Section')).toBe(true);
  });

  it('should return true for content with Liquid TOC start', () => {
    const content = '# Title\n\n{%- # TOC start -%}\n- item\n{%- # TOC end -%}\n\n## Section';
    expect(needsTocUpdate(content)).toBe(true);
  });

  it('should return false for content without TOC', () => {
    expect(needsTocUpdate('# Title\n\n## Section')).toBe(false);
  });
});

describe('generateTocOnly', () => {
  it('should generate TOC from headers', () => {
    const content = '# Title\n\n## Section 1\n\n### Subsection\n\n## Section 2';
    const toc = generateTocOnly(content);
    expect(toc).toContain('[Title](#title)');
    expect(toc).toContain('[Section 1](#section-1)');
    expect(toc).toContain('[Subsection](#subsection)');
    expect(toc).toContain('[Section 2](#section-2)');
  });

  it('should skip headers inside code blocks', () => {
    const content = '# Title\n\n```\n## Not a header\n```\n\n## Real Section';
    const toc = generateTocOnly(content);
    expect(toc).toContain('[Title](#title)');
    expect(toc).toContain('[Real Section](#real-section)');
    expect(toc).not.toContain('Not a header');
  });
});

describe('updateToc', () => {
  it('should insert TOC after front matter', () => {
    const content = '---\ntitle: Test\n---\n\n# Title\n\n## Section';
    const result = updateToc(content);
    expect(result).toContain('{%- # TOC start');
    expect(result).toContain('[Title](#title)');
    expect(result).toContain('[Section](#section)');
    expect(result).toContain('{%- # TOC end -%}');
  });

  it('should replace existing TOC', () => {
    const content = '---\ntitle: Test\n---\n\n{%- # TOC start -%}\n\n- old\n\n{%- # TOC end -%}\n\n# Title\n\n## Section';
    const result = updateToc(content);
    expect(result).not.toContain('- old');
    expect(result).toContain('[Title](#title)');
  });
});
