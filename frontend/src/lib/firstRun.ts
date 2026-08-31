const ONBOARDED = "saw.onboarded";
const STEP = "saw.firstRunStep";

export type FirstRunStep = "welcome" | "model" | "storage" | "checkup";

export function readOnboarded(): boolean {
  try { return localStorage.getItem(ONBOARDED) === "1"; } catch { return true; }
}

export function readFirstRunStep(): FirstRunStep | null {
  try {
    const raw = localStorage.getItem(STEP);
    if (raw === "welcome" || raw === "model" || raw === "storage" || raw === "checkup") return raw;
  } catch { /* ignore */ }
  return null;
}

function notify() {
  try { window.dispatchEvent(new Event("saw-first-run")); } catch { /* ignore */ }
}

export function writeFirstRunStep(step: FirstRunStep | null) {
  try {
    if (step) localStorage.setItem(STEP, step);
    else localStorage.removeItem(STEP);
  } catch { /* ignore */ }
  notify();
}

export function completeFirstRun() {
  try {
    localStorage.setItem(ONBOARDED, "1");
    localStorage.removeItem(STEP);
  } catch { /* ignore */ }
  notify();
}

export function skipFirstRun(resume: FirstRunStep | null) {
  try {
    localStorage.setItem(ONBOARDED, "1");
    if (resume) localStorage.setItem(STEP, resume);
    else localStorage.removeItem(STEP);
  } catch { /* ignore */ }
  notify();
}
