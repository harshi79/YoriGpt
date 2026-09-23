"use client";

/**
 * Browser call for the persisted pet companion. Only the pet key travels: ownership,
 * validation, and the stored value are decided by the server (`/api/settings/pet`),
 * which never accepts a user id from the client.
 *
 * Used by the `/pets` playground when a signed-in user chooses a companion. An
 * anonymous visitor never calls this — the playground keeps the choice local.
 */

export type PetSaveResult =
  | { ok: true; pet: string }
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

export async function requestPetSelection(pet: string): Promise<PetSaveResult> {
  try {
    const response = await fetch("/api/settings/pet", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pet }),
      credentials: "same-origin",
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const stored = (body as { pet?: unknown })?.pet;
      // The server's own answer is what the tab adopts; an unexpected shape is an error.
      if (typeof stored === "string" && stored !== "") return { ok: true, pet: stored };
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

export type PetPersonalitySaveResult =
  | { ok: true; pet: string; personality: string }
  | { ok: false; status: number; message: string };

/**
 * Sends exactly one field — `personality` — to the nested personality route. The
 * server validates it against the user's selected pet and never accepts a user id from
 * the client; only stable personality ids cross the wire, never a personality object.
 */
export async function requestPetPersonality(
  personality: string,
): Promise<PetPersonalitySaveResult> {
  try {
    const response = await fetch("/api/settings/pet/personality", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personality }),
      credentials: "same-origin",
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const candidate = body as { pet?: unknown; personality?: unknown };
      if (typeof candidate?.pet === "string" && typeof candidate.personality === "string" &&
        candidate.pet !== "" && candidate.personality !== "") {
        return { ok: true, pet: candidate.pet, personality: candidate.personality };
      }
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

export type PetAppearanceSaveResult =
  | { ok: true; pet: string; appearance: string }
  | { ok: false; status: number; message: string };

/**
 * Sends exactly one field — `appearance` — to the nested appearance route. The server
 * validates it against the user's selected pet and never accepts a user id from the
 * client; only stable appearance ids cross the wire.
 */
export async function requestPetAppearance(
  appearance: string,
): Promise<PetAppearanceSaveResult> {
  try {
    const response = await fetch("/api/settings/pet/appearance", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appearance }),
      credentials: "same-origin",
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const candidate = body as { pet?: unknown; appearance?: unknown };
      if (typeof candidate?.pet === "string" && typeof candidate.appearance === "string" &&
        candidate.pet !== "" && candidate.appearance !== "") {
        return { ok: true, pet: candidate.pet, appearance: candidate.appearance };
      }
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
