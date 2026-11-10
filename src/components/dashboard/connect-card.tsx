"use client";

/**
 * ج) ربط السيرفر — رابط MCP جاهز للنسخ + JSON لكل عميل (ChatGPT / Claude / Cursor...) + رقائق الأدوات.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Copy, Link2, Plug, TriangleAlert } from "lucide-react";
import type { HealthInfo } from "@/lib/dashboard-types";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (gpt-image-2-6/flare-text-to-image)" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (grok-imagine-video-1-5-preview)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد" },
];

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast({ title: "نُسخ إلى الحافظة" });
        } catch {
          toast({ title: "تعذر النسخ — انسخ يدويًا", variant: "destructive" });
        }
      }}
    >
      <Copy className="h-3.5 w-3.5" />
      {label ?? "نسخ"}
    </Button>
  );
}

export function ConnectCard({ health }: { health: HealthInfo | null }) {
  const { toast } = useToast();
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const authRequired = health?.authRequired ?? false;

  // يبني JSON الربط لكل تبويب — يضع التوكن إن أدخله المستخدم
  const buildJson = useMemo(
    () =>
      (kind: "chatgpt" | "claude" | "cursor") => {
        const entry: Record<string, unknown> = {};
        if (kind === "claude") entry.type = "http";
        entry.url = mcpUrl;
        if (authRequired) {
          entry.headers = { Authorization: `Bearer ${token.trim() || "<MCP_ACCESS_TOKEN>"}` };
        }
        return JSON.stringify({ mcpServers: { "media-generator": entry } }, null, 2);
      },
    [mcpUrl, authRequired, token]
  );

  return (
    <section
      aria-label="ربط السيرفر"
      className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6 flex flex-col gap-4"
    >
      <header className="flex items-center gap-2">
        <Plug className="h-5 w-5 text-emerald-600" />
        <h2 className="text-lg font-bold">ربط السيرفر بأي عميل MCP</h2>
      </header>

      {/* الرابط المطلق + نسخ */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Link2 className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            readOnly
            value={mcpUrl}
            className="ltr font-mono ps-9 bg-slate-50"
            aria-label="رابط خادم MCP"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <CopyButton text={mcpUrl} label="نسخ الرابط" />
      </div>

      {/* توكن الحماية إن كان مطلوبًا */}
      {authRequired && (
        <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center bg-amber-50 border border-amber-200 rounded-lg p-3">
          <span className="text-sm text-amber-800 shrink-0">السيرفر محمي بـ Bearer token — أدخله ليظهر في JSON:</span>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="قيمة MCP_ACCESS_TOKEN"
            className="ltr font-mono bg-white"
            autoComplete="off"
          />
        </div>
      )}

      {/* تبويبات JSON */}
      <Tabs defaultValue="chatgpt" dir="rtl">
        <TabsList className="grid w-full grid-cols-3 bg-slate-100">
          <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
          <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
          <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
        </TabsList>
        <TabsContent value="chatgpt" className="flex flex-col gap-2">
          <p className="text-sm text-slate-600 leading-6">
            في ChatGPT: Settings → Connectors → Create → Custom MCP server — ضع الرابط في «Server URL».
          </p>
          <div className="relative">
            <pre className="ltr font-mono text-xs bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto nice-scroll leading-5">
              {buildJson("chatgpt")}
            </pre>
            <div className="absolute top-2 end-2">
              <CopyButton text={buildJson("chatgpt")} />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="claude" className="flex flex-col gap-2">
          <p className="text-sm text-slate-600 leading-6">
            ألصقه في ملف <span className="font-mono text-xs">claude_desktop_config.json</span> (نوع الاتصال http).
          </p>
          <div className="relative">
            <pre className="ltr font-mono text-xs bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto nice-scroll leading-5">
              {buildJson("claude")}
            </pre>
            <div className="absolute top-2 end-2">
              <CopyButton text={buildJson("claude")} />
            </div>
          </div>
        </TabsContent>
        <TabsContent value="cursor" className="flex flex-col gap-2">
          <p className="text-sm text-slate-600 leading-6">
            ألصقه في <span className="font-mono text-xs">mcp.json</span> (Cursor / Windsurf / Cline).
          </p>
          <div className="relative">
            <pre className="ltr font-mono text-xs bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto nice-scroll leading-5">
              {buildJson("cursor")}
            </pre>
            <div className="absolute top-2 end-2">
              <CopyButton text={buildJson("cursor")} />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* رقائق الأدوات الخمس */}
      <div>
        <h3 className="text-sm font-bold text-slate-700 mb-2">الأدوات الخمس المتاحة للعميل:</h3>
        <ul className="flex flex-col gap-1.5">
          {TOOLS.map((t) => (
            <li key={t.name} className="flex flex-wrap items-baseline gap-x-2">
              <Badge variant="outline" className="ltr font-mono bg-emerald-50 text-emerald-800 border-emerald-200">
                {t.name}
              </Badge>
              <span className="text-sm text-slate-600">{t.desc}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ملاحظة كهرمانية */}
      <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 leading-6">
        <TriangleAlert className="h-4 w-4 shrink-0 mt-1" />
        <p>
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ —
          وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress
          notifications) حتى لا تنقطع العملية.
        </p>
      </div>
    </section>
  );
}
