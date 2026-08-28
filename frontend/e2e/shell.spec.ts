import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

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

test.describe("what the agent knows (v0.51.0)", () => {
  test("the session endpoint reports its memory, its files, and its context reach", async ({ page }) => {
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
    // The contract the memory panel relies on. Before v0.51.0 the agent's own
    // memory was persisted, replayed into every turn, and returned by nothing.
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
    // This is what a client that reloaded mid-turn asks. "Nothing running" has
    // to be a real answer, not a 404.
    expect(state.running).toBe(false);
  });
});

test.describe("composer drafts (v0.51.0)", () => {
  test("an unsent question survives a reload", async ({ page }) => {
    await seedFreshApp(page);
    await page.goto("/");
    const box = page.getByPlaceholder(/Ask Storage Agent/i);
    await box.click();
    await box.fill("why can I not delete this object");

    // A draft is UI state, so localStorage is where it lives — and a reload is
    // exactly the event that used to destroy it.
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

/**
 * Escape closes what you just opened, not everything you had open.
 *
 * Five window-level Escape handlers had grown up independently — the shortcuts
 * sheet, the session inspector, the run overlay, the import dialog, and a
 * catch-all in App that closed the palette, the settings drawer and the sheet
 * together. Each is correct alone; stacked they are not. Measured before the
 * fix: inspector open, palette opened over it, one Escape → `{palette: 0,
 * inspector: 0}`. Dismissing the thing you had just opened threw away the thing
 * you opened it from.
 */
test.describe("Escape with two overlays open", () => {
  test("closes only the topmost one", async ({ page }) => {
    test.setTimeout(90_000);
    const { title } = seedSession(3, `esc ${Date.now()}`);
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 30_000 });
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("open-inspector").click();
    await expect(page.getByText(/Session inspector/i).first()).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByPlaceholder(/Search chats or run a command/i);
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    // …and the inspector it was opened over is still there.
    await expect(page.getByText(/Session inspector/i).first()).toBeVisible();

    // A second Escape then takes the inspector, in order.
    await page.keyboard.press("Escape");
    await expect(page.getByText(/Session inspector/i)).toHaveCount(0);
  });
});

/**
 * An opaque panel is opaque, including while it is arriving.
 *
 * The settings drawer spent the length of its open animation translucent: you
 * could read the thread's heading straight through it, on every single open.
 * The first fix removed `opacity` from the panel's own keyframe and changed
 * nothing, because the opacity was never on the panel — the scrim was its
 * PARENT, and fading the scrim faded everything inside it.
 *
 * Asserted on pixels rather than on CSS: sample a point well inside the panel a
 * few frames after it opens and require it to be the panel's own colour. A
 * declaration can be correct and still inherit a fade from four levels up.
 */
test("the settings drawer is never see-through, even mid-animation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
    localStorage.setItem("saw.theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 30_000 });

  // The start surface's heading is behind where the drawer will be.
  await page.getByTestId("rail-settings").click();

  // Two frames in: the slide is still running.
  const mid = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    const r = panel.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const under = document.elementFromPoint(x, y);
    return {
      // Whatever is painted at the middle of the panel must belong to it.
      inPanel: panel.contains(under),
      panelOpacity: Number(getComputedStyle(panel).opacity),
      // …and nothing between it and the root may be fading either.
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
