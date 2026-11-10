/**
 * عميل خدمة دمج الفيديو — Video Merger API v2
 * ------------------------------------------------------------
 * بلا مفاتيح أو توثيق — العنوان من MERGER_API_BASE.
 * المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — بلا معاملات resolution/fps.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
 * وكل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 *
 * قواعد حاسمة:
 * - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
 * - أخطاء شبكتنا نحن (مهلة/fetch) = مؤقتة → تُستمر الاستعلامات حتى انتهاء النافذة.
 * - ‏POST .../process يُطلق خلفيًا وبمرة واحدة فقط (قفل في الذاكرة).
 */
import {
  ensureSchema,
  getTask,
  insertTask,
  updateTask,
  type TaskRow,
} from "./turso";

const DEFAULT_POLL_MS = 3_000;
const RETRY_COOLDOWN_MS = 45_000;

/** عنوان خدمة الدمج — غير مهيأ إذا غاب المتغير أو بقي placeholder */
export function mergerBase(): string | null {
  const raw = (process.env.MERGER_API_BASE || "").trim();
  if (!raw || raw.includes("xxxxxxxx")) return null;
  try {
    return new URL(raw).origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function isMergerConfigured(): boolean {
  return mergerBase() !== null;
}

/** فحص جهوزية الخدمة عبر /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, {
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

class MergerHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
  }
}
class MergerNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerNetworkError";
  }
}

/** نداء موحّد: يفرّق بين أخطاء الخدمة المعلنة (نهائية) وأخطاء شبكتنا (مؤقتة) */
async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 20_000
): Promise<Record<string, unknown>> {
  const base = mergerBase();
  if (!base) throw new MergerHttpError(0, "خدمة الدمج غير مهيأة");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MergerNetworkError(`خطأ شبكة أثناء الاتصال بخدمة الدمج: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      `HTTP ${res.status}`;
    throw new MergerHttpError(res.status, msg);
  }
  return body;
}

/* ============ تحليل الحالة (دفاعي) ============ */

const DONE_STATES = ["done", "completed", "complete", "success", "succeeded", "finished"];
const FAILED_STATES = ["error", "failed", "failure", "cancelled", "canceled"];

function parseMergerStatus(body: Record<string, unknown>): {
  state: "processing" | "completed" | "failed";
  progress: number;
  error?: string;
} {
  // جسم فيه error بدون حقل status → فشل فوري
  const errMsg = typeof body.error === "string" ? body.error : undefined;
  const statusRaw = String(body.status ?? body.state ?? "").toLowerCase();
  if (!body.status && !body.state && errMsg) {
    return { state: "failed", progress: 0, error: errMsg };
  }
  if (DONE_STATES.includes(statusRaw)) {
    return { state: "completed", progress: 100 };
  }
  if (FAILED_STATES.includes(statusRaw)) {
    return { state: "failed", progress: 0, error: errMsg || "فشلت عملية الدمج في الخدمة" };
  }
  let progress = typeof body.progress === "number" ? (body.progress as number) : 0;
  if (progress > 0 && progress <= 1) progress = progress * 100; // يأتي أحيانًا كسرًا 0..1
  return { state: "processing", progress: Math.max(1, Math.min(99, Math.round(progress))) };
}

function extractResultUrl(base: string, jobId: string, body: Record<string, unknown>): string {
  // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الملف مباشرة
  if (typeof body.videoUrl === "string" && body.videoUrl) return body.videoUrl;
  if (typeof body.video_url === "string" && body.video_url) return body.video_url;
  if (typeof body.downloadUrl === "string" && body.downloadUrl) return body.downloadUrl;
  if (typeof body.download_url === "string" && body.download_url) return body.download_url;
  return `${base}/api/jobs/${jobId}/video`;
}

/* ============ التحقق من الروابط ============ */

/** هل الرابط http/https مباشر وعام (ليس داخليًا/محليًا)؟ */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (
      h === "localhost" ||
      h === "0.0.0.0" ||
      h === "::1" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ============ قفل تنفيذ process (مرة واحدة لكل مهمة) ============ */

const processInFlight = new Set<string>();

function triggerProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      // يستغرق ~10–15 ثانية (blocking) — مهلة سخية
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 120_000);
    } catch {
      // أخطاء الخدمة المعلنة ستظهر في GET /api/jobs/{id} وتُلتقط في حلقة الاستقصاء
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============ تدفق الدمج ============ */

export interface RunMergeOptions {
  urls: string[];
  taskIds: string[];
  waitSeconds: number;
  notify?: (percent: number, message: string) => Promise<void> | void;
}

/** رسالة عربية موحّدة لرفض العدد الأقل من مقطعين */
export const MERGE_TOO_FEW =
  "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";

/**
 * تحلّ معرّفات المهام المكتملة إلى روابط (بالترتيب) — تعيد الرسالة العربية عند أي فشل.
 */
export async function resolveTaskUrls(
  taskIds: string[]
): Promise<{ urls: string[]; error?: string }> {
  const urls: string[] = [];
  const failed: string[] = [];
  for (const id of taskIds) {
    const t = await getTask(id.trim()).catch(() => null);
    const firstUrl = t?.resultUrls?.[0];
    if (t && t.status === "completed" && firstUrl) {
      urls.push(firstUrl);
    } else {
      failed.push(
        `${id} (${!t ? "غير موجودة" : t.status !== "completed" ? `حالتها ${t.status}` : "بلا روابط"})`
      );
    }
  }
  if (failed.length > 0) {
    return {
      urls,
      error: `❌ تعذّر حل المعرّفات التالية (يجب أن تكون مهام فيديو مكتملة): ${failed.join("، ")}`,
    };
  }
  return { urls };
}

/** تنفيذ الدمج كاملًا: تحقق ← تسجيل ← إنشاء مهمة لدى الخدمة ← استقصاء بنافذة الانتظار */
export async function runMerge(opts: RunMergeOptions): Promise<TaskRow> {
  await ensureSchema();

  if (!isMergerConfigured()) {
    throw new MergerConfigError(
      "❌ خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE بعنوان Video Merger API ثم أعد المحاولة."
    );
  }

  // ملاحظة: روابط task_ids تُحل في طبقة الأداة (resolveTaskUrls) وتُمرّر هنا في urls بالترتيب
  const videos = opts.urls;
  if (videos.length < 2) throw new MergerConfigError(MERGE_TOO_FEW);
  if (videos.length > 10) {
    throw new MergerConfigError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const bad = videos.filter((u) => !isPublicHttpUrl(u));
  if (bad.length > 0) {
    throw new MergerConfigError(
      `❌ الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https) — روابط غير صالحة: ${bad.join("، ")}`
    );
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    type: "merge",
    model: "video-merger",
    provider: "merger",
    prompt: `دمج ${videos.length} مقاطع`,
    params: { urls: videos },
    status: "processing",
    progress: 5,
  });

  try {
    const created = await mergerFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ videos }),
    });
    const jobId = typeof created.jobId === "string" ? created.jobId : null;
    if (!jobId) {
      await updateTask(taskId, {
        status: "failed",
        errorMessage: "استجابة خدمة الدمج بلا jobId — فشل نهائي",
      });
      return (await getTask(taskId))!;
    }
    await updateTask(taskId, { providerTaskId: jobId, progress: 10 });
    // أطلق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة)
    triggerProcess(jobId);
  } catch (e) {
    if (e instanceof MergerHttpError) {
      // خطأ معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      await updateTask(taskId, {
        status: "failed",
        errorMessage: `فشل إنشاء مهمة الدمج: ${e.message}`,
      });
      return (await getTask(taskId))!;
    }
    // خطأ شبكتنا → مؤقت: تبقى processing ويُعاد الإنشاء مع get_task بعد تهدئة
    await updateTask(taskId, { errorMessage: "تعذر الوصول لخدمة الدمج مؤقتًا — ستُعاد المحاولة تلقائيًا" });
    return (await getTask(taskId))!;
  }

  return await pollMergeTask(taskId, Date.now() + Math.max(0, Math.min(240, opts.waitSeconds)) * 1000, opts.notify);
}

export class MergerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerConfigError";
  }
}

/**
 * حلقة استقصاء مهمة دمج — تحدّث Turso عند كل استقصاء وتبث تقدمًا.
 * أخطاء الخدمة المعلنة (4xx/5xx بجسم error أو 404) = فشل نهائي فوري.
 */
async function pollMergeTask(
  taskId: string,
  deadlineMs: number,
  notify?: (percent: number, message: string) => Promise<void> | void
): Promise<TaskRow> {
  const base = mergerBase()!;
  for (;;) {
    const task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return task!;
    const jobId = task.providerTaskId;
    if (!jobId) break;

    try {
      const body = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      const parsed = parseMergerStatus(body);

      if (parsed.state === "completed") {
        const url = extractResultUrl(base, jobId, body);
        return (
          (await updateTask(taskId, {
            status: "completed",
            progress: 100,
            resultUrls: [url],
          })) ?? task
        );
      }
      if (parsed.state === "failed") {
        // فشل نهائي — لا إعادة محاولة
        return (
          (await updateTask(taskId, {
            status: "failed",
            errorMessage: parsed.error ?? "فشل الدمج في الخدمة",
          })) ?? task
        );
      }

      await updateTask(taskId, { status: "processing", progress: parsed.progress });
      if (notify) {
        try {
          await notify(parsed.progress, `قيد الدمج… ${parsed.progress}%`);
        } catch {
          /* تجاهل انقطاع العميل */
        }
      }
    } catch (e) {
      if (e instanceof MergerHttpError) {
        if (e.status === 404) {
          // مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
          return (
            (await updateTask(taskId, {
              status: "failed",
              errorMessage: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
            })) ?? task
          );
        }
        // أي خطأ HTTP معلن آخر = فشل نهائي فوري
        return (
          (await updateTask(taskId, {
            status: "failed",
            errorMessage: `فشل الدمج: ${e.message}`,
          })) ?? task
        );
      }
      // أخطاء شبكتنا = مؤقتة → تُستمر الاستعلامات حتى انتهاء النافذة
    }

    if (Date.now() >= deadlineMs) break;
    await sleep(DEFAULT_POLL_MS);
  }
  return (await getTask(taskId))!;
}

/**
 * refreshMergeTask — يستدعيه get_task لمهام الدمج:
 * يحدّث من الخدمة، ويطلق process إن لم يُنفَّذ بعد، ويعالج 404 كفشل نهائي.
 */
export async function refreshMergeTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (!task.providerTaskId) {
    // لم تُنشأ المهمة لدى الخدمة بعد — أعد المحاولة بعد تهدئة 45 ثانية
    const last = task.attempts.length
      ? new Date(task.attempts[task.attempts.length - 1].at).getTime()
      : 0;
    if (Date.now() - last < RETRY_COOLDOWN_MS) return task;
    const urls = task.paramsJson ? (JSON.parse(task.paramsJson || "{}") as { urls?: string[] }).urls ?? [] : [];
    if (urls.length >= 2 && isMergerConfigured()) {
      try {
        const created = await mergerFetch("/api/jobs", {
          method: "POST",
          body: JSON.stringify({ videos: urls }),
        });
        const jobId = typeof created.jobId === "string" ? created.jobId : null;
        if (jobId) {
          await updateTask(taskId, { providerTaskId: jobId, progress: 10 });
          triggerProcess(jobId);
        }
      } catch {
        /* تبقى processing وتُعاد المحاولة مع الاستدعاء التالي */
      }
    }
    return getTask(taskId);
  }

  const jobId = task.providerTaskId;
  // إن كانت ما تزال في الطابور فنفّذ process الآن (القفل يمنع التزامن)
  try {
    const probe = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const parsed = parseMergerStatus(probe);
    if (parsed.state === "processing" && String(probe.status ?? "").toLowerCase() === "queued") {
      triggerProcess(jobId);
    }
  } catch {
    /* يُعالج أدناه في الحلقة القصيرة */
  }

  return await pollMergeTask(taskId, Date.now() + 15_000);
}

/** حذف مهمة من خدمة الدمج (تنظيف اختياري بعد الانتهاء) */
export async function deleteMergeJob(jobId: string): Promise<boolean> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}
