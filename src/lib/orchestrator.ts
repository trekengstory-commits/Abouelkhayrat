/**
 * منسّق التوليد — التبديل التسلسلي الصارم «لا توقف أبدًا».
 * ------------------------------------------------------------
 * القواعد الذهبية المنفَّذة هنا:
 * 1) تُسجَّل المهمة في Turso قبل أي نداء خارجي.
 * 2) تُجرَّب المفاتيح بترتيب إضافتها الصارم (created_at ASC, id ASC).
 * 3) أي خطأ مفتاح/رصيد → تبديل صامت للمفتاح التالي مع استئناف **نفس المهمة
 *    بنفس task_id** — نموذج الذكاء الاصطناعي لا يرى شيئًا من ذلك أبدًا.
 * 4) خطأ معطيات (params) → توقف فوري (تبديل المفاتيح لا يحله).
 * 5) فشل الإنشاء على كل المفاتيح → تبقى المهمة processing برسالة داخلية
 *    «بانتظار توفر مفتاح صالح…» وتُعاد المحاولة تلقائيًا مع كل get_task
 *    بعد تهدئة ~45 ثانية.
 */
import {
  ensureSchema,
  getKeyPool,
  getTask,
  insertTask,
  markKeyAttempt,
  setKeyStatus,
  updateTask,
  type KeyRow,
  type TaskAttempt,
  type TaskRow,
} from "./turso";
import { resolveModel, type ModelDef } from "./models";
import { classifyProviderError, getAdapter, looksLikeKeyIssue, toProviderKey } from "./keys";
import { ProviderError } from "./providers/types";
import { refreshMergeTask } from "./merger";

const POLL_INTERVAL_MS = 3_000;
/** تهدئة قبل إعادة محاولة الإنشاء على كل المفاتيح مع كل get_task */
const RETRY_COOLDOWN_MS = 45_000;
/** نافذة الاستقصاء القصيرة بعد نجاح إعادة الإنشاء أثناء get_task */
const REFRESH_POLL_MS = 15_000;

/** لا توجد مفاتيح نشطة لموديل معين */
export class NoKeysError extends Error {
  constructor(model: string) {
    super(`no keys for ${model}`);
  }
}

export type NotifyFn = (percent: number, message: string) => Promise<void> | void;

interface GenContext {
  taskId: string;
  model: ModelDef;
  input: Record<string, unknown>;
  notify?: NotifyFn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJsonSafe<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function attemptRec(
  key: KeyRow,
  ok: boolean,
  errorClass?: string,
  error?: string
): TaskAttempt {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || `${key.provider}-key`,
    ok,
    errorClass,
    error,
    at: new Date().toISOString(),
  };
}

interface CreateOutcome {
  ok: boolean;
  /** اكتملت فورًا (صور متزامنة) */
  sync?: boolean;
  /** خطأ معطيات — المهمة أُغلقت كفاشلة */
  fatal?: boolean;
  keyIndex?: number;
  keyId?: string;
}

/**
 * تجربة المرشحين بالترتيب بدءًا من fromIndex — أول نجاح يربط المهمة بالمزود والمفتاح.
 * كل محاولة (نجاح أو فشل + فئتها) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 */
async function tryCreateTask(
  ctx: GenContext,
  pool: KeyRow[],
  fromIndex: number
): Promise<CreateOutcome> {
  for (let i = Math.max(0, fromIndex); i < pool.length; i++) {
    const row = pool[i];
    const key = toProviderKey(row);
    const adapter = getAdapter(key.provider);
    const providerModel = ctx.model.providerModel[key.provider] ?? ctx.model.canonical;

    try {
      if (ctx.model.type === "image" && adapter.createImageSync) {
        // صور متزامنة إن كان المزود يدعمها — تعيد الروابط فورًا
        const inputWithModel = { ...ctx.input, __providerModel: providerModel };
        const { urls } = await adapter.createImageSync(key, inputWithModel);
        await markKeyAttempt(row, { ok: true });
        await updateTask(ctx.taskId, {
          provider: key.provider,
          keyId: key.id,
          status: "completed",
          progress: 100,
          resultUrls: urls,
          appendAttempts: [attemptRec(row, true)],
        });
        return { ok: true, sync: true, keyIndex: i, keyId: row.id };
      }

      const { providerTaskId } = await adapter.createTask(key, providerModel, ctx.input);
      await markKeyAttempt(row, { ok: true });
      await updateTask(ctx.taskId, {
        provider: key.provider,
        keyId: key.id,
        providerTaskId,
        status: "processing",
        progress: 15,
        appendAttempts: [attemptRec(row, true)],
      });
      return { ok: true, keyIndex: i, keyId: row.id };
    } catch (e) {
      const perr = e instanceof ProviderError ? e : new ProviderError(0, String((e as Error)?.message ?? e));
      const cls = classifyProviderError(perr);
      await markKeyAttempt(row, { ok: false, errorClass: cls, error: perr.message });
      const rec = attemptRec(row, false, cls, perr.message);

      if (cls === "params") {
        // توقف فوري — تبديل المفاتيح لن يحل خطأ معطيات
        await updateTask(ctx.taskId, {
          status: "failed",
          errorMessage: `خطأ في معطيات الطلب: ${perr.message}`,
          appendAttempts: [rec],
        });
        return { ok: false, fatal: true };
      }
      if (cls === "disabled") await setKeyStatus(row.id, "disabled", perr.message);
      if (cls === "exhausted") await setKeyStatus(row.id, "exhausted", perr.message);
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي بصمت
      await updateTask(ctx.taskId, { appendAttempts: [rec] });
    }
  }
  return { ok: false };
}

