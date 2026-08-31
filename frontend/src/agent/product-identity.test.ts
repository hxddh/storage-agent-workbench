import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("Storage Agent product identity", () => {
  it("ships the browser and desktop surface as Storage Agent", () => {
    const html = read("../../index.html");
    const tauri = JSON.parse(read("../../../src-tauri/tauri.conf.json")) as {
      productName: string;
      identifier: string;
      app: { windows: Array<{ title: string }> };
    };

    expect(html).toContain("<title>Storage Agent</title>");
    expect(html).not.toContain("Storage Agent Workbench");
    expect(tauri.productName).toBe("Storage Agent");
    expect(tauri.app.windows[0]?.title).toBe("Storage Agent");
    // Platform identity stays stable so v0.93 upgrades the existing desktop app.
    expect(tauri.identifier).toBe("com.storageagent.workbench");
  });

  it("publishes Storage Agent branded release assets and install instructions", () => {
    const release = read("../../../.github/workflows/release.yml");
    expect(release).toContain('--title "Storage Agent $VERSION"');
    expect(release).toContain("storage-agent-$VERSION-macos-arm64.app.zip");
    expect(release).toContain("storage-agent-$VERSION-linux-x64.deb");
    expect(release).toContain("storage-agent-$VERSION-windows-x64-setup.exe");
    expect(release).toContain('/Applications/Storage Agent.app');
    expect(release).not.toContain("storage-agent-workbench-$VERSION");
    expect(release).not.toContain("Storage Agent Workbench.app");
  });

  it("keeps public install and release documentation on the Storage Agent identity", () => {
    const publicDocs = [
      read("../../../README.md"),
      read("../../../docs/install.md"),
      read("../../../docs/signing.md"),
      read("../../../docs/release.md"),
    ].join("\n");

    expect(publicDocs).not.toContain("/Applications/Storage Agent Workbench.app");
    expect(publicDocs).not.toContain("storage-agent-workbench-*-linux-x64.deb");
    expect(publicDocs).not.toContain("Storage Agent Workbench.app");
    expect(publicDocs).toContain("/Applications/Storage Agent.app");
    expect(publicDocs).toContain("storage-agent-*-linux-x64.deb");
  });

  it("titles the release as Storage Agent", () => {
    const notes = read("../../../docs/releases/0.93.0.md");
    expect(notes.startsWith("# Storage Agent v0.93.0\n")).toBe(true);
  });
});
