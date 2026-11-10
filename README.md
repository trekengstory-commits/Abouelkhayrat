# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة، مع **لوحة إدارة عربية RTL**:

1. **توليد صور** من وصف نصي — `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع** في فيديو واحد عالي الجودة وبالترتيب المطلوب

يعمل مع أي عميل MCP: ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK.

---

## المزايا الجوهرية

- **تبديل مفاتيح تسلسلي صارم دون توقف**: أول مفتاح أُضيف يُجرَّب أولًا، وعند أي خطأ أو نفاد رصيد
  ينتقل تلقائيًا للمفتاح التالي ويستأنف **نفس المهمة بنفس task_id** — نموذج الذكاء الاصطناعي
  لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
- **مهمة فشلت على كل المفاتيح تبقى `processing`** وتُعاد محاولتها تلقائيًا مع كل `get_task`
  (بتهدئة ~45 ثانية) — بشن رصيد أي مفتاح يكملها من تلقاء نفسها.
- **روابط فقط**: لا يُنزَّل أي ملف وسائط على السيرفر — تُخزَّن روابط النتائج في قاعدة Turso.
- **توليد غير متزامن مع بث تقدم حي** (Progress notifications) كل ~3 ثوانٍ داخل نافذة الانتظار.
- **إخفاء المفاتيح إلزامي** في كل الاستجابات (`ABCD123••••••••WXYZ`).

## البنية التقنية

| الطبقة | التقنية |
|---|---|
| الإطار | Next.js 16 (App Router) + TypeScript |
| بروتوكول MCP | `@modelcontextprotocol/sdk` — ‏`McpServer` + `StreamableHTTPServerTransport` على `/mcp` |
| قاعدة البيانات | Turso (libSQL عبر HTTP — متوافق مع Vercel serverless) |
| المزودون | kie.ai (Jobs API) + CometAPI |
| الدمج | Video Merger API v2 (MP4 ‏H.264+AAC حتى 1080p، تُحذف الملفات بعد 24 ساعة) |
| الواجهة | Tailwind CSS 4 + shadcn/ui — عربية RTL بخط Tajawal |

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن، image-to-video اختياري — تابع بـ `get_task` |
| `merge_videos` | دمج `urls` مباشرة أو `task_ids` لمهام مكتملة بالترتيب (2–10 مقاطع) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) وتحديثها حيًا من المزود |
| `list_media` | أحدث الوسائط المخزنة بروابطها دون إعادة توليد |

## التشغيل المحلي

```bash
bun install
cp .env.example .env.local     # ثم املأ القيم الحقيقية
bun run dev                    # http://localhost:3000
```

- لوحة الإدارة: `/` — إضافة المفاتيح، متابعة المهام حيًا، وربط أي عميل MCP.
- نقطة MCP: `/mcp` — ضعها في عميلك كما في تبويبات بطاقة «ربط السيرفر».
- فحص الجاهزية: `GET /api/health`.

## النشر على Vercel

1. اربط المستودع على Vercel (Framework: Next.js — يُكتشف تلقائيًا).
2. أضف متغيرات البيئة **الثلاثة الإلزامية** في Settings → Environment Variables:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `MERGER_API_BASE`
3. (اختياري) `MCP_ACCESS_TOKEN` لحماية `/mcp`، و`KIE_API_KEY` لزرع مفتاح أولي.
4. Deploy — كل شيء يعمل بلا أي ملف محلي (libSQL عبر HTTP، والمسار `/mcp` يدعم البث،
   و`maxDuration = 300` ثانية مسموح على كل خطط Vercel مع Fluid compute).

بعد النشر افتح لوحة الإدارة على رابط Vercel وأضف مفاتيح مزوديك، ثم استخدم رابط
`https://<project>.vercel.app/mcp` في أي عميل MCP.

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | عنوان خدمة Video Merger API v2 |
| `KIE_API_KEY` / `COMETAPI_API_KEY` | — | زرع مفتاح أولي مرة واحدة عند فراغ الجدول |
| `MCP_ACCESS_TOKEN` | — | طلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` … `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء الموديلات لدى المزودين |

## الأمان

- **لا أسرار في الكود أو Git** — `.env*` مستثنى منذ أول commit.
- لا تُعاد قيمة أي مفتاح كاملة في أي استجابة — مقنَّعة دائمًا عبر `maskKey`.
- رسائل الأدوات لا تُفصح أبدًا عن مفاتيح أو أرصدة (يُحجب أي شيء يشبه توكنًا).
- إن شاركت توكنات في محادثة (GitHub/Turso) فأعِد توليدها من لوحات المزودين.
