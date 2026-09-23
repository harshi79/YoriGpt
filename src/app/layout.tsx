import type { Metadata } from "next";
import "./globals.css";
import { getCurrentUser } from "@/server/auth/session";
import { loadThemePreference } from "@/server/settings/view";
import { THEME_BOOTSTRAP_SCRIPT } from "@/features/settings/theme-attribute";

export const metadata: Metadata = {
  title: "YoriGPT",
  description: "A little space for big ideas. YoriGPT chat interface preview.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  /**
   * The stored theme of the signed-in user (the documented default for everybody
   * else) is rendered on `<html>` before anything is painted, so the palette is
   * right on first load, on reload, and on every route — the stylesheet keys off
   * this attribute, and no page has to ask for it again. The inline script only
   * resolves `system` against the device preference and keeps following it.
   *
   * `suppressHydrationWarning` is required because that script updates the
   * attribute before React hydrates; it applies to this element only.
   */
  const theme = await loadThemePreference(await getCurrentUser());

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
