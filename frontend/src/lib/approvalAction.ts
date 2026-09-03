import type { TFunc } from "../i18n";

/**
 * Backend gate action ids are stable snake_case (v1.16). Render them
 * localized with the raw id as fallback, so a future gate never paints
 * blank — shared by Settings (list) and the approval card (title fallback).
 */
export function approvalActionLabel(action: string, t: TFunc): string {
  if (action === "import_inventory") return t("approval.actionImportInventory");
  if (action === "import_access_log") return t("approval.actionImportAccessLog");
  if (action === "survey_account_large") return t("approval.actionSurveyLarge");
  return action;
}
