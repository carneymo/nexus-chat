type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Intent = { digest: string; nonce: string };

/** Persist identifiers, not message contents, for explicit retries after Android process death. */
export async function mobileSendIntent(
  storage: StorageLike,
  account: string,
  key: string,
): Promise<Intent> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  const digest = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const storageKey = `nexus-send:${account}`;
  let entries: Intent[] = [];
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) || '[]');
    if (Array.isArray(value))
      entries = value
        .filter(
          (entry): entry is Intent =>
            entry &&
            typeof entry.digest === 'string' &&
            /^[a-f0-9]{64}$/.test(entry.digest) &&
            typeof entry.nonce === 'string' &&
            /^[a-zA-Z0-9-]{16,80}$/.test(entry.nonce),
        )
        .slice(-32);
  } catch {
    /* Corrupt/disabled optional storage starts a fresh intent. */
  }
  const prior = entries.find((entry) => entry.digest === digest);
  if (prior) return prior;
  const intent = { digest, nonce: crypto.randomUUID() };
  try {
    storage.setItem(
      storageKey,
      JSON.stringify([...entries.slice(-31), intent]),
    );
  } catch {
    /* In-memory retries still work. */
  }
  return intent;
}

export function acknowledgeMobileSend(
  storage: StorageLike,
  account: string,
  nonce: string,
  draftScope: string,
) {
  try {
    // Clear the persisted draft before releasing its retry identity.
    if (draftScope) storage.removeItem(draftScope);
    const key = `nexus-send:${account}`;
    const entries: unknown = JSON.parse(storage.getItem(key) || '[]');
    if (Array.isArray(entries))
      storage.setItem(
        key,
        JSON.stringify(entries.filter((entry) => entry?.nonce !== nonce)),
      );
  } catch {
    /* A successful server acknowledgement must not become a failed send. */
  }
}
