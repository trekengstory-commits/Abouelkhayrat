/**
 * خادم MCP — المسار /mcp (نقل Streamable HTTP حسب مواصفات MCP)
 * ------------------------------------------------------------
 * نستخدم SDK الرسمي بالكامل: McpServer + WebStandardStreamableHTTPServerTransport
 * (وهي نفس StreamableHTTPServerTransport الرسمية ببيئة Web Standards القياسية
 * التي يعمل عليها Next.js App Router — بلا أي JSON-RPC يدوي).
 *
 * الجلسات: حالة (stateful) بمولّد mcp-session-id، تُخزَّن في الذاكرة لكل نسخة
 * serverless (مع تنظيف للجلسات الخاملة). GET يُعاد عليه 405 وفق المواصفة
 * (لا بثًا مستقلًا من السيرفر)، وDELETE ينهي الجلسة.
 *
 * الأدوات الخمس: أوصافها كما في المواصفة حرفيًا، ونتائجها بالعربية.
 * أثناء نافذة الانتظار تُبث إشعارات تقدم (progress notifications) كل ~3 ثوانٍ
 * عندما يزوّد العميل الطلب بـ _meta.progressToken.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { ensureSchema, listRecentTasks, type TaskRow, type TaskType, type TaskStatus } from "@/lib/turso";
import { resolveModel, availableModelsList } from "@/lib/models";
import { runGeneration, refreshTask, NoKeysError } from "@/lib/orchestrator";
import { runMerge, resolveTaskUrls, MergerConfigError, MERGE_TOO_FEW, type RunMergeOptions } from "@/lib/merger";
import {
  formatTaskReply,
  noKeysReply,
  unknownModelReply,
  taskNotFoundReply,
  type ToolReply,
} from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// الحد الافتراضي والأقصى على Vercel (Fluid compute) لكل الخطط — يتسع لنوافذ الانتظار 240 ثانية
export const maxDuration = 300;

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

/** تعليمات السيرفر — تُرسل مع initialize كما هي */
const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ====================== إدارة الجلسات في الذاكرة ====================== */

interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

const sessions = new Map<string, McpSession>();
const MAX_SESSIONS = 100;

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > 30 * 60 * 1000) sessions.delete(id);
  }
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < sorted.length - MAX_SESSIONS; i++) sessions.delete(sorted[i][0]);
  }
}

/** يبني McpServer جديدًا مسجّلًا عليه الأدوات الخمس + ناقل جلسة جديد */
async function createSession(): Promise<McpSession> {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  let ref!: McpSession;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, ref);
      pruneSessions();
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });
  registerTools(server);
  ref = { server, transport, lastSeen: Date.now() };
  // ننتظر ربط السيرفر بالناقل قبل معالجة أي طلب (تفادي سباق التهيئة)
  await server.connect(transport);
  return ref;
}

/* ====================== بث تقدم الحي ====================== */

/** يبني دالة إشعار تقدم من extra إذا زوّد العميل الطلب بـ progressToken */
function makeNotifier(extra: RequestHandlerExtra<any, any>) {
  const token = (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
  if (token === undefined || token === null) return undefined;
  return async (progress: number, message: string) => {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total: 100, message },
    });
  };
}

