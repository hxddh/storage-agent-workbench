// Base URL of the local Python FastAPI sidecar.
// Phase 01 only uses GET /health on this origin.
export const SIDECAR_BASE_URL = "http://127.0.0.1:8765";
export const HEALTH_POLL_INTERVAL_MS = 5000;
