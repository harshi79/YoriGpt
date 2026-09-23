// Static examples for the signed-out shell: not conversation records, model IDs, or
// AI output. The model selector no longer reads from here — it renders the real
// server-owned catalog (see src/server/ai/models/catalog.ts).
export const sampleConversation = {
  title: "A little inspiration",
  messages: [
    {
      id: "sample-user",
      role: "user",
      content: "A small idea can be the start of something good.",
    },
    {
      id: "sample-assistant",
      role: "assistant",
      content:
        "A little room to think. A new perspective. A place to start.\n\nThis is a static message example, showing how a longer reply will look in your conversation. No AI model generated this response.",
    },
  ],
} as const;
