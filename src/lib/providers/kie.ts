/**
 * محوّل kie.ai — Jobs API الموحد (المزود الأساسي).
 * ------------------------------------------------------------
 * أشكال حقيقية مقاسة فعليًا (2026-11):
 *   POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
 *   GET  /api/v1/jobs/recordInfo?taskId=… → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *          "resultJson":"{\"resultUrls\":[\"https://…\"]}","failMsg":"…"}}
 * ملاحظة حرجة: kie.ai يعيد HTTP 200 حتى عند الخطأ — رمز الحالة الحقيقي داخل الجسم
 * في الحقل code، لذلك نستخدمه كـ status فعّال عند التصنيف.
 * resultJson نص JSON داخل JSON ويتطلب JSON.parse ثانيًا.
 */
import { ProviderError, type CheckTaskResult, type ProviderAdapter, type ProviderKey } from "./types";

const KIE_BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

/** نداء موحّد مع تحويل الأخطاء إلى ProviderError بغضّ النظر عن شكل إبلاغ kie */
async function kieCall(
  key: ProviderKey,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let httpStatus = 0;
  let body: unknown = null;
  try {
    const res = await fetch(`${KIE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    httpStatus = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
      if (httpStatus >= 400) {
        throw new ProviderError(httpStatus, `kie: استجابة غير صالحة (HTTP ${httpStatus})`);
      }
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    // انقطاع شبكة/مهلة → تصنيف temporary (status=0)
    throw new ProviderError(0, `kie: خطأ شبكة أو مهلة — ${(e as Error).message}`);
  }

  const obj = body as { code?: number; msg?: string; message?: string; data?: unknown } | null;
  // الحالة الفعّالة: code داخل الجسم إن وُجد و>=400 وإلا حالة HTTP
  const effective = typeof obj?.code === "number" ? obj.code : httpStatus;
  if (effective >= 400) {
    throw new ProviderError(effective, obj?.msg || obj?.message || `kie: HTTP ${httpStatus}`);
  }
  return obj?.data ?? obj;
}

/** تحليل حقل resultJson النصي (JSON داخل JSON) بصورة دفاعية */
function parseResultUrls(data: Record<string, unknown>): string[] {
  let raw: unknown = data.resultUrls;
  if (typeof data.resultJson === "string") {
    try {
      raw = JSON.parse(data.resultJson);
    } catch {
      raw = null;
    }
  }
  if (typeof raw === "string") raw = [raw];
  if (Array.isArray(raw)) {
    return raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  }
  const obj = raw as Record<string, unknown> | null;
  if (obj && Array.isArray(obj.resultUrls)) {
    return (obj.resultUrls as unknown[]).filter(
      (u): u is string => typeof u === "string" && /^https?:\/\//.test(u)
    );
  }
  return [];
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const data = (await kieCall(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input }),
    })) as { taskId?: string } | null;
    if (!data || typeof data.taskId !== "string" || !data.taskId) {
      throw new ProviderError(500, "kie: استجابة createTask بلا taskId", "provider");
    }
    return { providerTaskId: data.taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const data = (await kieCall(
      key,
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    )) as Record<string, unknown> | null;

    if (!data) throw new ProviderError(500, "kie: استجابة recordInfo فارغة", "temporary");

    const state = String(data.state ?? "").toLowerCase();
    const failMsg = typeof data.failMsg === "string" ? data.failMsg : "";

    if (state === "success" || state === "completed" || state === "complete") {
      const urls = parseResultUrls(data);
      if (urls.length === 0) {
        return { status: "failed", error: "kie: اكتملت المهمة دون روابط نتائج" };
      }
      return { status: "completed", urls };
    }

    if (state === "fail" || state === "failed" || state === "error") {
      return { status: "failed", error: failMsg || "kie: فشل التوليد لدى المزود" };
    }

    // waiting | queuing | generating — تقدير تقدم مبسّط لعرضه حيًا
    const heuristic =
      state === "waiting" ? 15 : state === "queuing" ? 30 : state === "generating" ? 60 : 20;
    const explicit = typeof data.progress === "number" ? (data.progress as number) : undefined;
    const progress =
      explicit !== undefined
        ? explicit <= 1
          ? Math.round(explicit * 100)
          : Math.round(explicit)
        : heuristic;
    return { status: "processing", progress };
  },
};
