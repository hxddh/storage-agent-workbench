import { expect, test, type Page } from "@playwright/test";

async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
}

const rail = (page: Page) => page.getByTestId("session-rail");

test.describe("investigation navigation shell", () => {
  test("collapses, and stays collapsed across a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");

    await page.getByTestId("rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    await page.reload();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByRole("button", { name: /new investigation/i })).toBeVisible();

    await page.getByTestId("rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");
  });

  test("drag-resizes within bounds and persists the width", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const handle = page.getByTestId("rail-resize");
    const before = (await rail(page).boundingBox())!.width;

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(360, box.y + 200, { steps: 8 });
    await page.mouse.up();

    const after = (await rail(page).boundingBox())!.width;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(420);

    await page.reload();
    const restored = (await rail(page).boundingBox())!.width;
    expect(Math.abs(restored - after)).toBeLessThan(3);
  });

  test("refuses to shrink past the width where titles stop being readable", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const handle = page.getByTestId("rail-resize");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(20, box.y + 200, { steps: 8 });
    await page.mouse.up();
    expect((await rail(page).boundingBox())!.width).toBeGreaterThanOrEqual(189);
  });
});

test.describe("keyboard", () => {
  test("? opens the shortcuts sheet and Escape closes it", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await page.keyboard.press("?");
    const sheet = page.getByTestId("shortcuts-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/command palette/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("? typed into the composer is a character, not a shortcut", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.type("why?");
    await expect(page.getByTestId("shortcuts-sheet")).toHaveCount(0);
    await expect(box).toHaveValue("why?");
  });

  test("the sidebar toggles from the keyboard", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");
    await page.keyboard.press("ControlOrMeta+\\");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
  });
});

test.describe("overlay focus", () => {
  test("Tab stays inside the command palette", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);
  });
});

test.describe("thread paging", () => {
  test("a short thread offers no 'load earlier' control", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("load-earlier")).toHaveCount(0);
  });

  test("the messages endpoint pages and reports the total", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const sid = await page.evaluate(async () => {
      const base = (window as unknown as { __SAW_BASE__?: string }).__SAW_BASE__;
      const url = base || "http://127.0.0.1:8799";
      const r = await fetch(`${url}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "paging" }),
      });
      return (await r.json()).id as string;
    });

    const body = await page.evaluate(async (id) => {
      const url = "http://127.0.0.1:8799";
      const r = await fetch(`${url}/sessions/${id}/messages?limit=5`);
      return await r.json();
    }, sid);

    expect(Array.isArray(body.messages)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.has_more).toBe("boolean");
  });
});

test.describe("what the agent knows", () => {
  test("the session endpoint reports its memory, files, and context reach", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const body = await page.evaluate(async () => {
      const url = "http://127.0.0.1:8799";
      const created = await (
        await fetch(`${url}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "knowledge" }),
        })
      ).json();
      return await (await fetch(`${url}/sessions/${created.id}`)).json();
    });
    expect(Array.isArray(body.agent_memory)).toBe(true);
    expect(Array.isArray(body.attached_files)).toBe(true);
    expect(typeof body.context_messages).toBe("number");
  });

  test("a session with no turn in flight says so", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const state = await page.evaluate(async () => {
      const url = "http://127.0.0.1:8799";
      const created = await (
        await fetch(`${url}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "turnstate" }),
        })
      ).json();
      return await (await fetch(`${url}/sessions/${created.id}/turn`)).json();
    });
    expect(state.running).toBe(false);
  });
});

test.describe("composer drafts", () => {
  test("an unsent question survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("why can I not delete this object");

    const stored = await page.evaluate(() => localStorage.getItem("saw.drafts"));
    expect(stored ?? "").toContain("why can I not delete this object");
  });
});

test.describe("turn structure", () => {
  test("a finished answer carries ONE metadata affordance, not three", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("tool-trace-toggle")).toHaveCount(0);
    await expect(page.getByText(/^Why this answer/)).toHaveCount(0);
  });

  test("session findings are not rendered at the bottom of the timeline", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Session findings/)).toHaveCount(0);
  });
});

/**
 * Escape is an overlay-stack contract. The removed Session Inspector is not an
 * overlay anymore, so exercise two overlays that still exist: Settings, then
 * the Command Palette above it.
 */
test.describe("Escape with two overlays open", () => {
  test("closes only the topmost one", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("rail-settings").click();
    const settings = page.getByRole("dialog").filter({ hasText: /Settings & providers/i });
    await expect(settings).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByPlaceholder(/Search chats or run a command/i);
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(settings).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  });
});

test("the settings drawer is never see-through, even mid-animation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
    localStorage.setItem("saw.theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("rail-settings").click();

  const mid = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    const r = panel.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const under = document.elementFromPoint(x, y);
    return {
      inPanel: panel.contains(under),
      panelOpacity: Number(getComputedStyle(panel).opacity),
      chainOpacity: (() => {
        let o = 1;
        for (let n: Element | null = panel; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return Math.round(o * 1000) / 1000;
      })(),
    };
  });
  expect(mid.inPanel).toBe(true);
  expect(mid.panelOpacity).toBe(1);
  expect(mid.chainOpacity, "the panel or an ancestor is fading, so the panel is see-through").toBe(1);
});
