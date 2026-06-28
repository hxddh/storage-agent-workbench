import type { ReactNode } from "react";

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

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-xs font-medium text-gray-400">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-gray-600">{hint}</span> : null}
    </label>
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
    danger: "border border-red-900/70 text-red-300 hover:bg-red-950/40",
    ghost: "text-gray-400 hover:text-gray-100 hover:bg-hover",
  };
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}
