import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Theme behavior, from the stored value to the document.
 *
 * The mapping and the resolution rules are pure, so they are asserted directly; the
 * inline bootstrap script is run against a stubbed `document`/`window` exactly as a
 * browser would run it before the first paint; and the root layout is called the way
 * the App Router calls it, to prove the stored preference is what reaches `<html>` on
 * every request — which is what makes the choice survive a reload and follow the
 * user across pages.
 */
const holder: { user: { id: string } | null; theme: string; readFails: boolean } = {
  user: null,
  theme: "system",
  readFails: false,
};

vi.mock("../src/server/auth/session", () => ({
  getCurrentUser: async () => holder.user,
}));

vi.mock("../src/server/settings/service", () => ({
  getTheme: async () => {
    if (holder.readFails) throw new Error("db down");
    return holder.theme;
  },
  resolveTheme: async () => {
    if (holder.readFails) return "system";
    return holder.theme;
  },
  saveTheme: async () => ({ ok: true, theme: holder.theme }),
}));

const RootLayout = (await import("../src/app/layout")).default;
const { loadThemePreference } = await import("../src/server/settings/view");
const {
  COLOR_SCHEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
  THEME_BOOTSTRAP_SCRIPT,
  applyTheme,
  resolveColorScheme,
} = await import("../src/features/settings/theme-attribute");
const { DEFAULT_THEME } = await import("../src/features/settings/types");

/** A minimal stand-in for the parts of the DOM the theme script touches. */
function installDom(options: { prefersLight?: boolean; theme?: string | null } = {}) {
  const attributes = new Map<string, string>();
  if (options.theme) attributes.set(THEME_ATTRIBUTE, options.theme);

  const listeners: (() => void)[] = [];
  const media = {
    matches: options.prefersLight ?? false,
    addEventListener: (_event: string, handler: () => void) => listeners.push(handler),
  };
  const documentElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };

  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("document", { documentElement });

  return {
    attributes,
    /** Runs the inline script the way the browser runs it, before the first paint. */
    boot() {
      new Function("document", "window", THEME_BOOTSTRAP_SCRIPT)(
        { documentElement },
        { matchMedia: () => media },
      );
    },
    setDevicePreference(prefersLight: boolean) {
      media.matches = prefersLight;
      listeners.forEach((handler) => handler());
    },
  };
}

/** The parts of the rendered `<html>` element these checks assert on. */
type RenderedLayout = {
  props: {
    "data-theme": string;
    suppressHydrationWarning: boolean;
    children: {
      props: { children: { props: { dangerouslySetInnerHTML: { __html: string } } } };
    }[];
  };
};

beforeEach(() => {
  holder.user = null;
  holder.theme = "system";
  holder.readFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolving a preference to a palette", () => {
  it("honours an explicit choice over the device", () => {
    expect(resolveColorScheme("dark")).toBe("dark");
    expect(resolveColorScheme("light")).toBe("light");
  });

  it("follows the device when the preference is system", () => {
    installDom({ prefersLight: true });
    expect(resolveColorScheme("system")).toBe("light");

    installDom({ prefersLight: false });
    expect(resolveColorScheme("system")).toBe("dark");
  });
});

describe("the pre-paint script", () => {
  it("renders the dark palette for a stored dark preference, whatever the device says", () => {
    const dom = installDom({ prefersLight: true, theme: "dark" });
    dom.boot();
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("renders the light palette for a stored light preference, whatever the device says", () => {
    const dom = installDom({ prefersLight: false, theme: "light" });
    dom.boot();
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
  });

  it("follows the device for system, and keeps following it", () => {
    const dom = installDom({ prefersLight: false, theme: "system" });
    dom.boot();
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    dom.setDevicePreference(true);
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");

    dom.setDevicePreference(false);
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("leaves an explicit choice alone when the device changes", () => {
    const dom = installDom({ prefersLight: false, theme: "dark" });
    dom.boot();
    dom.setDevicePreference(true);
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });

  it("treats a missing preference as the documented default", () => {
    expect(DEFAULT_THEME).toBe("system");
    const dom = installDom({ prefersLight: true, theme: null });
    dom.boot();
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");
  });
});

describe("applying a saved choice in this tab", () => {
  it("updates the preference and the resolved palette without a reload", () => {
    const dom = installDom({ prefersLight: false, theme: "system" });
    dom.boot();
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");

    applyTheme("light");
    expect(dom.attributes.get(THEME_ATTRIBUTE)).toBe("light");
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("light");

    applyTheme("system");
    expect(dom.attributes.get(THEME_ATTRIBUTE)).toBe("system");
    expect(dom.attributes.get(COLOR_SCHEME_ATTRIBUTE)).toBe("dark");
  });
});

describe("what the root layout renders", () => {
  it("writes the stored preference of the signed-in user to <html>", async () => {
    holder.user = { id: "cmuser00000000000000001" };

    for (const theme of ["dark", "light", "system"]) {
      holder.theme = theme;
      // Awaited the way the App Router awaits a server component.
      const element = (await RootLayout({ children: null })) as unknown as RenderedLayout;
      expect(element.props[THEME_ATTRIBUTE], theme).toBe(theme);
      // The palette is resolved before the first paint, so nothing flashes.
      const head = element.props.children[0];
      expect(head.props.children.props.dangerouslySetInnerHTML.__html).toBe(THEME_BOOTSTRAP_SCRIPT);
      expect(element.props.suppressHydrationWarning).toBe(true);
    }
  });

  it("writes the documented default for a signed-out visitor, without a database read", async () => {
    holder.theme = "dark"; // a value that only belongs to somebody else
    const element = (await RootLayout({ children: null })) as unknown as RenderedLayout;

    expect(element.props[THEME_ATTRIBUTE]).toBe(DEFAULT_THEME);
  });

  it("still renders when the stored preference cannot be read", async () => {
    holder.user = { id: "cmuser00000000000000001" };
    holder.readFails = true;

    await expect(loadThemePreference(holder.user)).resolves.toBe(DEFAULT_THEME);
    const element = (await RootLayout({ children: null })) as unknown as RenderedLayout;
    expect(element.props[THEME_ATTRIBUTE]).toBe(DEFAULT_THEME);
  });
});
