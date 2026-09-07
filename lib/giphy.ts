export type Gif = {
  id: string;
  title: string;
  still: string;
  animated: string;
  width: number;
  height: number;
};
export const gifReference = (id: string) => 'https://giphy.com/gifs/' + id;
export function gifId(text: string): string | null {
  return (
    /^https:\/\/giphy\.com\/gifs\/([A-Za-z0-9]{1,64})$/.exec(
      text.trim(),
    )?.[1] || null
  );
}
export function mediaUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      /^media[0-9]*\.giphy\.com$/.test(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port
      ? value
      : '';
  } catch {
    return '';
  }
}
export function parseGif(value: unknown): Gif | null {
  const g = value as {
    id?: string;
    title?: string;
    images?: Record<string, { url?: string; width?: string; height?: string }>;
  };
  if (!g || typeof g.id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(g.id))
    return null;
  const still = mediaUrl(g.images?.fixed_width_still?.url);
  const animated = mediaUrl(g.images?.fixed_width?.url);
  if (!still || !animated) return null;
  return {
    id: g.id,
    title: typeof g.title === 'string' ? g.title.slice(0, 160) : 'GIF',
    still,
    animated,
    width: 200,
    height: Math.min(
      300,
      Math.max(60, Number(g.images?.fixed_width?.height) || 150),
    ),
  };
}
export async function giphyRequest(
  key: string,
  path: string,
  query: Record<string, string>,
  signal?: AbortSignal,
) {
  const url = new URL('https://api.giphy.com/v1/gifs' + path);
  url.search = new URLSearchParams({
    api_key: key,
    rating: 'pg-13',
    ...query,
  }).toString();
  const r = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!r.ok)
    throw new Error(
      r.status === 429
        ? 'GIF search limit reached. Try again later.'
        : 'GIPHY is unavailable. Please try again.',
    );
  return (await r.json()) as { data: unknown };
}
