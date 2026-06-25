import { Sidebar } from "./components/Sidebar";
import { MainArea } from "./components/MainArea";
import { ContextPanel } from "./components/ContextPanel";
import { useSidecarHealth } from "./hooks/useSidecarHealth";

export default function App() {
  const { status, service } = useSidecarHealth();

  return (
    <div className="flex h-full w-full bg-canvas text-gray-200">
      <Sidebar status={status} service={service} />
      <MainArea />
      <ContextPanel />
    </div>
  );
}
