import { describe, expect, it } from "vitest";
import { inferDatasetType } from "./datasetType";

describe("choosing the engine for an attached file", () => {
  it("does not read a syllable as the word 'log'", () => {
    // Every one of these was routed to the ACCESS-LOG engine before: the hint
    // tested `name.includes("log")`, and "catalog" ends in "log".
    expect(inferDatasetType("catalog.csv")).toBe("inventory");
    expect(inferDatasetType("logistics-export.csv")).toBe("inventory");
    expect(inferDatasetType("backlog.csv")).toBe("inventory");
    expect(inferDatasetType("dialog.csv")).toBe("inventory");
    // The damning one: the filename says "inventory".
    expect(inferDatasetType("logical-inventory.parquet")).toBe("inventory");
  });

  it("does not read a syllable as the word 'access'", () => {
    expect(inferDatasetType("accessories.csv")).toBe("inventory");
  });

  it("still catches a columnar access-log export the extension would miscall", () => {
    expect(inferDatasetType("access-logs.parquet")).toBe("access_log");
    expect(inferDatasetType("s3_access_log.csv")).toBe("access_log");
    expect(inferDatasetType("accesslog.csv")).toBe("access_log");
    expect(inferDatasetType("accesslogs.tsv")).toBe("access_log");
    expect(inferDatasetType("server-logs.csv")).toBe("access_log");
  });

  it("falls back to the extension", () => {
    expect(inferDatasetType("inventory-2026-06.csv")).toBe("inventory");
    expect(inferDatasetType("export.parquet")).toBe("inventory");
    expect(inferDatasetType("manifest.tsv.gz")).toBe("inventory");
    expect(inferDatasetType("dump.txt")).toBe("access_log");
    expect(inferDatasetType("events.jsonl")).toBe("access_log");
    expect(inferDatasetType("2026-06-25.log.gz")).toBe("access_log");
  });

  it("says it does not know rather than guessing", () => {
    // The composer shows an Inventory / Access-log toggle for these.
    expect(inferDatasetType("dump.gz")).toBeNull();
    expect(inferDatasetType("data")).toBeNull();
    expect(inferDatasetType("report.xlsx")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(inferDatasetType("CATALOG.CSV")).toBe("inventory");
    expect(inferDatasetType("S3-ACCESS.LOG")).toBe("access_log");
  });
});
