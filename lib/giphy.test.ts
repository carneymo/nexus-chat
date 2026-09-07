import test from 'node:test';
import assert from 'node:assert/strict';
import { gifId, mediaUrl, parseGif, gifReference } from './giphy.ts';
void test('GIF references only recognize exact provider IDs, never arbitrary URLs', () => {
  assert.equal(gifId(gifReference('Abc123')), 'Abc123');
  for (const url of [
    'https://giphy.com.evil/gifs/Abc123',
    'https://giphy.com/gifs/Abc123?x=y',
    'javascript:alert(1)',
    'https://giphy.com/gifs/../x',
    'https://evil.com/gifs/Abc123',
  ])
    assert.equal(gifId(url), null);
});
void test('Provider media allowlist preserves query strings and rejects unsafe destinations', () => {
  const url =
    'https://media2.giphy.com/media/Abc/200w.gif?cid=test&rid=200w.gif';
  assert.equal(mediaUrl(url), url);
  for (const value of [
    'http://media.giphy.com/a',
    'https://media.giphy.com.evil/a',
    'https://evil.com/a',
    'https://user@media.giphy.com/a',
    'https://media.giphy.com:8443/a',
  ])
    assert.equal(mediaUrl(value), '');
  assert.equal(parseGif(null), null);
  assert.equal(
    parseGif({
      id: 'abc',
      images: { fixed_width: { url: 'https://evil.com/a' } },
    }),
    null,
  );
});

void test('GIF API surfaces rate limits and omits browser credentials', async (t) => {
  const { giphyRequest } = await import('./giphy.ts');
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, 'https://api.giphy.com');
    assert.equal(url.searchParams.get('rating'), 'pg-13');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    return new Response('{}', { status: 429 });
  });
  await assert.rejects(
    giphyRequest('synthetic-key', '/search', { q: 'victory' }),
    /limit reached/,
  );
});
