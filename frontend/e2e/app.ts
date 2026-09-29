import { expect, type Page } from "@playwright/test";

/** Shared E2E helpers: the real Sidecar's API for setup, and a booted window. */
export const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SIDECAR}${path}`, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Every spec starts from a clean slate of tasks, models and storage accounts. */
export async function reset(): Promise<void> {
  const { tasks } = await api<{ tasks: Array<{ id: string }> }>("/tasks");
  for (const t of tasks) await api(`/tasks/${t.id}`, { method: "DELETE" });
  for (const m of await api<Array<{ id: string }>>("/providers/models")) await api(`/providers/models/${m.id}`, { method: "DELETE" });
  for (const c of await api<Array<{ id: string }>>("/providers/clouds")) await api(`/providers/clouds/${c.id}`, { method: "DELETE" });
}

export async function addStorage(endpoint: string, name = "acme-prod"): Promise<string> {
  const c = await api<{ id: string }>("/providers/clouds", {
    method: "POST",
    body: JSON.stringify({ name, provider_type: "s3-compatible", endpoint_url: endpoint, region: "us-east-1",
      addressing_style: "path", access_key: "AKIAIOSFODNN7EXAMPLE", secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }),
  });
  return c.id;
}

export async function boot(page: Page, opts: { lang?: "en" | "zh"; theme?: "dark" | "light" } = {}): Promise<void> {
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem("saw.lang", lang);
    localStorage.setItem("saw.theme", theme);
  }, { lang: opts.lang ?? "en", theme: opts.theme ?? "dark" });
  if (opts.lang) await api("/settings", { method: "PATCH", body: JSON.stringify({ language: opts.lang }) });
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
}

export async function delegate(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  // From the home a Direction opens its task; the Composer there is a new one.
  await expect(page.getByTestId("task-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("composer-input")).toHaveValue("");
}

export async function settled(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("task-page")).toBeVisible({ timeout });
  await expect(page.getByTestId("task-state")).toHaveCount(0, { timeout });
}
