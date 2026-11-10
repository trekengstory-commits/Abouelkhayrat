/** أنواع مشتركة بين الواجهة ومسارات API — للوحة الإدارة فقط */

export interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean; configured: boolean };
  authRequired: boolean;
}

export interface KeyInfo {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TaskInfo {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  provider: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface TasksResponse {
  stats: { total: number; completed: number; failed: number; active: number };
  tasks: TaskInfo[];
}

export const PROVIDER_LABEL: Record<string, string> = {
  kie: "kie.ai",
  cometapi: "CometAPI",
};

export const TYPE_LABEL: Record<string, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

/** تحويل وقت قاعدة البيانات (UTC) إلى نص عربي نسبي */
export function relativeArabicTime(dbTime: string | null): string {
  if (!dbTime) return "—";
  const iso = dbTime.includes("T") ? dbTime : dbTime.replace(" ", "T") + "Z";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return dbTime;
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "الآن";
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  const d = Math.floor(h / 24);
  return `منذ ${d} يوم`;
}
