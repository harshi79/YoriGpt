/**
 * Wire and render shapes for the model selector. Runtime-free, so the server page
 * and the client component share one contract.
 *
 * A model is identified by its **catalog key** — a stable server-side name. The
 * OpenRouter identifier stays on the server; the browser never sends or receives
 * one, and the API rejects any key that is not in the server catalog.
 */

/** One selectable model, exactly as the selector needs it. */
export type ModelOption = {
  /** Stable catalog key, e.g. `gpt-4o-mini`. */
  key: string;
  /** Display name, e.g. `GPT-4o mini`. */
  name: string;
  /** One short line describing the model. */
  description: string;
};

/** What the chat header renders: the offered models and the current selection. */
export type ModelSelection = {
  /**
   * `anonymous` means nobody is signed in (the catalog is listed with the default,
   * and choosing one routes to sign-in), `error` means the saved preference could
   * not be read — the default is displayed and the selector says so instead of
   * pretending it was chosen.
   */
  status: "ready" | "anonymous" | "error";
  models: ModelOption[];
  /** The key currently shown as selected. Always one of the catalog keys. */
  selectedKey: string;
};
