import { describe, expect, it } from "vitest";
import { score } from "./Palette";

describe("palette ranking", () => {
  it("matches subsequences and ranks word starts and runs higher", () => {
    expect(score("srv", "Survey the account")).not.toBeNull();
    expect(score("xyz", "Survey")).toBeNull();
    const start = score("acc", "Account survey")!.score;
    const middle = score("acc", "Tacco review")!.score;
    expect(start).toBeGreaterThan(middle);
    expect(score("ac", "Account")!.hits).toEqual([0, 1]);
  });
});
