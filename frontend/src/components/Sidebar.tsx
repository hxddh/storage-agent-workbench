import { SidecarStatus } from "./SidecarStatus";
import type { SidecarStatus as Status } from "../hooks/useSidecarHealth";

export const NAV_ITEMS = ["Sessions", "Runs", "Providers", "Datasets", "Reports", "Settings"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

export function Sidebar({
  status,
  service,
  slow,
  active,
  onSelect,
}: {
  status: Status;
  service: string | null;
  slow: boolean;
  active: NavItem;
  onSelect: (item: NavItem) => void;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-sidebar">
      <div className="px-4 py-4">
        <div className="text-sm font-semibold text-gray-100">Storage Agent</div>
        <div className="text-xs text-gray-500">Workbench</div>
      </div>

      <nav className="flex-1 px-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item}
            onClick={() => onSelect(item)}
            className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm ${
              item === active
                ? "bg-canvas text-gray-100"
                : "text-gray-400 hover:bg-canvas hover:text-gray-200"
            }`}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="p-3">
        <SidecarStatus status={status} service={service} slow={slow} />
      </div>
    </aside>
  );
}
