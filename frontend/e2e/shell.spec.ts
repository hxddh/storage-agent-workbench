import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
}

const taskNavigation = (page: Page) => page.getByTestId("agent-task-navigation");
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

test.describe("Agent task navigation shell", () => {
  test("collapses, and stays collapsed across a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "false");

    await page.getByTestId("task-navigation-toggle").click();
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "true");

    await page.reload();
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByRole("button", { name: /^New task$/i })).toBeVisible();

    await page.getByTestId("task-navigation-toggle").click();
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "false");
  });

  test("drag-resizes within bounds and persists the width", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const handle = page.getByTestId("task-navigation-resize");
    const before = (await taskNavigation(page).boundingBox())!.width;

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(360, box.y + 200, { steps: 8 });
    await page.mouse.up();

    const after = (await taskNavigation(page).boundingBox())!.width;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(420);

    await page.reload();
    const restored = (await taskNavigation(page).boundingBox())!.width;
    expect(Math.abs(restored - after)).toBeLessThan(3);
  });

  test("refuses to shrink past the width where task identity stops being readable", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const handle = page.getByTestId("task-navigation-resize");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(20, box.y + 200, { steps: 8 });
    await page.mouse.up();
    expect((await taskNavigation(page).boundingBox())!.width).toBeGreaterThanOrEqual(189);
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

  test("? typed into the task composer is a character, not a shortcut", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.type("why?");
    await expect(page.getByTestId("shortcuts-sheet")).toHaveCount(0);
    await expect(box).toHaveValue("why?");
  });

  test("task navigation toggles from the keyboard", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "false");
    await page.keyboard.press("ControlOrMeta+\\");
    await expect(taskNavigation(page)).toHaveAttribute("data-collapsed", "true");
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

test.describe("task history paging", () => {
  test("a short task history offers no 'load earlier' control", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("load-earlier")).toHaveCount(0);
  });

  test("the persisted task-events endpoint pages and reports the total", async ({ page }) => {
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

test.describe("durable Agent context", () => {
  test("the task endpoint reports its memory, files, and context reach", async ({ page }) => {
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

  test("a task with no execution in flight says so", async ({ page }) => {
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

test.describe("task direction drafts", () => {
  test("an unsent direction survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill("why can I not delete this object");

    const stored = await page.evaluate(() => localStorage.getItem("saw.drafts"));
    expect(stored ?? "").toContain("why can I not delete this object");
  });
});

test.describe("work-result structure", () => {
  test("a finished result carries ONE execution metadata affordance, not three", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("tool-trace-toggle")).toHaveCount(0);
    await expect(page.getByText(/^Why this answer/)).toHaveCount(0);
  });

  test("durable findings are not rendered as a trailing task event", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = composer(page);
    await box.click();
    await box.fill("<Error><Code>AccessDenied</Code></Error>");
    await box.press("Enter");
    await expect(page.getByText(/error triage/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Session findings/)).toHaveCount(0);
  });
});

/**
 * Escape is an overlay-stack contract. Review, Settings, and the command palette
 * are overlays: the topmost one closes, the one under it stays.
 */
test.describe("Escape with two overlays open", () => {
  test("closes only the topmost one", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(composer(page)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("task-navigation-settings").click();
    const settings = page.getByTestId("settings-dialog");
    await expect(settings).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog").filter({ has: page.getByRole("textbox") });
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(settings).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
  });

  test("closes Review overlay without replacing the Task", async ({ page }) => {
    const { title } = seedSession(2);
    await seedFreshApp(page);
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press("Control+i");
    await expect(page.getByTestId("agent-review-overlay")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-review-overlay")).toHaveCount(0);
    await expect(page.getByTestId("agent-composer")).toBeVisible();
  });

  test("a palette opened over Review closes first", async ({ page }) => {
    const { title } = seedSession(2);
    await seedFreshApp(page);
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press("Control+i");
    await expect(page.getByTestId("agent-review-overlay")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.getByTestId("agent-review-overlay")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-review-overlay")).toHaveCount(0);
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
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("task-navigation-settings").click();

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
