const { calculateChecksum, extractDiagrams } = await import('../src/diagram');

const GCL_CSV = `name;stage;when;allowFailure;needs
back-package;package;on_success;false;
front-package;package;on_success;false;
secret-scan;test;on_success;true;
back-test;test;on_success;false;[back-package]
release;deploy;manual;false;[]`;

const ARTICLE_WITH_GCL = `# Title

Some intro.

<!-- diagram-name: my-pipeline -->
\`\`\`gitlab-ci
${GCL_CSV}
\`\`\`

More content.`;

const ARTICLE_GCL_NO_NAME = `# Title

\`\`\`gitlab-ci
${GCL_CSV}
\`\`\``;

describe('gitlab-ci diagram extraction', () => {
  it('should extract gitlab-ci block with diagram-name comment', () => {
    const diagrams = extractDiagrams(ARTICLE_WITH_GCL);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].type).toBe('gitlab-ci');
    expect(diagrams[0].name).toBe('my-pipeline');
    expect(diagrams[0].content).toContain('back-package');
  });

  it('should default gitlab-ci block name to "pipeline" when no diagram-name is given', () => {
    const diagrams = extractDiagrams(ARTICLE_GCL_NO_NAME);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].name).toBe('pipeline');
  });

  it('should include diagram-name comment in originalText', () => {
    const diagrams = extractDiagrams(ARTICLE_WITH_GCL);
    expect(diagrams[0].originalText).toContain('<!-- diagram-name: my-pipeline -->');
    expect(diagrams[0].originalText).toContain('```gitlab-ci');
  });

  it('should not extract gitlab-ci when no gitlab-ci block is present', () => {
    const diagrams = extractDiagrams('# Just markdown\n\nNo diagrams here.');
    expect(diagrams).toHaveLength(0);
  });

  it('should not default mermaid block name to "pipeline"', () => {
    const diagrams = extractDiagrams('# Title\n\n```mermaid\ngraph TD\n  A --> B\n```');
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].name).toBe('unknown');
  });
});

describe('gitlab-ci checksum', () => {
  it('should produce consistent checksums for same content', () => {
    const a = calculateChecksum(GCL_CSV);
    const b = calculateChecksum(GCL_CSV);
    expect(a).toBe(b);
    expect(a).toHaveLength(7);
  });

  it('should produce different checksums for different content', () => {
    const a = calculateChecksum(GCL_CSV);
    const b = calculateChecksum(GCL_CSV + '\nextra-job;stage;on_success;false;');
    expect(a).not.toBe(b);
  });

  it('should normalize line endings for consistent checksums', () => {
    const unix = calculateChecksum('a\nb\nc');
    const windows = calculateChecksum('a\r\nb\r\nc');
    expect(unix).toBe(windows);
  });
});
