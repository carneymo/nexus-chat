import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageLinks } from './message-links.ts';

void test('links preserve text, punctuation, balanced parentheses and multiple URLs', () => {
  const text =
    'See (https://example.com/page), then https://example.org/a_(b).\nDone.';
  const parts = messageLinks(text);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(
    parts.filter((part) => part.href).map((part) => part.href),
    ['https://example.com/page', 'https://example.org/a_(b)'],
  );
});
void test('HTML and executable schemes remain plain text; invalid URLs do not link', () => {
  const text =
    '<script>alert(1)</script> javascript:alert(1) data:text/html,test https://';
  assert.deepEqual(messageLinks(text), [{ text }]);
});
