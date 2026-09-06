type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: object;
      execute: (input: unknown) => unknown;
    },
    options: { signal: AbortSignal },
  ) => unknown;
};
export function registerDraftTool(setDraft: (text: string) => void) {
  const context = (document as Document & { modelContext?: ModelContext })
    .modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(
      context.registerTool(
        {
          name: 'stage_chat_message',
          description:
            'Stage text in the visible chat composer for review. Does not send the message.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2000 },
            },
            required: ['text'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            const text = (input as { text?: unknown } | null)?.text;
            if (typeof text !== 'string' || !text.trim() || text.length > 2000)
              throw new Error('Provide 1–2000 characters.');
            setDraft(text);
            return { status: 'staged', characters: text.length };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
  } catch {
    /* Optional browser capability. */
  }
  return () => lifecycle.abort();
}
