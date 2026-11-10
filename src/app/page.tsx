"use client";

/**
 * لوحة الإدارة الرئيسية — هيدر بحالة /api/health + ثلاث بطاقات:
 * مدير المفاتيح، لوحة المهام، ربط السيرفر.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { KeysManager } from "@/components/dashboard/keys-manager";
import { TasksBoard } from "@/components/dashboard/tasks-board";
import { ConnectCard } from "@/components/dashboard/connect-card";
import { Database, PlugZap, ShieldCheck, ShieldOff, Wrench } from "lucide-react";
import type { HealthInfo } from "@/lib/dashboard-types";

function HealthBadge({
  ok,
  okText,
  badText,
  icon,
}: {
  ok: boolean | null;
  okText: string;
  badText: string;
  icon: React.ReactNode;
}) {
  const cls =
    ok === true
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : ok === false
        ? "bg-red-100 text-red-700 border-red-200"
        : "bg-slate-100 text-slate-500 border-slate-200";
  return (
    <Badge variant="outline" className={`gap-1 py-1 px-2 ${cls}`} title={ok === null ? "جارٍ الفحص…" : undefined}>
      {icon}
      {ok === null ? "جارٍ الفحص…" : ok ? okText : badText}
    </Badge>
  );
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        setHealth(await res.json());
        setReachable(true);
      } else {
        setReachable(false);
      }
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 10_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  const dbConnected = reachable === true && health?.database === "turso-connected";
  const mergerOk = reachable === true && (health?.merger.healthy ?? false);
  const mergerConfigured = health?.merger.configured ?? false;

  return (
    <>
      {/* الهيدر */}
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 me-auto">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <Wrench className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <h1 className="text-base sm:text-lg font-extrabold">MCP Media Generator</h1>
              <p className="text-xs text-slate-500">خادم توليد الصور والفيديو ودمج المقاطع — لوحة إدارة</p>
            </div>
          </div>
          <HealthBadge
            ok={dbConnected}
            okText="Turso متصل"
            badText="غير متصل"
            icon={<Database className="h-3.5 w-3.5" />}
          />
          <HealthBadge
            ok={mergerConfigured ? mergerOk : false}
            okText="الدمج جاهز"
            badText={mergerConfigured ? "خدمة الدمج لا تستجيب" : "الدمج غير مهيأ (MERGER_API_BASE)"}
            icon={<PlugZap className="h-3.5 w-3.5" />}
          />
          <HealthBadge
            ok={reachable === true ? (health?.authRequired ?? false) : null}
            okText="محمي بـ Bearer"
            badText="بدون حماية توكن"
            icon={health?.authRequired ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
          />
        </div>
      </header>

      {/* المحتوى */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 flex flex-col gap-6">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
          <KeysManager />
          <TasksBoard />
        </div>
        <ConnectCard health={health} />
      </main>

      {/* تذييل لاصق بالأسفل */}
      <footer className="mt-auto bg-white border-t border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-3 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
          <span>MCP Media Generator v1.2.0</span>
          <span>•</span>
          <span>Next.js + Turso (libSQL over HTTP)</span>
          <span>•</span>
          <span>المزودان: kie.ai و CometAPI</span>
          <span>•</span>
          <span>تبديل مفاتيح تسلسلي تلقائي دون توقف</span>
        </div>
      </footer>
    </>
  );
}
