import { request } from "./client";

/**
 * The storage estate (v4.0): what the Agent knows about the accounts it looks
 * after — buckets, the issues found there and their lifecycle. Reads are
 * projections of deterministic engine output. The only writes are the issue's
 * own lifecycle: generate a fix (text the user applies — storage stays
 * read-only), a read-only re-check, accepting a risk. Nothing here submits
 * Agent work; tasks keep the one execution path.
 */

export type IssueSeverity = "high" | "medium" | "low" | "info";
export type IssueStatus = "open" | "fix_proposed" | "resolved" | "recurred" | "accepted";

export interface IssueFix {
  kind: string;
  document: unknown;
  command: string;
  notes: string[];
}

export interface EstateIssue {
  id: string;
  provider_id: string;
  bucket: string;
  code: string;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  source_task_id: string | null;
  fix: IssueFix | null;
  fixable: boolean;
  last_verified_at: string | null;
  last_verify_result: "still_present" | "resolved" | "inconclusive" | null;
}

export interface WatchState {
  enabled: boolean;
  interval_hours: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
  last_task_id: string | null;
}

export interface EstateProvider {
  provider_id: string;
  name: string;
  provider_type: string;
  bucket_count: number;
  last_checked_at: string | null;
  open_issues: { high: number; medium: number; low: number };
  watch: WatchState;
}

export interface EstateOverview {
  providers: EstateProvider[];
  bucket_count: number;
  open_issue_count: number;
  issues: EstateIssue[];
  last_watch_at: string | null;
}

const q = (lang: string) => `lang=${encodeURIComponent(lang)}`;

export const getEstate = (lang: string) => request<EstateOverview>(`/estate?${q(lang)}`);

export const listIssues = (lang: string, status = "active") =>
  request<EstateIssue[]>(`/issues?status=${encodeURIComponent(status)}&${q(lang)}`);

export const proposeIssueFix = (id: string, lang: string) =>
  request<EstateIssue>(`/issues/${encodeURIComponent(id)}/fix?${q(lang)}`, { method: "POST" });

export const verifyIssue = (id: string, lang: string) =>
  request<{ result: "still_present" | "resolved" | "inconclusive"; issue: EstateIssue }>(
    `/issues/${encodeURIComponent(id)}/verify?${q(lang)}`, { method: "POST" });

export const acceptIssue = (id: string, accepted: boolean, lang: string) =>
  request<EstateIssue>(`/issues/${encodeURIComponent(id)}/accept?${q(lang)}`, {
    method: "POST",
    body: JSON.stringify({ accepted }),
  });
