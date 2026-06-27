import type { ReactNode } from "react";

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
