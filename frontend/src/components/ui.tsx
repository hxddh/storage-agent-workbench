import type { ReactNode } from "react";

const inputCls =
  "w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 " +
  "placeholder:text-gray-600 focus:border-gray-500 focus:outline-none";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-gray-400">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-gray-600">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputCls} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={inputCls} />;
}

export function Button({
  variant = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  const styles: Record<string, string> = {
    default: "border border-edge bg-canvas text-gray-200 hover:bg-panel",
    primary: "bg-emerald-600 text-white hover:bg-emerald-500",
    danger: "border border-red-900 text-red-300 hover:bg-red-950",
    ghost: "text-gray-400 hover:text-gray-200",
  };
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${styles[variant]} ${className}`}
    />
  );
}
