/**
 * محوّل CometAPI — المزود الثاني (api.cometapi.com).
 * ------------------------------------------------------------
 * الصور: نقطة متوافقة مع OpenAI ‏POST /v1/images/generations تعيد الرابط فورًا.
 * الفيديو: نقاط مهام غير متزامنة بنمط create/check. توثيق CometAPI يذكر
 *   نقطة موحّدة جديدة ‎/v1/videos (بصيغة Runway) ونقطة خاصة بموديلات Grok
 *   ‎/grok/v1/videos/generations — نجرب الموحّدة أولًا ثم البديلة عند 404،
 *   ونتذكر المسار الذي نجح لكل مهمة (خريطة في الذاكرة).
 * ملاحظة صريحة: لم يُختبر هذا المحوّل بمفتاح حقيقي بعد (لا يوجد مفتاح CometAPI
 * في هذه البيئة) — أي اختلاف مستقبلي سيُصنَّف آليًا (provider/temporary) وسيُجري
 * النظام التبديل إلى kie.ai دون توقف، وذلك بحكم طبقة التصنيف.
 */
import { ProviderError, type CheckTaskResult, type ProviderAdapter, type ProviderKey } from "./types";

const COMET_BASE = (process.env.COMETAPI_BASE_URL || "https://api.cometapi.com").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;

/** المسارات التي نجحت سابقًا لكل معرّف مهمة (لتسريع checkTask) */
const knownVideoCheckPaths = new Map<string, string>();