function toToolReply(reply: ToolReply) {
  return { content: [{ type: "text" as const, text: reply.text }], isError: reply.isError };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ====================== تسجيل الأدوات الخمس ====================== */

function registerTools(server: McpServer): void {
  /* ---------- 1) generate_image ---------- */
  server.registerTool(
    "generate_image",
    {
      description:
        "توليد صورة بـ gpt-image-2-6/flare-text-to-image (تبديل تلقائي عبر كل المفاتيح النشطة). تعيد رابط الصورة جاهزًا إذا اكتملت خلال نافذة الانتظار، وإلا تعيد task_id — استدعِ get_task كل ~10 ثوانٍ حتى completed ثم اعرض الرابط وتوقف.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model) return toToolReply(unknownModelReply(String(args.model), availableModelsList()));

      // نرسل للمزود المعطيات المطلوبة فقط — auto تعني «دع المزود يقرر»
      const input: Record<string, unknown> = {
        prompt: args.prompt,
        resolution: args.resolution,
        output_format: args.output_format,
      };
      if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
      if (args.background && args.background !== "auto") input.background = args.background;

      try {
        const task = await runGeneration({
          type: "image",
          model,
          input,
          waitSeconds: args.wait_seconds ?? 90,
          notify: makeNotifier(extra),
        });
        return toToolReply(formatTaskReply(task));
      } catch (e) {
        return toToolReply(handleUnexpected(e, model.canonical));
      }
    }
  );

  /* ---------- 2) generate_video ---------- */
  server.registerTool(
    "generate_video",
    {
      description:
        "توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن أصلي، image-to-video اختياري). الفيديو يحتاج دقائق: انتظار قصير مع بث تقدم ثم task_id — تابع بـ get_task كل ~10 ثوانٍ.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model) return toToolReply(unknownModelReply(String(args.model), availableModelsList()));

      const input: Record<string, unknown> = {
        prompt: args.prompt,
        enable_audio: args.enable_audio ?? true,
        duration: args.duration ?? 8,
        resolution: args.resolution ?? "480p",
      };
      if (args.image_url) input.image_url = args.image_url;
      if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;

      try {
        const task = await runGeneration({
          type: "video",
          model,
          input,
          waitSeconds: args.wait_seconds ?? 25,
          notify: makeNotifier(extra),
        });
        return toToolReply(formatTaskReply(task));
      } catch (e) {
        return toToolReply(handleUnexpected(e, model.canonical));
      }
    }
  );

  /* ---------- 3) merge_videos ---------- */
  server.registerTool(
    "merge_videos",
    {
      description:
        "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى. مرر urls (روابط فيديو مباشرة عامة — مثل روابط generate_video) أو task_ids (لمهام فيديو مكتملة تُحل روابطها من قاعدة البيانات بالترتيب — مثالي بعد توليد عدة مقاطع). الدمج سريع عادةً: انتظار قصير مع بث تقدم ثم task_id للدمج — تابعه بـ get_task. ملاحظة: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, MERGE_TOO_FEW)
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
          ),
        task_ids: z
          .array(z.string())
          .min(2, MERGE_TOO_FEW)
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      try {
        // الترتيب: روابط task_ids أُولًا ثم urls المباشرة بنفس ترتيبها
        const resolved: string[] = [];
        if (args.task_ids && args.task_ids.length > 0) {
          const r = await resolveTaskUrls(args.task_ids);
          if (r.error) return toToolReply({ text: r.error, isError: true });
          resolved.push(...r.urls);
        }
        const all = [...resolved, ...(args.urls ?? [])];

        if (all.length < 2) {
          return toToolReply({
            text: MERGE_TOO_FEW,
            isError: true,
          });
        }

        const opts: RunMergeOptions = {
          urls: all,
          taskIds: [],
          waitSeconds: args.wait_seconds ?? 60,
          notify: makeNotifier(extra),
        };
        const task = await runMerge(opts);
        return toToolReply(formatTaskReply(task));
      } catch (e) {
        if (e instanceof MergerConfigError) {
          return toToolReply({ text: e.message, isError: true });
        }
        return toToolReply(handleUnexpected(e));
      }
    }
  );

  /* ---------- 4) get_task ---------- */
  server.registerTool(
    "get_task",
    {
      description:
        "تتبع أي مهمة بمعرّفها — توليد صور/فيديو ودمج (يقرأ قاعدة Turso ويحدّث من المزود/الخدمة إن كانت جارية). استعلمه كل ~10 ثوانٍ؛ عند completed ستجد روابط النتائج — اعرضها للمستخدم وتوقف عن الاستعلام.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const task = await refreshTask(args.task_id);
        if (!task) return toToolReply(taskNotFoundReply(args.task_id));
        return toToolReply(formatTaskReply(task));
      } catch {
        return toToolReply({
          text: "❌ حدث خطأ داخلي أثناء تحديث المهمة — أعد المحاولة بعد قليل.",
          isError: true,
        });
      }
    }
  );

  /* ---------- 5) list_media ---------- */
  server.registerTool(
    "list_media",
    {
      description:
        "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) — لاسترجاع نتائج سابقة.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const tasks = await listRecentTasks(args.limit ?? 10, {
          type: args.type as TaskType | undefined,
          status: args.status as TaskStatus | undefined,
        });
        return { content: [{ type: "text" as const, text: formatMediaList(tasks) }] };
      } catch {
        return toToolReply({
          text: "❌ حدث خطأ داخلي أثناء قراءة الوسائط المخزنة — أعد المحاولة بعد قليل.",
          isError: true,
        });
      }
    }
  );
}

