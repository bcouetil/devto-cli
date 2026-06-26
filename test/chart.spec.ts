const { calculateChecksum, extractDiagrams } = await import('../src/diagram');
const { parseChartBlock, parseChartAttrs, buildChartHTML } = await import('../src/chart');

const CHART_CSV = `bar,x-type=category,x-label='Stage',y-label='Intensity (0-10)',y-range=0_10
x,E3,E4,E5
Self-certainty,6,7,6
Need for recognition,5,8,10`;

const ARTICLE_WITH_CHART = `# Title

Some intro.

<!-- diagram-name: at-work -->
\`\`\`chart
${CHART_CSV}
\`\`\`

More content.`;

const ARTICLE_CHART_NO_NAME = `# Title

\`\`\`chart
${CHART_CSV}
\`\`\``;

const STACKED_CHART = `bar,x-type=category,x-label='Stage',y-label='Mode share (%)',y-range=0_100,stacked=true
x,E3,E4
Pleasure / Security,80,55
Action / Mastery,15,30`;

describe('chart diagram extraction', () => {
  it('should extract chart block with diagram-name comment', () => {
    const diagrams = extractDiagrams(ARTICLE_WITH_CHART);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].type).toBe('chart');
    expect(diagrams[0].name).toBe('at-work');
    expect(diagrams[0].content).toContain('Self-certainty');
  });

  it('should default chart block name to "chart" when no diagram-name is given', () => {
    const diagrams = extractDiagrams(ARTICLE_CHART_NO_NAME);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].name).toBe('chart');
  });

  it('should include diagram-name comment in originalText', () => {
    const diagrams = extractDiagrams(ARTICLE_WITH_CHART);
    expect(diagrams[0].originalText).toContain('<!-- diagram-name: at-work -->');
    expect(diagrams[0].originalText).toContain('```chart');
  });

  it('should not extract chart when no chart block is present', () => {
    const diagrams = extractDiagrams('# Just markdown\n\nNo diagrams here.');
    expect(diagrams).toHaveLength(0);
  });
});

describe('chart block parsing', () => {
  it('should split attrs line and CSV body', () => {
    const { attrsStr, csvContent } = parseChartBlock(CHART_CSV);
    expect(attrsStr).toBe("bar,x-type=category,x-label='Stage',y-label='Intensity (0-10)',y-range=0_10");
    expect(csvContent).toContain('Self-certainty,6,7,6');
  });

  it('should parse stacked=true and area-spline type', () => {
    const stacked = parseChartAttrs('bar,x-type=category,stacked=true');
    expect(stacked.stacked).toBe('true');

    const area = parseChartAttrs("area-spline,x-label='Stage',y-range=0_100");
    expect(area.type).toBe('area-spline');
    expect(area['x-label']).toBe('Stage');
  });

  it('should strip quotes from attribute values', () => {
    const attrs = parseChartAttrs("bar,x-label='Stage',y-label=\"Intensity\"");
    expect(attrs['x-label']).toBe('Stage');
    expect(attrs['y-label']).toBe('Intensity');
  });

  it('should build HTML with groups for stacked charts', () => {
    const html = buildChartHTML(STACKED_CHART.split('\n')[0], STACKED_CHART.split('\n').slice(1).join('\n'));
    expect(html).toContain("groups: [['Pleasure / Security', 'Action / Mastery']]");
    expect(html).toContain("type: 'bar'");
  });
});

describe('chart checksum', () => {
  it('should produce consistent checksums for same content', () => {
    const a = calculateChecksum(CHART_CSV);
    const b = calculateChecksum(CHART_CSV);
    expect(a).toBe(b);
    expect(a).toHaveLength(7);
  });

  it('should produce different checksums for different content', () => {
    const a = calculateChecksum(CHART_CSV);
    const b = calculateChecksum(CHART_CSV + '\nExtra,1,2,3');
    expect(a).not.toBe(b);
  });
});
