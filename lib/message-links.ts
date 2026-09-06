export function messageLinks(text: string) {
  const parts: { text: string; href?: string }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let candidate = match[0].replace(/[.,!?;:]+$/, '');
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        candidate.endsWith(close) &&
        candidate.split(close).length > candidate.split(open).length
      )
        candidate = candidate.slice(0, -1);
    }
    try {
      const url = new URL(candidate);
      if (!url.hostname || !['https:', 'http:'].includes(url.protocol))
        continue;
      if (match.index > cursor)
        parts.push({ text: text.slice(cursor, match.index) });
      parts.push({ text: candidate, href: url.href });
      cursor = match.index + candidate.length;
    } catch {
      // Invalid URLs remain ordinary message text.
    }
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