/** رسالة داخلية موحدة — لا تُفصح عن أي تفاصيل مفاتيح/رصيد */
function handleUnexpected(e: unknown, model?: string): ToolReply {
  if (e instanceof NoKeysError) return noKeysReply(model ?? e.message);
  if (e instanceof MergerConfigError) return { text: e.message, isError: true };
  console.error("[mcp] unexpected tool error:", (e as Error)?.message);
  return {
    text: "❌ حدث خطأ داخلي غير متوقع — أعد المحاولة بعد قليل.",
    isError: true,
  };
}

const TYPE_AR: Record<TaskType, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "✅ مكتملة",
  failed: "❌ فاشلة",
  processing: "⏳ جارية",
  pending: "⏳ جارية",
};

/** عرض عربي مرقّم لأحدث الوسائط المخزنة بروابطها */
function formatMediaList(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return "لا توجد وسائط مخزنة بعد — استخدم generate_image أو generate_video أولًا.";
  }
  const lines = tasks.map((t, i) => {
    const head = `${i + 1}. [${TYPE_AR[t.type]}] ${STATUS_AR[t.status] ?? t.status} — ${t.model} — ${t.createdAt}`;
    const body: string[] = [];
    if (t.status === "completed" && t.resultUrls.length > 0) {
      body.push(...t.resultUrls.map((u) => `   الرابط: ${u}`));
    }
    if (t.status === "failed" && t.errorMessage) {
      body.push(`   السبب: ${t.errorMessage}`);
    }
    body.push(`   task_id: ${t.id}`);
    return [head, ...body].join("\n");
  });
  return `📁 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}

/* ====================== حماية Bearer اختيارية ====================== */

import { timingSafeEqual } from "node:crypto";

function checkAuth(req: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN?.trim();
  if (!token) return null; // لا حماية مضبوطة
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) return null;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: Bearer token required (MCP_ACCESS_TOKEN)" },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/* ====================== معالجات المسار ====================== */

export async function POST(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  try {
    await ensureSchema();
  } catch (e) {
    console.error("[mcp] database unavailable:", (e as Error)?.message);
    return jsonRpcError(503, "قاعدة البيانات غير متاحة — تحقق من متغيرات Turso");
  }

  // نقرأ الجسم مرة واحدة ونعيد تمريره محللًا (يتجنب قراءة الجسم مرتين)
  let parsedBody: unknown = undefined;
  try {
    parsedBody = await req.json();
  } catch {
    parsedBody = undefined;
  }

  const sid = req.headers.get("mcp-session-id");

  if (sid) {
    const session = sessions.get(sid);
    if (!session) return jsonRpcError(404, "Session not found");
    session.lastSeen = Date.now();
    return await session.transport.handleRequest(req, { parsedBody });
  }

  // طلب بلا معرّف جلسة: يُقبل initialize فقط — غيره 400 وفق المواصفة
  if (typeof parsedBody === "object" && parsedBody !== null && isInitializeRequest(parsedBody)) {
    const session = await createSession();
    return await session.transport.handleRequest(req, { parsedBody });
  }
  return jsonRpcError(400, "Bad Request: Mcp-Session-Id header is required");
}

/** GET: لا بثًا مستقلًا من السيرفر — 405 وفق مواصفة Streamable HTTP */
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "GET not supported: server-initiated SSE streams disabled; use POST" },
      id: null,
    }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST, DELETE" } }
  );
}

/** DELETE: إنهاء الجلسة عبر النقل الرسمي ثم تنظيف الخريطة */
export async function DELETE(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  const sid = req.headers.get("mcp-session-id");
  const session = sid ? sessions.get(sid) : undefined;
  if (!session) return jsonRpcError(404, "Session not found");
  const res = await session.transport.handleRequest(req);
  sessions.delete(sid!);
  return res;
}
