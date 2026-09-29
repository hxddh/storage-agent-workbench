import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Kbd } from "./components/ui";
import { useDismiss } from "./lib/useDismiss";
import { useTask } from "./store/task";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
});

describe("v8.1 fixes", () => {
  it("switching tasks never shows the previous task's model, even for one render", () => {
    const seen: Array<{ id: string; title: string | undefined }> = [];
    const { result, rerender } = renderHook(({ id }) => {
      const r = useTask(id);
      seen.push({ id: id ?? "", title: r.model.snapshot?.task.title });
      return r;
    }, { initialProps: { id: "a" as string | null } });
    act(() => result.current.setSnapshot({
      task: { id: "a", title: "A", title_source: "user", origin: "user", state: "ready", created_at: "", updated_at: "", head_turn_id: null },
      state: "ready", running_turn_id: null, queued: [], turns: [], items: [], forks: {}, live: null, files: [], artifacts: [], last_seq: 0,
    }));
    expect(result.current.model.snapshot?.task.title).toBe("A");
    const from = seen.length;
    rerender({ id: "b" });
    expect(result.current.model.id).toBe("b");
    // No render under task b may show task a's content.
    expect(seen.slice(from).filter((r) => r.id === "b" && r.title === "A")).toEqual([]);
  });

  it("a menu closes when the pointer goes down outside it", () => {
    function Menu() {
      const [open, setOpen] = useState(true);
      const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
      return <><div ref={ref}>{open ? <span>menu</span> : null}</div><p>outside</p></>;
    }
    render(<Menu />);
    fireEvent.mouseDown(screen.getByText("menu"));
    expect(screen.queryByText("menu")).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByText("menu")).toBeNull();
  });

  it("the modifier key cap reads as the platform's", () => {
    render(<Kbd keys={["Mod", "N"]} />);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    expect(document.querySelector("kbd")?.textContent).toBe(mac ? "⌘" : "Ctrl");
  });
});
