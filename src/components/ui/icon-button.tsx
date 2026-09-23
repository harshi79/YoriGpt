import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./icon";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: IconName;
};

export function IconButton({ label, icon, className = "", ...props }: Props) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
