import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";

const inputCls =
  "w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 " +
  "placeholder:text-gray-500 transition-[border-color] duration-fast hover:border-edge-strong " +
  "focus:border-edge-strong focus:outline-none";

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
    <div className="mb-3 block min-w-0">
      <label htmlFor={controlId} className="mb-1.5 block text-xs font-medium text-gray-300">
        {label}
      </label>
      {child
        ? cloneElement(child, {
            id: controlId,
            "aria-describedby": hintId ?? child.props["aria-describedby"],
          })
        : children}
      {hint ? (
        <span id={hintId} className="mt-1 block text-xs text-gray-500">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

/** Buttons: one filled primary (ink on the theme), quiet bordered default, ghost. */
export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "selected" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const variants: Record<string, string> = {
    default: "border border-edge bg-transparent text-gray-200 hover:bg-hover hover:border-edge-strong hover:text-gray-100",
    primary: "bg-accent text-accent-fg hover:bg-accent-soft",
    selected: "border border-edge-strong bg-elevated font-medium text-gray-100",
    danger: "border border-danger-border text-danger hover:bg-danger-bg",
    ghost: "text-gray-400 hover:text-gray-100 hover:bg-hover",
  };
  const sizes: Record<string, string> = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-8 px-3 text-sm",
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[color,background-color,border-color,transform] duration-fast active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
