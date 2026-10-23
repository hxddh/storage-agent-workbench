import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { describeError } from "./errors";

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? `:${Object.values(vars).join(",")}` : ""}`;

describe("describeError", () => {
  it("turns transport failures into one localized sentence", () => {
    expect(describeError(new ApiError(0, "The local service is not reachable.", "offline"), t)).toBe("error.offline");
    expect(describeError(new ApiError(0, "The request timed out.", "timeout"), t)).toBe("error.timeout");
    expect(describeError(new ApiError(401, "unauthorized"), t)).toBe("error.auth");
    expect(describeError(new ApiError(429, "busy"), t)).toBe("error.busy");
    expect(describeError(new ApiError(503, "unavailable"), t)).toBe("error.server:503");
  });

  it("keeps a validation detail that names the field to fix", () => {
    expect(describeError(new ApiError(422, "unknown attachment for this task"), t)).toBe("unknown attachment for this task");
  });
});
