import { useId } from "react";
import { Icon } from "../ui/icon";
import type { ModelOption } from "../../features/models/types";

type Props = {
  models: readonly ModelOption[];
  value: string;
  onChange: (value: string) => void;
  /** True while the selection is being saved, or when there is nobody to save it for. */
  disabled?: boolean;
  /** Short line under the control: what is happening, in plain words. */
  hint: string;
  /** True when the hint describes a failure, so it is styled and announced as one. */
  hintIsError?: boolean;
};

/**
 * The header model selector. It lists the models the server offers and reports the
 * chosen catalog key; saving, validation, and the OpenRouter identifier are the
 * server's business. The markup and classes are unchanged from the earlier shell —
 * only the data behind it is real now.
 */
export function ModelSelector({
  models,
  value,
  onChange,
  disabled = false,
  hint,
  hintIsError = false,
}: Props) {
  const hintId = useId();

  return (
    <div className="model-control">
      <div className="model-select-wrap">
        <select
          aria-label="Reply model"
          aria-describedby={hintId}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {models.map((model) => (
            <option key={model.key} value={model.key}>
              {model.name}
            </option>
          ))}
        </select>
        <Icon name="chevron" />
      </div>
      <span id={hintId} className={`model-hint ${hintIsError ? "is-error" : ""}`}>
        {hint}
      </span>
    </div>
  );
}
