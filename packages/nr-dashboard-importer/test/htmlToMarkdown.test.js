import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/htmlToMarkdown.js';

describe('htmlToMarkdown', () => {
  it('converts <b> to bold markdown', () => {
    expect(htmlToMarkdown('<b>Money in</b>')).toBe('**Money in**');
  });

  it('converts an http(s) link to a markdown link', () => {
    expect(htmlToMarkdown('<a href="https://example.com">Docs</a>')).toBe(
      '[Docs](https://example.com)',
    );
  });

  it('keeps a relative link as a markdown link', () => {
    expect(htmlToMarkdown('<a href="/app/x/board">Board</a>')).toBe(
      '[Board](/app/x/board)',
    );
  });

  it('drops a <head><style> CSS block, keeping only the visible text', () => {
    const md = htmlToMarkdown(
      '<head><style>.k{color:red}</style></head><p>Status OK</p>',
    );
    expect(md).toBe('Status OK');
  });

  it('drops a <script> block', () => {
    expect(htmlToMarkdown('<script>alert(1)</script><p>Hi</p>')).toBe('Hi');
  });

  it('converts a styled div header to its bold text', () => {
    expect(
      htmlToMarkdown('<div style="background:#003352"><b>Totals:</b></div>'),
    ).toBe('**Totals:**');
  });

  it('converts a paragraph with a relative link', () => {
    expect(
      htmlToMarkdown('<p>See <a href="/app/x/board">the board</a></p>'),
    ).toBe('See [the board](/app/x/board)');
  });

  it('returns empty string for an empty body', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('returns empty string for a whitespace-only body', () => {
    expect(htmlToMarkdown('   \n  ')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(htmlToMarkdown(undefined)).toBe('');
  });

  // --- Clean conversions a Splunk panel commonly has ---

  it('converts an <h2> heading to ATX form', () => {
    expect(htmlToMarkdown('<h2>System Health</h2>')).toBe('## System Health');
  });

  it('converts an unordered list to bullet items', () => {
    // turndown 7.2.4 uses `*` as its default unordered-list marker.
    expect(htmlToMarkdown('<ul><li>One</li><li>Two</li></ul>')).toBe(
      '*   One\n*   Two',
    );
  });

  it('converts an ordered list to numbered items', () => {
    expect(htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>')).toBe(
      '1.  First\n2.  Second',
    );
  });

  it('converts an image to markdown image syntax', () => {
    expect(
      htmlToMarkdown('<img src="https://x.example/a.png" alt="Chart">'),
    ).toBe('![Chart](https://x.example/a.png)');
  });

  it('decodes HTML entities in text to their literal characters', () => {
    expect(htmlToMarkdown('<p>Cost &amp; risk &lt; threshold</p>')).toBe(
      'Cost & risk < threshold',
    );
  });

  it('converts a <br> into a hard line break', () => {
    expect(htmlToMarkdown('<p>Line one<br>Line two</p>')).toBe(
      'Line one  \nLine two',
    );
  });

  // --- Things Splunk renders that DON'T convert cleanly ---

  it('flattens a table to its cell text rather than a pipe-table', () => {
    // Documented limitation: turndown has no GFM-table plugin here, so a
    // <table> becomes inline text, not a Markdown pipe-table.
    const md = htmlToMarkdown(
      '<table><tr><th>Region</th><th>Hits</th></tr>' +
        '<tr><td>North</td><td>42</td></tr></table>',
    );
    expect(md).toContain('North');
    expect(md).toContain('42');
    expect(md).not.toContain('---|');
    expect(md).not.toContain('|---');
  });

  it('passes a Splunk dashboard token through literally', () => {
    // Deliberate: dashboard-token ($tok$ -> {{tok}}) conversion is not done
    // in markdown bodies; the token text is preserved verbatim.
    const md = htmlToMarkdown('<p>App: $env:app$</p>');
    expect(md).toContain('$env:app$');
    expect(md).not.toContain('{{');
  });

  // --- Robustness / safety ---

  it('does not throw on malformed/unclosed HTML', () => {
    expect(() => htmlToMarkdown('<p>Half <b>bold')).not.toThrow();
    const md = htmlToMarkdown('<p>Half <b>bold');
    expect(md).toContain('Half');
    expect(md).toContain('bold');
  });

  it('drops an HTML comment but keeps the visible text after it', () => {
    const md = htmlToMarkdown('<!-- hidden --><p>Visible</p>');
    expect(md).toBe('Visible');
  });

  it('strips event-handler attributes from a link', () => {
    // Security-relevant: turndown keeps only href + text, dropping attributes
    // like onclick. The module does no scheme/attribute filtering of its own.
    const md = htmlToMarkdown(
      '<a href="https://x.example" onclick="steal()">Link</a>',
    );
    expect(md).toBe('[Link](https://x.example)');
    expect(md).not.toContain('onclick');
    expect(md).not.toContain('steal');
  });
});