/**
 * إعادة إنشاء المهمة نفسها (نفس task_id) على المفتاح **التالي** في الترتيب
 * بعد فشل مفتاح في منتصف المهمة — بصمت تام من وجهة نظر العميل.
 */
async function recreateOnNextKey(
  ctx: GenContext,
  failedKeyId: string | null
): Promise<{ ok: boolean; sync?: boolean; pool: KeyRow[]; keyIndex: number; fatal?: boolean }> {
  const pool = await getKeyPool(ctx.model.providers);
  let from = 0;
  if (failedKeyId) {
    const idx = pool.findIndex((k) => k.id === failedKeyId);
    from = idx >= 0 ? idx + 1 : 0;
  }
  const res = await tryCreateTask(ctx, pool, from);
  return { ok: res.ok, sync: res.sync, fatal: res.fatal, pool, keyIndex: res.keyIndex ?? 0 };
}

/** حساب نسبة تقدم معروضة (المزود إن زوّدها، وإلا زحف تدريجي حتى 90%) */
function computeProgress(explicit: number | undefined, current: number): number {
  if (typeof explicit === "number" && !Number.isNaN(explicit)) {
    return Math.max(1, Math.min(99, explicit <= 1 ? Math.round(explicit * 100) : Math.round(explicit)));
  }
  return Math.min(90, Math.max(current, current + 4));
}

/**
 * حلقة الاستقصاء حتى اكتمال المهمة أو فشلها الحقيقي أو انتهاء نافذة الانتظار.
 * تُحدِّث Turso عند كل استقصاء وتبث إشعارات تقدم كل ~3 ثوانٍ.
 */
