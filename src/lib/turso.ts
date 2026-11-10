/**
 * طبقة قاعدة البيانات — Turso عبر HTTP (libSQL client)
 * ------------------------------------------------------------
 * قرار معماري: نستخدم @libsql/client عبر HTTP لأنه الوحيد المتوافق
 * مع بيئة Vercel serverless (لا ملفات SQLite محلية في الإنتاج).
 * المخطط يُنشأ عند أول وصول (ensureSchema) فلا حاجة لأداة migrations.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;
let seedPromise: Promise<void> | null = null;

/** عميل واحد مشترك لكل التطبيق */
export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة — اضبطهما في .env.local وعلى Vercel."
      );
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  provider TEXT,
  provider_task_id TEXT,
  key_id TEXT,
  model TEXT NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  result_urls_json TEXT,
  error_message TEXT,
  attempts_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT DEFAULT '',
  api_key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys(provider, created_at);
`;

/** تُنشئ الجداول مرة واحدة لكل عملية (process) عند أول وصول */
export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await getTurso().executeMultiple(SCHEMA_SQL);
      // زرع المفاتيح الأولية من متغيرات البيئة (مرة واحدة فقط عند فراغ الجدول)
      seedPromise = seedInitialKeys();
      await seedPromise;
    })().catch((e) => {
      schemaPromise = null; // اسمح بمحاولة لاحقة عند فشل عابر
      throw e;
    });
  }
  return schemaPromise;
}

/** فحص جهوزية قاعدة البيانات */
export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/* ============================ الأنواع ============================ */

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyProvider = "kie" | "cometapi";

/** محاولة واحدة على مفتاح/مزود — تُسجَّل دائمًا (نجاحًا أو فشلًا) */
export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: TaskProvider_ | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  paramsJson: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

type TaskProvider_ = "kie" | "cometapi" | "merger";

export interface KeyRow {
  id: string;
  provider: KeyProvider;
  label: string;
  apiKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/* ========================= تحويل الصفوف ========================= */

function parseJsonSafe<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as TaskProvider_) ?? null,
    providerTaskId: (r.provider_task_id as string) ?? null,
    keyId: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as TaskType,
    prompt: (r.prompt as string) ?? "",
    paramsJson: (r.params_json as string) ?? "{}",
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    resultUrls: parseJsonSafe<string[]>(r.result_urls_json as string, []),
    errorMessage: (r.error_message as string) ?? null,
    attempts: parseJsonSafe<TaskAttempt[]>(r.attempts_json as string, []),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: (r.completed_at as string) ?? null,
  };
}

function rowToKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: r.provider as KeyProvider,
    label: (r.label as string) ?? "",
    apiKey: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usageCount: Number(r.usage_count ?? 0),
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    lastUsedAt: (r.last_used_at as string) ?? null,
    lastCheckedAt: (r.last_checked_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdAt: String(r.created_at),
  };
}

/* ===================== عمليات المهام (tasks) ===================== */

export interface NewTaskInput {
  id: string;
  type: TaskType;
  model: string;
  prompt?: string;
  params?: Record<string, unknown>;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  status?: TaskStatus;
  progress?: number;
}

export async function insertTask(input: NewTaskInput): Promise<TaskRow> {
  const db = getTurso();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.provider ?? null,
      input.providerTaskId ?? null,
      input.keyId ?? null,
      input.model,
      input.type,
      input.prompt ?? "",
      JSON.stringify(input.params ?? {}),
      input.status ?? "processing",
      input.progress ?? 5,
    ] satisfies InValue[],
  });
  const t = await getTask(input.id);
  if (!t) throw new Error("فشل إنشاء المهمة في قاعدة البيانات");
  return t;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const res = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  status?: TaskStatus;
  progress?: number;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  resultUrls?: string[];
  errorMessage?: string | null;
  appendAttempts?: TaskAttempt[];
}

/** تحديث جزئي للمهمة: يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const current = await getTask(id);
  if (!current) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];

  const attempts = [...current.attempts, ...(patch.appendAttempts ?? [])];

  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.providerTaskId !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.providerTaskId);
  }
  if (patch.keyId !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.keyId);
  }
  if (patch.resultUrls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(JSON.stringify(patch.resultUrls));
  }
  if (patch.errorMessage !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.errorMessage);
  }
  if (patch.appendAttempts && patch.appendAttempts.length > 0) {
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }

  args.push(id);
  await getTurso().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit = 10,
  filter?: { type?: TaskType; status?: TaskStatus }
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  args.push(Math.min(50, Math.max(1, limit)));
  const res = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return res.rows.map((r) => rowToTask(r as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

export async function taskStats(): Promise<TaskStats> {
  const res = await getTurso().execute(
    "SELECT status, COUNT(*) AS c FROM tasks GROUP BY status"
  );
  const byStatus: Record<string, number> = {};
  for (const r of res.rows) byStatus[String(r.status)] = Number(r.c);
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    completed: byStatus["completed"] ?? 0,
    failed: byStatus["failed"] ?? 0,
    active: (byStatus["processing"] ?? 0) + (byStatus["pending"] ?? 0),
  };
}

/* ===================== عمليات المفاتيح (api_keys) ===================== */

export async function listKeys(): Promise<KeyRow[]> {
  const res = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

/**
 * تجيب مفاتيح المزودات المطلوبة **غير المعطّلة** بالترتيب التسلسلي الصارم
 * (أول مفتاح أُضيف يُجرَّب أولًا) — ليست round-robin وليست «الأقل استخدامًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة عمدًا؛ الاستثناء الوحيد disabled.
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
}

export async function findKeyByValue(
  provider: string,
  apiKey: string
): Promise<KeyRow | null> {
  const res = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (res.rows.length === 0) return null;
  return rowToKey(res.rows[0] as unknown as Record<string, unknown>);
}

export async function getKey(id: string): Promise<KeyRow | null> {
  const res = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return rowToKey(res.rows[0] as unknown as Record<string, unknown>);
}

export async function createKey(input: {
  provider: KeyProvider;
  apiKey: string;
  label?: string;
}): Promise<KeyRow> {
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, input.provider, input.label ?? "", input.apiKey],
  });
  const k = await getKey(id);
  if (!k) throw new Error("فشل إضافة المفتاح");
  return k;
}

export async function deleteKey(id: string): Promise<boolean> {
  const res = await getTurso().execute({
    sql: "DELETE FROM api_keys WHERE id = ?",
    args: [id],
  });
  return res.rowsAffected > 0;
}

export async function setKeyStatus(
  id: string,
  status: KeyRow["status"],
  lastError?: string | null
): Promise<KeyRow | null> {
  const args: InValue[] = [status];
  let sql = "UPDATE api_keys SET status = ?";
  if (lastError !== undefined) {
    sql += ", last_error = ?";
    args.push(lastError);
  }
  sql += " WHERE id = ?";
  args.push(id);
  await getTurso().execute({ sql, args });
  return getKey(id);
}

/**
 * تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — يُستدعى دائمًا.
 */
export async function markKeyAttempt(
  key: KeyRow,
  result: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  const now = new Date().toISOString();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = ?,
            last_checked_at = ?,
            last_error = ?
          WHERE id = ?`,
    args: [
      result.ok ? 1 : 0,
      result.ok ? 0 : 1,
      now,
      now,
      result.ok ? null : result.error ?? "خطأ غير معروف",
      key.id,
    ],
  });
  // تصنيف disabled/exhausted يُضبط من مكان الاستدعاء عبر setKeyStatus
}

/**
 * زرع مفتاح أولي من متغيرات البيئة (KIE_API_KEY / COMETAPI_API_KEY)
 * مرة واحدة فقط عند فراغ جدول المفاتيح — لتفادي الأسرار داخل الكود.
 */
async function seedInitialKeys(): Promise<void> {
  const db = getTurso();
  const res = await db.execute("SELECT COUNT(*) AS c FROM api_keys");
  if (Number(res.rows[0]?.c ?? 0) > 0) return;
  const seeds: Array<{ provider: KeyProvider; envName: string; label: string }> = [
    { provider: "kie", envName: "KIE_API_KEY", label: "kie.ai — مفتاح أولي (متغير بيئة)" },
    { provider: "cometapi", envName: "COMETAPI_API_KEY", label: "CometAPI — مفتاح أولي (متغير بيئة)" },
  ];
  for (const s of seeds) {
    const value = process.env[s.envName]?.trim();
    if (!value) continue;
    const exists = await findKeyByValue(s.provider, value);
    if (exists) continue;
    await createKey({ provider: s.provider, apiKey: value, label: s.label });
  }
}
