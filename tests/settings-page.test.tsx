import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * What `/settings` renders, straight from the page: the account details, the theme
 * control with the stored choice selected, and nothing sensitive. The data behind it
 * is the real read model (`loadSettings`) over a stubbed preference service.
 */
const holder: {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  theme: string;
  readFails: boolean;
} = {
  user: {
    id: "cmuser00000000000000001",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  },
  theme: "system",
  readFails: false,
};

vi.mock("../src/server/auth/session", () => ({
  requireUser: async () => holder.user,
  getCurrentUser: async () => holder.user,
}));

vi.mock("../src/server/settings/service", () => ({
  getTheme: async () => {
    if (holder.readFails) throw new Error("db down");
    return holder.theme;
  },
  resolveTheme: async () => holder.theme,
  saveTheme: async () => ({ ok: true, theme: holder.theme }),
}));

const SettingsPage = (await import("../src/app/settings/page")).default;
const { ThemePreference } = await import("../src/features/settings/components/theme-preference");
const { loadSettings } = await import("../src/server/settings/view");

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await SettingsPage());
}

/** The `<option>` the control shows as selected. */
function selectedOption(html: string): string | undefined {
  return (html.match(/<option[^>]*selected[^>]*>/g) ?? [])[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  holder.user = {
    id: "cmuser00000000000000001",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  };
  holder.theme = "system";
  holder.readFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the settings page", () => {
  it("shows the stored theme as the selected choice", async () => {
    holder.theme = "dark";

    const html = await renderPage();
    expect(html).toContain('aria-label="Theme preference"');
    for (const [value, label] of [
      ["system", "System"],
      ["dark", "Dark"],
      ["light", "Light"],
    ]) {
      expect(html, value).toContain(`value="${value}"`);
      expect(html, label).toContain(label);
    }
    expect(selectedOption(html)).toContain('value="dark"');
    // The current choice is explained in words as well.
    expect(html).toContain("Always use the dark palette");
  });

  it("shows the account details, read-only", async () => {
    const html = await renderPage();

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Verified");
    // Nothing on the page can edit them.
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<form");
  });

  it("reports an unverified address, and a missing name, honestly", async () => {
    holder.user = { ...holder.user, name: "   ", emailVerified: false };

    const html = await renderPage();
    expect(html).toContain("Not verified");
    expect(html).toContain("Not provided");
  });

  it("renders no credential, token, internal identifier, or other preference", async () => {
    holder.theme = "light";

    const html = await renderPage();
    expect(html).not.toContain(holder.user.id);
    expect(html).not.toContain("password");
    expect(html).not.toContain("session_token");
    expect(html).not.toContain("user_preferences");
    expect(html).not.toContain("preferredModelId");
    expect(html).not.toContain("OPENROUTER");
    expect(html).not.toContain("DARK");
  });

  it("says so when the stored preference could not be read", async () => {
    holder.readFails = true;

    const html = await renderPage();
    expect(html).toContain("Couldn’t load your saved theme");
    // …and still shows a usable control, on the documented default.
    expect(selectedOption(html)).toContain('value="system"');
  });

  it("links back to the chat", async () => {
    const html = await renderPage();
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to chat");
  });
});

describe("the theme control", () => {
  function render(settings: Awaited<ReturnType<typeof loadSettings>>) {
    return renderToStaticMarkup(<ThemePreference settings={settings} />);
  }

  it("lists the three choices and explains the one in use", async () => {
    const settings = await loadSettings(holder.user);
    const html = render(settings);

    expect(html).toContain('aria-label="Theme preference"');
    expect(html).toContain("Follow this device’s appearance");
    // Enabled: nothing is being saved yet.
    expect(html).not.toContain("disabled");
  });

  it("labels the control for assistive technology", async () => {
    holder.theme = "light";
    const html = render(await loadSettings(holder.user));

    expect(html).toContain("<label");
    expect(html).toContain("Theme");
    expect(html).toContain('aria-describedby=');
  });
});
