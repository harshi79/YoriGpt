"use client";

import type { ThemeValue } from "./types";
import { isThemeValue } from "./types";

/**
 * Browser call for the theme preference. Only the theme travels: ownership,
 * validation, and the stored value are all decided by the server, and the server
 * never accepts a user id from the client.
 */

export type ThemeSaveResult =
  | { ok: true; theme: ThemeValue }
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

export async function requestThemePreference(theme: ThemeValue): Promise<ThemeSaveResult> {
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme }),
      credentials: "same-origin",
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const stored = (body as { theme?: unknown })?.theme;
      // The server's own answer is what the tab adopts; an unexpected shape is an error.
      if (isThemeValue(stored)) return { ok: true, theme: stored };
      return { ok: false, status: response.status, message: GENERIC_ERROR };
    }
    return {
      ok: false,
      status: response.status,
      message: await messageFrom(response, GENERIC_ERROR),
    };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}
