"use client";

/**
 * Browser call for the model preference. Only the catalog key travels: ownership,
 * catalog membership, and the stored value are all decided by the server.
 */

export type ModelSelectionResult =
  | { ok: true; selectedKey: string }
  | { ok: false; status: number; message: string };

const GENERIC_ERROR = "Something went wrong. Try again.";
const OFFLINE_ERROR = "We couldn’t reach the server. Check your connection and try again.";

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } })?.error?.message;
    return typeof message === "string" && message.trim() !== "" ? message : fallback;
  } catch {
    return fallback;
  }
}

export async function requestModelSelection(modelKey: string): Promise<ModelSelectionResult> {
  try {
    const response = await fetch("/api/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelKey }),
      credentials: "same-origin",
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const selectedKey = (body as { selectedModelKey?: unknown })?.selectedModelKey;
      if (typeof selectedKey === "string") return { ok: true, selectedKey };
      return { ok: false, status: response.status, message: GENERIC_ERROR };
    }
    return { ok: false, status: response.status, message: await messageFrom(response, GENERIC_ERROR) };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}
