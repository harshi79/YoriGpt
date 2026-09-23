"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { requestThemePreference } from "../client";
import { applyTheme } from "../theme-attribute";
import { THEME_DESCRIPTIONS, THEME_LABELS, THEME_VALUES, type ThemeValue, type UserSettings } from "../types";

/**
 * The appearance control on `/settings`. It shows the theme the server stored for
 * this account and saves a new one through `PUT /api/settings`; validation,
 * ownership, and persistence are the server's business.
 *
 * The choice is optimistic — shown immediately, confirmed by the server's answer,
 * and rolled back on failure — and `from` records the server value the choice was
 * made against, so a fresh server render (reload, navigation, or another tab)
 * always wins over a stale local guess.
 */
export function ThemePreference({ settings }: { settings: UserSettings }) {
  const router = useRouter();
  const selectId = useId();
  const hintId = useId();
  const [choice, setChoice] = useState<{ theme: ThemeValue; from: ThemeValue } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const theme =
    choice && choice.from === settings.theme ? choice.theme : settings.theme;

  const changeTheme = async (next: ThemeValue) => {
    if (next === theme) return;
    setChoice({ theme: next, from: settings.theme });
    setError(null);
    setSaving(true);

    const result = await requestThemePreference(next);
    setSaving(false);

    if (result.ok) {
      // Apply the confirmed value now, and keep the server's answer on screen.
      applyTheme(result.theme);
      setChoice({ theme: result.theme, from: settings.theme });
      router.refresh();
      return;
    }
    setChoice(null);
    if (result.status === 401) {
      router.push("/login");
      return;
    }
    setError(result.message);
  };

  // One short line, in plain words: what just happened, or what this choice does.
  const hint = error
    ? error
    : saving
      ? "Saving…"
      : settings.status === "error"
        ? "Couldn’t load your saved theme; showing the default"
        : THEME_DESCRIPTIONS[theme];

  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={selectId}>
        Theme
      </label>
      <div className="settings-select-wrap">
        <select
          id={selectId}
          aria-label="Theme preference"
          aria-describedby={hintId}
          value={theme}
          disabled={saving}
          onChange={(event) => void changeTheme(event.target.value as ThemeValue)}
        >
          {THEME_VALUES.map((value) => (
            <option key={value} value={value}>
              {THEME_LABELS[value]}
            </option>
          ))}
        </select>
        <Icon name="chevron" />
      </div>
      <p
        id={hintId}
        className={`settings-hint ${error ? "is-error" : ""}`}
        role={error ? "alert" : undefined}
      >
        {hint}
      </p>
    </div>
  );
}
