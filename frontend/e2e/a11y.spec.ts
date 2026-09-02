import { expect, test, type Page } from "@playwright/test";

/**
 * Selection state that exists as more than a colour.
 *
 * v0.68.0 fixed how form controls in the settings drawer are NAMED. This is the
 * other half of the same drawer: how its selection controls report what is
 * CHOSEN. Theme, Language, and the two provider tabs each carried the active
 * option in `bg-accent` and nothing else — measured in a browser, all four
 * buttons came back `aria-pressed=null aria-checked=null aria-current=null`,
 * with no group name either.
 *
 * So a screen reader announced "English, button" and "简体中文, button" with no
 * way to tell which one the app is using, and forced-colours / high-contrast
 * mode loses the accent entirely — leaving no signal at all.
 *
 * `aria-pressed` is the app's OWN established pattern for this: the composer's
 * attach-type toggle and the session inspector's filter chips both set it.
 * These two controls had simply diverged. This spec keeps them from diverging
 * again, and reads the state the way assistive tech does rather than by class.
 */

async function openSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(page.getByTestId("agent-composer").getByRole("textbox")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /settings/i }).first().click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
}

/** How assistive tech sees it: exactly one pressed button per group. */
async function pressedIn(page: Page, labels: string[]): Promise<Record<string, string | null>> {
  return await page.evaluate((names) => {
    const out: Record<string, string | null> = {};
    for (const name of names) {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === name,
      );
      out[name] = btn ? btn.getAttribute("aria-pressed") : "NOT-FOUND";
    }
    return out;
  }, labels);
}

test.describe("settings drawer selection state", () => {
  test("the language control says which language is active", async ({ page }) => {
    await openSettings(page);
    expect(await pressedIn(page, ["English", "简体中文"])).toEqual({
      English: "true",
      简体中文: "false",
    });
  });

  test("the theme control says which theme is active", async ({ page }) => {
    await openSettings(page);
    const state = await pressedIn(page, ["Dark", "Light"]);
    // Which one is on depends on the profile; that exactly one is on does not.
    expect(Object.values(state).filter((v) => v === "true")).toHaveLength(1);
    expect(Object.values(state).filter((v) => v === "false")).toHaveLength(1);
  });

  test("pressing an option moves the pressed state, not just the colour", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: /^简体中文$/ }).first().click();
    expect(await pressedIn(page, ["English", "简体中文"])).toEqual({
      English: "false",
      简体中文: "true",
    });
    // Put the shared browser profile back for the specs that follow.
    await page.getByRole("button", { name: /^English$/ }).first().click();
  });

  test("the settings sections say which section is open", async ({ page }) => {
    await openSettings(page);
    // The dialog opens on General; the provider sections are not pressed yet.
    expect(await pressedIn(page, ["General", "Model Providers", "Cloud Providers"])).toEqual({
      General: "true",
      "Model Providers": "false",
      "Cloud Providers": "false",
    });

    await page.getByRole("button", { name: /^Cloud Providers$/ }).first().click();
    expect(await pressedIn(page, ["General", "Model Providers", "Cloud Providers"])).toEqual({
      General: "false",
      "Model Providers": "false",
      "Cloud Providers": "true",
    });

    await page.getByRole("button", { name: /^Model Providers$/ }).first().click();
    expect(await pressedIn(page, ["Model Providers", "Cloud Providers"])).toEqual({
      "Model Providers": "true",
      "Cloud Providers": "false",
    });
  });

  test("each group of choices has a name of its own", async ({ page }) => {
    await openSettings(page);
    // A pressed state is only half the answer — "pressed" is meaningless
    // without knowing pressed WHAT. The visible caption above each group is
    // now the group's accessible name rather than unattached text.
    const named = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('[role="group"]')];
      return groups.map((g) => {
        const byId = g.getAttribute("aria-labelledby");
        const label = byId
          ? (document.getElementById(byId)?.textContent ?? "").trim()
          : (g.getAttribute("aria-label") ?? "").trim();
        return label;
      });
    });
    expect(named.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(named).toContain("Theme");
    expect(named).toContain("Language");
  });
});
