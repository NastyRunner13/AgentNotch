const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('renderMarkdownLite table rendering', () => {
  it('parses and renders a standard markdown table into HTML table structure', async () => {
    const { renderMarkdownLite } = await import('../src/renderer/components/session-card.js');

    const input = `3. What gets charted (15 PNGs per run)
| # | Chart |
|---|--------|
| 01 | Summary dashboard (trades, WR, avg R) |
| 02–06 | Win rate / avg R / PF / return |`;

    const html = renderMarkdownLite(input);

    assert.ok(html.includes('<div class="md-table-wrapper">'));
    assert.ok(html.includes('<table class="md-table">'));
    assert.ok(html.includes('<th>#</th>'));
    assert.ok(html.includes('<th>Chart</th>'));
    assert.ok(html.includes('<td>01</td>'));
    assert.ok(html.includes('<td>Summary dashboard (trades, WR, avg R)</td>'));
    assert.ok(html.includes('<td>02–06</td>'));
  });

  it('respects table alignments and inline formatting inside table cells', async () => {
    const { renderMarkdownLite } = await import('../src/renderer/components/session-card.js');

    const input = `| Left | Center | Right |
| :--- | :---: | ---: |
| **bold** | \`code\` | *italic* |`;

    const html = renderMarkdownLite(input);

    assert.ok(html.includes('<th style="text-align:left">Left</th>'));
    assert.ok(html.includes('<th style="text-align:center">Center</th>'));
    assert.ok(html.includes('<th style="text-align:right">Right</th>'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<code class="md-inline">code</code>'));
    assert.ok(html.includes('<em>italic</em>'));
  });
});
