import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/**
 * Component library v3 (v3.0.0). Every control in the window is one of these;
 * the look lives in `agent/native-components.css` (`ui-*`), so a surface
 * composes controls instead of restyling them.
 */

/**
 * A labelled form control. The label is associated by `for`/`id` and the hint
 * by `aria-describedby`, so the accessible name is the label alone.
 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const auto = useId();
  const hintId = hint ? `${auto}-hint` : undefined;
  const child = isValidElement(children)
    ? (children as ReactElement<Record<string, unknown>>)
    : null;
  const controlId = (child?.props.id as string | undefined) ?? auto;
  return (
    <div className="ui-field">
      <label htmlFor={controlId} className="ui-field-label">
        {label}
      </label>
      {child
        ? cloneElement(child, {
            id: controlId,
            "aria-describedby": hintId ?? child.props["aria-describedby"],
          })
        : children}
      {hint ? (
        <span id={hintId} className="ui-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`ui-input ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`ui-input ${props.className ?? ""}`} />;
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "selected" | "danger" | "danger-solid";

/**
 * Buttons: `primary` is the accent fill (one per surface), `secondary` a
 * raised neutral, `ghost` text-only, `danger` for destructive intent.
 * `default` is kept as an alias of `secondary`.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant | "default";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
}) {
  const resolved = variant === "default" ? "secondary" : variant;
  return (
    <button type="button" {...props} data-variant={resolved} data-size={size} className={`ui-btn ${className}`}>
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/** A square icon-only control. The label is its accessible name and tooltip. */
export function IconButton({
  icon,
  label,
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: "sm" | "md" }) {
  return (
    <button type="button" aria-label={label} title={label} {...props} data-size={size} className={`ui-icon-btn ${className}`}>
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
  );
}

/** Key caps for a shortcut: one cap per key, never run-together text. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {keys.map((key) => <kbd key={key} className="ui-kbd">{key}</kbd>)}
    </span>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger" | "outline";

export function Badge({ tone = "neutral", children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span {...props} className={`ui-badge ${props.className ?? ""}`} data-tone={tone}>{children}</span>;
}

/** One status mark. Colour is the tone; `pulse` only while work is live. */
export function StatusDot({ tone = "neutral", pulse = false, className = "" }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return <span className={`ui-dot ${className}`} data-tone={tone} data-pulse={pulse ? "true" : "false"} aria-hidden />;
}

/** The one section eyebrow: 11px, uppercase in Latin scripts. */
export function SectionLabel({ children, count, id }: { children: ReactNode; count?: number | null; id?: string }) {
  return (
    <h2 className="ui-label" id={id}>
      <span>{children}</span>
      {count != null ? <small>{count}</small> : null}
    </h2>
  );
}

export function Segmented<T extends string>({ options, value, onChange, labelId, testId }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  labelId: string;
  testId?: string;
}) {
  return (
    <div className="ui-segmented" role="group" aria-labelledby={labelId} data-testid={testId}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