async function pollLoop(
  ctx: GenContext,
  firstCheckKeyId: string | null,
  deadlineMs: number
): Promise<TaskRow> {
  let pool = await getKeyPool(ctx.model.providers);
  let idx = firstCheckKeyId ? pool.findIndex((k) => k.id === firstCheckKeyId) : -1;
  if (idx < 0) idx = 0;

  for (;;) {
    const task = await getTask(ctx.taskId);
    if (!task || task.status === "completed" || task.status === "failed") {
      return task!;
    }
    const keyRow = pool[idx];
    if (!keyRow) break; // لا مفتاح نشط للمتابعة
    if (!task.providerTaskId) break; // لا مهمة لدى المزود بعد

    const key = toProviderKey(keyRow);
    const adapter = getAdapter(key.provider);

    try {
      const res = await adapter.checkTask(key, task.providerTaskId);

      if (res.status === "completed") {
        return (
          (await updateTask(ctx.taskId, {
            status: "completed",
            progress: 100,
            resultUrls: res.urls ?? [],
          })) ?? task
        );
      }

      if (res.status === "failed") {
        const { issue, cls } = looksLikeKeyIssue(res.error ?? "");
        if (!issue) {
          // فشل حقيقي (انتهاك سياسة/معطيات المزود) — يُعرض سببه للعميل
          return (
            (await updateTask(ctx.taskId, {
              status: "failed",
              errorMessage: res.error ?? "فشل التوليد لدى المزود",
            })) ?? task
          );
        }
        // فشل مفتاح/رصيد في منتصف المهمة → علّم المفتاح وأعد الإنشاء على التالي (بنفس task_id)
        await markKeyAttempt(keyRow, { ok: false, errorClass: cls, error: res.error });
        await setKeyStatus(keyRow.id, cls === "disabled" ? "disabled" : "exhausted", res.error);
        await updateTask(ctx.taskId, {
          appendAttempts: [attemptRec(keyRow, false, cls, res.error)],
        });
        const restart = await recreateOnNextKey(ctx, keyRow.id);
        if (restart.fatal) return (await getTask(ctx.taskId))!;
        if (!restart.ok) {
          return (
            (await updateTask(ctx.taskId, {
              status: "processing",
              errorMessage: "بانتظار توفر مفتاح صالح…",
            })) ?? task
          );
        }
        if (restart.sync) return (await getTask(ctx.taskId))!;
        pool = restart.pool;
        idx = restart.keyIndex;
        continue;
      }

      // processing — حدّث التقدم وابثّ إشعارًا (رسائل عامة لا تذكر المفاتيح أبدًا)
      const pct = computeProgress(res.progress, task.progress);
      await updateTask(ctx.taskId, { status: "processing", progress: pct });
      if (ctx.notify) {
        try {
          await ctx.notify(pct, `قيد التوليد… ${pct}%`);
        } catch {
          /* العميل انقطع — نكمل التحديث في القاعدة بصمت */
        }
      }
    } catch (e) {
      const perr = e instanceof ProviderError ? e : new ProviderError(0, String((e as Error)?.message ?? e));
      const cls = classifyProviderError(perr);
      if (cls === "disabled" || cls === "exhausted") {
        // مفتاح المتابعة صار غير صالح أثناء الاستقصاء → أعد الإنشاء على التالي
        await markKeyAttempt(keyRow, { ok: false, errorClass: cls, error: perr.message });
        await setKeyStatus(keyRow.id, cls, perr.message);
        await updateTask(ctx.taskId, {
          appendAttempts: [attemptRec(keyRow, false, cls, perr.message)],
        });
        const restart = await recreateOnNextKey(ctx, keyRow.id);
        if (restart.fatal) return (await getTask(ctx.taskId))!;
        if (!restart.ok) {
          return (
            (await updateTask(ctx.taskId, {
              status: "processing",
              errorMessage: "بانتظار توفر مفتاح صالح…",
            })) ?? task
          );
        }
        if (restart.sync) return (await getTask(ctx.taskId))!;
        pool = restart.pool;
        idx = restart.keyIndex;
        continue;
      }
      // provider/params/temporary أثناء الاستقصاء → عابر: واصل حتى نهاية النافذة
    }

    if (Date.now() >= deadlineMs) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return (await getTask(ctx.taskId))!;
}

export interface RunGenerationOptions {
  type: "image" | "video";
  model: ModelDef;
  input: Record<string, unknown>;
  /** نافذة الانتظار 0–240 ثانية */
  waitSeconds: number;
  notify?: NotifyFn;
}

/** التدفق الكامل لأداة generate_image / generate_video */
export async function runGeneration(opts: RunGenerationOptions): Promise<TaskRow> {
  await ensureSchema();
  const pool = await getKeyPool(opts.model.providers);
  if (pool.length === 0) throw new NoKeysError(opts.model.canonical);

  // سجّل المهمة قبل أي نداء خارجي — تبقى قابلة للتتبع مهما حدث
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    type: opts.type,
    model: opts.model.canonical,
    prompt: String(opts.input.prompt ?? ""),
    params: opts.input,
    status: "processing",
    progress: 5,
  });
  const ctx: GenContext = {
    taskId,
    model: opts.model,
    input: opts.input,
    notify: opts.notify,
  };

  const start = await tryCreateTask(ctx, pool, 0);
  if (start.fatal) return (await getTask(taskId))!;
  if (!start.ok) {
    // فشل على كل المفاتيح → processing + إعادة محاولة تلقائية مع كل get_task
    return (
      (await updateTask(taskId, {
        status: "processing",
        errorMessage: "بانتظار توفر مفتاح صالح…",
      })) ?? (await getTask(taskId))!
    );
  }
  if (start.sync) return (await getTask(taskId))!;

  const deadline = Date.now() + Math.max(0, Math.min(240, opts.waitSeconds)) * 1000;
  return await pollLoop(ctx, start.keyId ?? null, deadline);
}

/**
 * refreshTask — يستدعيه get_task: يحدّث المهمة الجارية حيًا من المزود،
 * ويعيد الإنشاء على المفتاح التالي عند مشاكل المفاتيح (بتهدئة 45 ثانية).
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;
  if (task.type === "merge") return refreshMergeTask(taskId);

  const model = resolveModel(task.model);
  if (!model) return task;

  const input = parseJsonSafe<Record<string, unknown>>(task.paramsJson, {});
  const ctx: GenContext = { taskId, model, input };

  if (!task.providerTaskId) {
    // لم ينجح الإنشاء بعد — تهدئة ثم إعادة محاولة كامل المجمّع من البداية
    const last = task.attempts.length
      ? new Date(task.attempts[task.attempts.length - 1].at).getTime()
      : 0;
    if (Date.now() - last < RETRY_COOLDOWN_MS) return task;
    const start = await tryCreateTask(ctx, await getKeyPool(model.providers), 0);
    if (start.fatal) return (await getTask(taskId))!;
    if (!start.ok) {
      return (
        (await updateTask(taskId, { errorMessage: "بانتظار توفر مفتاح صالح…" })) ?? task
      );
    }
    if (start.sync) return (await getTask(taskId))!;
  }

  // استقصاء قصير — يكفي لاكتمال مهام الصور، والفيديو يعود processing للعميل
  return await pollLoop(ctx, task.keyId, Date.now() + REFRESH_POLL_MS);
}
