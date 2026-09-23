import type { Metadata } from "next";
import Link from "next/link";
import { YoriMark } from "@/components/ui/icon";
import { ThemePreference } from "@/features/settings/components/theme-preference";
import { DEFAULT_THEME, THEME_LABELS } from "@/features/settings/types";
import { requireUser } from "@/server/auth/session";
import { loadSettings } from "@/server/settings/view";

export const metadata: Metadata = {
  title: "Settings · YoriGPT",
  description: "Your YoriGPT appearance preference and account details.",
};

/**
 * Account settings. Signed-in only: an anonymous visitor is redirected to `/login`
 * by `requireUser()`, exactly as the conversation routes do, so no settings data is
 * ever rendered for someone who is not authenticated.
 *
 * Everything here is the user's own data, read from the session and from their
 * `user_preferences` row. The account details are read-only at this step, and the
 * only preference that can be changed is the theme.
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await loadSettings(user);

  return (
    <div className="settings-shell">
      <header className="settings-topbar">
        <Link className="brand" href="/">
          <YoriMark />
          <span>
            Yori<span className="brand-light">GPT</span>
          </span>
        </Link>
        <Link className="settings-topbar-link" href="/">
          Back to chat
        </Link>
      </header>
      <main className="settings-main">
        <div className="settings-heading">
          <h1>Settings</h1>
          <p className="settings-lead">How YoriGPT looks, and the account you are signed in with.</p>
        </div>

        <section className="settings-card" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p className="settings-card-intro">
            Saved to your account, so it follows you to every device you sign in on.
          </p>
          <ThemePreference settings={settings} />
          <p className="settings-note">
            {THEME_LABELS[DEFAULT_THEME]} is the default for an account that has not chosen
            a theme yet; it follows the appearance of the device.
          </p>
        </section>

        <section className="settings-card" aria-labelledby="account-heading">
          <h2 id="account-heading">Account</h2>
          <p className="settings-card-intro">Read-only details of the signed-in account.</p>
          <dl className="settings-list">
            <div>
              <dt>Name</dt>
              <dd>{settings.account.name === "" ? "Not provided" : settings.account.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{settings.account.email}</dd>
            </div>
            <div>
              <dt>Email status</dt>
              <dd>
                <span
                  className={`settings-status ${settings.account.emailVerified ? "is-verified" : ""}`}
                >
                  {settings.account.emailVerified ? "Verified" : "Not verified"}
                </span>
              </dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}
