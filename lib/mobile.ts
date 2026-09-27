export type PhoneStatus = {
  configured: boolean;
  permission: boolean;
  enabled: boolean;
  token: string;
  error?: string;
};
declare global {
  interface Window {
    NexusAndroid?: { postMessage: (message: string) => void };
  }
}
export const isAndroidApp = () =>
  typeof window !== 'undefined' && Boolean(window.NexusAndroid);
export function phoneCommand(
  type: string,
  fields: Record<string, unknown> = {},
) {
  window.NexusAndroid?.postMessage(JSON.stringify({ type, ...fields }));
}
export type ConversationLink = {
  kind: 'peer' | 'channel' | 'invite';
  value: string;
  account?: string;
};
export function parseConversationLink(hash: string): ConversationLink | null {
  if (hash.length > 601 || !hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const kinds = (['peer', 'channel', 'invite'] as const).filter((key) =>
    params.has(key),
  );
  if (
    kinds.length !== 1 ||
    [...params.keys()].some((key) => ![kinds[0], 'account'].includes(key))
  )
    return null;
  const kind = kinds[0];
  const value = params.get(kind) || '';
  if (
    !value ||
    params.getAll(kind).length !== 1 ||
    params.getAll('account').length > 1
  )
    return null;
  if (kind === 'invite' && !/^[a-f0-9]{64}$/.test(value)) return null;
  if (kind === 'peer' && !/^[A-Za-z0-9-]{1,100}$/.test(value)) return null;
  if (
    kind === 'channel' &&
    (value.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value))
  )
    return null;
  const account = params.get('account') || undefined;
  if (account && !/^[A-Za-z0-9-]{1,100}$/.test(account)) return null;
  return { kind, value, account };
}
