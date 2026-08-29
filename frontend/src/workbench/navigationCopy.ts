import { useI18n } from "../i18n";

const COPY = {
  en: {
    investigations: "Investigations",
    newInvestigation: "New investigation",
    search: "Search investigations…",
    clearSearch: "Clear investigation search",
    noInvestigations: "No investigations yet.",
    noResults: "No matching investigations.",
    pinned: "Pinned",
    archived: "Archived",
    contextFallback: "General storage investigation",
    findingShort: (n: number) => `${n}F`,
    runShort: (n: number) => `${n}R`,
    running: "Agent running",
    uploading: "Uploading evidence",
    failed: "Needs attention",
    ready: "Ready",
    searchExisting: "Find investigation",
  },
  zh: {
    investigations: "Investigations",
    newInvestigation: "新调查",
    search: "搜索 Investigations…",
    clearSearch: "清除调查搜索",
    noInvestigations: "还没有 Investigation。",
    noResults: "没有匹配的 Investigation。",
    pinned: "Pinned",
    archived: "Archived",
    contextFallback: "通用对象存储调查",
    findingShort: (n: number) => `${n}F`,
    runShort: (n: number) => `${n}R`,
    running: "Agent 运行中",
    uploading: "正在上传 Evidence",
    failed: "需要处理",
    ready: "Ready",
    searchExisting: "查找 Investigation",
  },
} as const;

export function useNavigationCopy() {
  const { lang } = useI18n();
  return COPY[lang];
}
