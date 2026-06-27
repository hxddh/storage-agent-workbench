import { useState } from "react";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { MainArea } from "./components/MainArea";
import { ContextPanel } from "./components/ContextPanel";
import { HomeView } from "./views/HomeView";
import { ProvidersView } from "./views/ProvidersView";
import { RunsView } from "./views/RunsView";
import { SessionsView } from "./views/SessionsView";
import { ReportsView } from "./views/ReportsView";
import { DatasetsView } from "./views/DatasetsView";
import { useSidecarHealth } from "./hooks/useSidecarHealth";

export default function App() {
  const { status, service, slow } = useSidecarHealth();
  const [active, setActive] = useState<NavItem>("Home");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const openRun = (runId: string) => {
    setOpenRunId(runId);
    setActive("Runs");
  };
  const openSession = (sessionId: string) => {
    setOpenSessionId(sessionId);
    setActive("Sessions");
  };

  return (
    <div className="flex h-full w-full bg-canvas text-gray-200">
      <Sidebar status={status} service={service} slow={slow} active={active} onSelect={setActive} />
      {active === "Home" ? (
        <HomeView onNavigate={setActive} onOpenSession={openSession} />
      ) : active === "Sessions" ? (
        <SessionsView initialSessionId={openSessionId} onConsumed={() => setOpenSessionId(null)} />
      ) : active === "Providers" ? (
        <ProvidersView onRunCreated={openRun} />
      ) : active === "Runs" ? (
        <RunsView initialRunId={openRunId} onConsumed={() => setOpenRunId(null)} />
      ) : active === "Reports" ? (
        <ReportsView />
      ) : active === "Datasets" ? (
        <DatasetsView />
      ) : (
        <MainArea onNavigate={setActive} />
      )}
      <ContextPanel />
    </div>
  );
}
