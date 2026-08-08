import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";

/** The Storage Agent brand mark — an object-storage bucket with an agent spark.
 * Stroke uses currentColor; set color via the parent (white on the indigo tile,
 * indigo on neutral surfaces). */
export function BrandMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <ellipse cx="11.5" cy="9" rx="6.3" ry="1.9" />
      <path d="M5.2 9 7.4 19.3Q11.5 21 15.6 19.3L17.8 9" />
      <path d="M18.7 2l.83 2.05 2.05.83-2.05.83-.83 2.05-.83-2.05-2.05-.83 2.05-.83z" fill="currentColor" stroke="none" />
    </svg>
  );
}

const inputCls =
  "w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 " +
  "placeholder:text-gray-600 transition-colors hover:border-edge-strong " +
  "focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25";

/**
 * A labelled form control.
 *
 * The label is associated by `for`/`id`, and the hint by `aria-describedby` —
 * not by nesting both inside a `<label>`. A wrapping label with no `for`
 * contributes its whole subtree to the control's accessible NAME, so the name
 * used to be label + hint, and for a `<select>` label + hint + every option's
 * text: the Provider control announced as "Provider AWS S3 Alibaba Cloud OSS
 * Tencent Cloud COS …" before the user heard anything useful, and the key
 * fields as "Access key ID Stored only in the encrypted local vault — never
 * shown again after saving".
 *
 * A hint is a description, not a name: it belongs after the name, in
 * `aria-describedby`. This backs every control on the add-provider form and the
 * evidence-import dialog — the two forms a user must complete before the app
 * does anything.
 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const auto = useId();
  const hintId = hint ? `${auto}-hint` : undefined;
  // An explicit id on the control wins, so a caller that already wires up its
  // own labelling is not overridden.
  const child = isValidElement(children)
    ? (children as ReactElement<Record<string, unknown>>)
    : null;
  const controlId = (child?.props.id as string | undefined) ?? auto;
  return (
    <div className="mb-3 block">
      <label htmlFor={controlId} className="mb-1.5 block text-xs font-medium text-gray-400">
        {label}
      </label>
      {child
        ? cloneElement(child, {
            id: controlId,
            "aria-describedby": hintId ?? child.props["aria-describedby"],
          })
        : children}
      {hint ? (
        <span id={hintId} className="mt-1 block text-xs text-gray-600">
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

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const variants: Record<string, string> = {
    default: "border border-edge bg-elevated text-gray-200 hover:bg-hover hover:border-edge-strong",
    primary: "bg-accent text-white hover:bg-accent-soft",
    danger: "border border-danger-border text-danger hover:bg-danger-bg",
    ghost: "text-gray-400 hover:text-gray-100 hover:bg-hover",
  };
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
