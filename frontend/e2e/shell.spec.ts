import { expect, test, type Page } from "@playwright/test";

/**
 * v0.46.0 shell interactions, against the real stack.
 *
 * These are the parts unit tests cannot reach: the rail's width and collapsed
 * state have to survive an actual page reload (they live in localStorage and are
 * read at mount), and the keyboard shortcuts have to reach a real document.
 */

async function seedFreshApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
}

const rail = (page: Page) => page.getByTestId("session-rail");

test.describe("session rail", () => {
  test("collapses, and stays collapsed across a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");

    await page.getByTestId("rail-toggle").click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    // The point of a preference is that you set it once.
    await page.reload();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    // And the collapsed strip still offers the two things you reach for most.
    await expect(page.getByRole("button", { name: /new chat/i })).toBeVisible();
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
    // Clamped: never wide enough to starve the thread.
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
    // Below this the rail stops earning its space — collapse is the answer, not
    // a sliver of clipped text.
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
    // It documents the shortcuts that already existed but were undiscoverable.
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

    // Focus must not walk out into the composer hidden behind the scrim.
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
    // Nothing is hidden, so nothing claims to be.
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

    // The contract the thread relies on: a page, plus how many exist.
    expect(Array.isArray(body.messages)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.has_more).toBe("boolean");
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

    // The old split layout put a trace above the answer AND a metrics strip
    // below it, each with its own expander, describing the same calls.
    await expect(page.getByTestId("tool-trace-toggle")).toHaveCount(0);
    // "Why this answer" is no longer a separate card either.
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
    // Standing session state belongs in the inspector, not at the newest
    // position of a time-ordered thread.
    await expect(page.getByText(/^Session findings/)).toHaveCount(0);
  });
});
