/**
 * سجل الموديلات — المصدر الوحيد لأسماء الموديلات المقبولة.
 * canonical: الاسم كما يراه عميل MCP.
 * aliases: صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط).
 * providers: المزودون القادرون على خدمة الموديل — تُجرَّب مفاتيحهم كلها بالترتيب.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  /** اسم الموديل كما يُرسل فعليًا لكل مزود */
  providerModel: Record<ProviderId, string>;
}

const envOr = (value: string | undefined, fallback: string) =>
  value && value.trim() ? value.trim() : fallback;

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2-6-flare-text-to-image",
      "gpt-image-2.6-flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      // أسماء الموديلات قابلة للتجاوز بمتغيرات بيئة
      kie: envOr(process.env.KIE_IMAGE_MODEL, "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOr(
        process.env.COMETAPI_IMAGE_MODEL,
        "gpt-image-2.6-flare-text-to-image"
      ),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-1-5",
      "grok-imagine-video-1.5",
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr(process.env.KIE_VIDEO_MODEL, "grok-imagine-video-1-5-preview"),
      cometapi: envOr(
        process.env.COMETAPI_VIDEO_MODEL,
        "grok-imagine-video-1-5-preview"
      ),
    },
  },
];

/** توحيد الصيغ: نقاط → شرطات، إزالة فراغات، أحرف صغيرة */
function normalizeModelName(name: string): string {
  return name.trim().toLowerCase().replace(/\./g, "-").replace(/\s+/g, "");
}

/**
 * يحلّ اسم الموديل إلى تعريفه — يقبل canonical أو أي صيغة بديلة معروفة.
 * يعيد null عند اسم غير معروف (خطأ معطيات فوري عند المستدعى).
 */
export function resolveModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const wanted = normalizeModelName(name);
  for (const m of MODELS) {
    if (normalizeModelName(m.canonical) === wanted) return m;
    if (m.aliases.some((a) => normalizeModelName(a) === wanted)) return m;
  }
  return null;
}

/** قائمة الأسماء المقبولة (لعرضها في رسائل الخطأ العربية) */
export function availableModelsList(): string {
  return MODELS.map((m) => `${m.canonical} (${m.type === "image" ? "صور" : "فيديو"})`).join("، ");
}
