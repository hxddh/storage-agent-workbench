/** Runtime analysis documents as projected by GET /agent-tasks/{id}/provenance. */

export type Coverage = {
  object_count?: number | null;
  bytes?: number | null;
  total_requests?: number | null;
  inventory_as_of?: string | null;
  unknown_age_ratio?: number | null;
  unknown_size_ratio?: number | null;
  parsed_fraction?: number | null;
  note?: string | null;
  truncated?: boolean;
};

export type ProvenanceChain = {
  kind: "execution" | "artifact" | "tool";
  id: string | null;
  tool: string | null;
  created_at: string | null;
  coverage: Coverage | null;
  review: "overview" | "evidence" | "execution" | "report";
};

export type ProvenanceFinding = {
  id: string;
  title: string | null;
  severity: string | null;
  category: string | null;
  confidence: string | null;
  kind: string | null;
  interpretation: string | null;
  source_run_id: string | null;
  created_at: string | null;
  source_tool: string | null;
  chain: ProvenanceChain | null;
  gap: "no_direct_evidence" | null;
};

export type ProvenanceFigure = {
  id: string;
  label: string;
  value: number | null;
  estimate: boolean;
  present: boolean;
  coverage: Coverage | null;
  chain: ProvenanceChain | null;
  gap: "no_direct_evidence" | null;
};

export type AnalysisDocument = {
  tool?: string | null;
  call_id?: string | null;
  run_id?: string | null;
  artifact_id?: string | null;
  created_at?: string | null;
  document: Record<string, unknown>;
  coverage: Coverage | null;
};

export type TaskProvenance = {
  task_id: string;
  findings: ProvenanceFinding[];
  figures: ProvenanceFigure[];
  analysis: {
    cost: AnalysisDocument | null;
    inventory: AnalysisDocument | null;
    access_log: AnalysisDocument | null;
    drift: AnalysisDocument | null;
  };
};

export type HorizonPoint = {
  day: number;
  classes: Record<string, number>;
  baselineCost: number | null;
  candidateCost: number | null;
};

export type CostChart = {
  kind: "cost";
  estimate: true;
  priceConfirmed: boolean;
  coverage: Coverage | null;
  gaps: Array<{ code?: string; message?: string }>;
  horizons: HorizonPoint[];
  delta: number | null;
  classes: string[];
};

export type DistChart = {
  kind: "distribution";
  estimate: boolean;
  coverage: Coverage | null;
  age: Array<{ label: string; count: number; size: number | null }>;
  storageClass: Array<{ label: string; count: number; size: number | null }>;
  jointObserved: false;
};

export type DriftChart = {
  kind: "drift";
  estimate: boolean;
  coverage: Coverage | null;
  gap: string | null;
  added: number;
  resolved: number;
  stillPresent: number;
  objectDelta: number | null;
  sizeDelta: number | null;
  trendNote: string | null;
};

export type AccessChart = {
  kind: "access";
  estimate: boolean;
  coverage: Coverage | null;
  latency: { p50: number; p95: number; p99: number; max: number; measured: number } | null;
  methods: Array<{ label: string; count: number }>;
  statuses: Array<{ label: string; count: number }>;
};
