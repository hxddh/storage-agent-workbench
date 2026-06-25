import { useState } from "react";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { MainArea } from "./components/MainArea";
import { ContextPanel } from "./components/ContextPanel";
import { ProvidersView } from "./views/ProvidersView";
import { RunsView } from "./views/RunsView";
import { ReportsView } from "./views/ReportsView";
import { DatasetsView } from "./views/DatasetsView";
import { useSidecarHealth } from "./hooks/useSidecarHealth";

export default function App() {
  const { status, service } = useSidecarHealth();
  const [active, setActive] = useState<NavItem>("Runs");

  return (
    <div className="flex h-full w-full bg-canvas text-gray-200">
      <Sidebar status={status} service={service} active={active} onSelect={setActive} />
      {active === "Providers" ? (
        <ProvidersView />
      ) : active === "Runs" ? (
        <RunsView />
      ) : active === "Reports" ? (
        <ReportsView />
      ) : active === "Datasets" ? (
        <DatasetsView />
      ) : (
        <MainArea />
      )}
      <ContextPanel />
    </div>
  );
}
