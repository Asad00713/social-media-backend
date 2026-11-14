import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('escapes the five characters that can break out of text or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes an ampersand once, not twice', () => {
    expect(escapeHtml('a &amp; b')).toBe('a &amp;amp; b');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('Acme Q4 review')).toBe('Acme Q4 review');
  });
});