async function cometCall(
  key: ProviderKey,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(`${COMET_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(0, `cometapi: خطأ شبكة أو مهلة — ${(e as Error).message}`);
  }
  if (status >= 400) {
    const obj = body as { error?: { message?: string }; message?: string } | null;
    const msg = obj?.error?.message || obj?.message || `cometapi: HTTP ${status}`;
    throw new ProviderError(status, msg);
  }
  return { status, body };
}

/** استخراج معرّف المهمة من أشكال استجابة محتملة */
function extractTaskId(body: unknown): string | null {
  const seen = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const obj = body as Record<string, unknown> | null;
  if (!obj) return null;
  const direct =
    seen(obj.id) ??
    seen(obj.taskId) ??
    seen(obj.task_id) ??
    (obj.data ? seen((obj.data as Record<string, unknown>).id) : null) ??
    (obj.data ? seen((obj.data as Record<string, unknown>).taskId) : null);
  return direct;
}

/** استخراج رابط/روابط الفيديو من أشكال استجابة محتملة */
function extractVideoUrls(body: unknown): string[] {
  const urls: string[] = [];
  const pushIfUrl = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
  };
  const obj = body as Record<string, unknown> | null;
  if (!obj) return urls;
  pushIfUrl(obj.video_url);
  pushIfUrl(obj.videoUrl);
  pushIfUrl(obj.url);
  if (Array.isArray(obj.output)) obj.output.forEach(pushIfUrl);
  else pushIfUrl(obj.output);
  const data = obj.data as Record<string, unknown> | undefined;
  if (data) {
    pushIfUrl(data.video_url);
    pushIfUrl(data.url);
    if (Array.isArray(data.output)) data.output.forEach(pushIfUrl);
  }
  return [...new Set(urls)];
}

/** خرائط تحويل بسيطة لمعاملات الصور نحو الصيغة المتوافقة مع OpenAI */
function aspectRatioToSize(ar?: string): string | undefined {
  switch (ar) {
    case "1:1":
      return "1024x1024";
    case "16:9":
    case "4:3":
    case "3:2":
    case "21:9":
    case "2:1":
      return "1536x1024";
    case "9:16":
    case "3:4":
    case "2:3":
    case "9:21":
    case "1:2":
      return "1024x1536";
    default:
      return undefined; // auto — نترك المزود يقرر
  }
}

export const cometApiAdapter: ProviderAdapter = {
  /** صور متزامنة — تعيد الروابط فورًا */
  async createImageSync(key: ProviderKey, input: Record<string, unknown>) {
    const size = aspectRatioToSize(input.aspect_ratio as string | undefined);
    const body: Record<string, unknown> = {
      model: input.__providerModel,
      prompt: input.prompt,
      n: 1,
      response_format: "url",
    };
    if (size) body.size = size;

    const { body: resp } = await cometCall(key, "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const obj = resp as { data?: Array<{ url?: string; b64_json?: string }> } | null;
    const urls = (obj?.data ?? [])
      .map((d) => d.url)
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
    if (urls.length === 0) {
      // b64_json وحده لا يصلح: سياسة المشروع «روابط فقط — لا تنزيل وسائط»
      throw new ProviderError(
        502,
        "cometapi: استجابة الصور بلا رابط عام (b64_json فقط)",
        "provider"
      );
    }
    return { urls };
  },

  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      duration: input.duration,
      aspect_ratio: input.aspect_ratio,
      enable_audio: input.enable_audio,
    };
    if (typeof input.image_url === "string" && input.image_url) body.image_url = input.image_url;
    if (typeof input.resolution === "string" && input.resolution) body.resolution = input.resolution;

    // نجرب النقطة الموحّدة ثم نقطة Grok الخاصة عند 404
    const candidates = ["/v1/videos", "/grok/v1/videos/generations"];
    let lastErr: ProviderError | null = null;
    for (const path of candidates) {
      try {
        const { body: resp } = await cometCall(key, path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const taskId = extractTaskId(resp);
        if (!taskId) {
          throw new ProviderError(502, "cometapi: استجابة إنشاء الفيديو بلا معرّف مهمة", "provider");
        }
        knownVideoCheckPaths.set(taskId, path);
        return { providerTaskId: taskId };
      } catch (e) {
        lastErr = e instanceof ProviderError ? e : new ProviderError(0, String(e));
        if (lastErr.status === 404) continue; // جرّب المسار البديل
        throw lastErr;
      }
    }
    throw lastErr ?? new ProviderError(404, "cometapi: لا توجد نقطة فيديو متاحة", "provider");
  },

  async checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult> {
    const remembered = knownVideoCheckPaths.get(providerTaskId);
    const candidates = remembered
      ? [remembered]
      : ["/v1/videos", "/grok/v1/videos/generations"];

    let lastErr: ProviderError | null = null;
    for (const base of candidates) {
      try {
        const { body: resp } = await cometCall(key, `${base}/${encodeURIComponent(providerTaskId)}`);
        if (base !== remembered) knownVideoCheckPaths.set(providerTaskId, base);

        const obj = resp as Record<string, unknown> | null;
        const statusRaw = String(obj?.status ?? obj?.state ?? "").toLowerCase();
        const done = ["succeeded", "success", "completed", "complete", "finished", "done"];
        const failed = ["failed", "error", "cancelled", "canceled", "failure"];

        if (done.includes(statusRaw)) {
          const urls = extractVideoUrls(resp);
          if (urls.length === 0) return { status: "failed", error: "cometapi: اكتملت المهمة دون رابط فيديو" };
          return { status: "completed", urls };
        }
        if (failed.includes(statusRaw)) {
          const errObj = obj?.error as { message?: string } | undefined;
          return { status: "failed", error: errObj?.message || "cometapi: فشل توليد الفيديو" };
        }
        let progress = typeof obj?.progress === "number" ? (obj.progress as number) : undefined;
        if (progress !== undefined && progress <= 1) progress = Math.round(progress * 100);
        return { status: "processing", progress };
      } catch (e) {
        lastErr = e instanceof ProviderError ? e : new ProviderError(0, String(e));
        if (lastErr.status === 404 && !remembered) continue;
        throw lastErr;
      }
    }
    throw lastErr ?? new ProviderError(404, "cometapi: المهمة غير موجودة", "provider");
  },
};
