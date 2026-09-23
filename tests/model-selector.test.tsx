import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelSelector } from "../src/components/chat/model-selector";
import type { ModelSelection } from "../src/features/models/types";

const models = [
  { key: "gpt-4o-mini", name: "GPT-4o mini", description: "Fast and inexpensive." },
  { key: "gpt-4o", name: "GPT-4o", description: "Most capable." },
  { key: "claude-3.5-haiku", name: "Claude 3.5 Haiku", description: "Quick and careful." },
];

const selection: ModelSelection = { status: "ready", models, selectedKey: "gpt-4o-mini" };

function render(overrides: Partial<React.ComponentProps<typeof ModelSelector>> = {}) {
  return renderToStaticMarkup(
    <ModelSelector
      models={selection.models}
      value={selection.selectedKey}
      onChange={() => {}}
      hint="Used for new replies"
      {...overrides}
    />,
  );
}

describe("model selector", () => {
  it("offers exactly the models the server sent, by display name", () => {
    const html = render();

    expect(html).toContain('aria-label="Reply model"');
    for (const model of models) {
      expect(html, model.key).toContain(`value="${model.key}"`);
      expect(html, model.name).toContain(model.name);
    }
    // No provider identifier, user id, or internal configuration is rendered.
    for (const model of models) expect(html).not.toContain(model.key + "/");
    expect(html).not.toContain("openai/");
    expect(html).not.toContain("anthropic/");
    expect(html).not.toContain("OPENROUTER");
    expect(html).not.toContain("user_preferences");
  });

  it("shows the saved model as the selected option", () => {
    const html = render();
    const selected = html.match(/<option[^>]*selected[^>]*>/g) ?? [];

    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('value="gpt-4o-mini"');

    const other = render({ value: "claude-3.5-haiku" });
    expect(other).toMatch(/<option[^>]*value="claude-3\.5-haiku"[^>]*selected/);
  });

  it("offers each model once, so the list cannot drift from the server", () => {
    const html = render();
    const options = html.match(/<option[^>]*>/g) ?? [];

    expect(options).toHaveLength(models.length);
    expect(new Set(options).size).toBe(models.length);
  });

  it("explains itself and disables when there is nobody to save a choice for", () => {
    const html = render({ disabled: true, hint: "Sign in to choose a model" });

    expect(html).toContain("disabled");
    expect(html).toContain("Sign in to choose a model");
  });

  it("reports saving and failures in the hint, marked as an error", () => {
    expect(render({ disabled: true, hint: "Saving…" })).toContain("Saving…");

    const failed = render({ hint: "That model is not available.", hintIsError: true });
    expect(failed).toContain("That model is not available.");
    expect(failed).toContain("is-error");
    // The failed hint is announced as a description of the control.
    expect(failed).toContain('aria-describedby="');
  });

  it("renders nothing invented when the catalog is empty", () => {
    const html = render({ models: [], value: "" });

    expect(html).not.toContain("<option");
    expect(html).not.toContain("undefined");
  });
});
