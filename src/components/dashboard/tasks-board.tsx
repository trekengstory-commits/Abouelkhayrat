"use client";

/**
 * ب) لوحة المهام — شرائح إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Activity, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relativeArabicTime, TYPE_LABEL, type TasksResponse, type TaskInfo } from "@/lib/dashboard-types";

const TASK_STATUS: Record<TaskInfo["status"], { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  failed: { label: "فاشلة", cls: "bg-red-100 text-red-700 border-red-200" },
  processing: { label: "جارية", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  pending: { label: "جارية", cls: "bg-amber-100 text-amber-800 border-amber-200" },
};

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2 text-center min-w-20 ${cls}`}>
      <div className="text-xl font-extrabold leading-6">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}

function TaskRow({ t }: { t: TaskInfo }) {
  const st = TASK_STATUS[t.status];
  return (
    <li className="border border-slate-200 rounded-lg p-3 flex flex-col gap-2 hover:bg-slate-50 transition-colors">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="bg-white">
          {TYPE_LABEL[t.type] ?? t.type}
        </Badge>
        <Badge variant="outline" className={st.cls}>
          {st.label}
        </Badge>
        {t.status === "processing" && (
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
            {t.progress}%
          </Badge>
        )}
        {t.attemptsCount > 0 && (
          <Badge variant="outline" className="bg-slate-50 text-slate-600">
            محاولات: {t.attemptsCount}
          </Badge>
        )}
        <span className="text-xs text-slate-400 ms-auto">{relativeArabicTime(t.createdAt)}</span>
      </div>

      {t.status === "processing" && <Progress value={t.progress} className="h-2" />}

      <div className="text-sm">
        <span className="font-mono text-xs text-slate-500 ltr inline-block">{t.model}</span>
        {t.prompt && <p className="text-slate-700 mt-1 line-clamp-2 leading-6">{t.prompt}</p>}
      </div>

      {t.status === "completed" && t.resultUrls.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {t.resultUrls.map((u) => (
            <a
              key={u}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-emerald-700 hover:text-emerald-800 underline underline-offset-4 ltr max-w-full truncate"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              {u.length > 60 ? u.slice(0, 60) + "…" : u}
            </a>
          ))}
        </div>
      )}

      {t.status === "failed" && t.errorMessage && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 leading-6">
          {t.errorMessage}
        </p>
      )}
    </li>
  );
}

export function TasksBoard() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <section aria-label="لوحة المهام" className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6 flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-emerald-600" />
        <h2 className="text-lg font-bold">لوحة المهام</h2>
        <span className="text-xs text-slate-400">(تحديث تلقائي كل 5 ثوانٍ)</span>
        <Button variant="ghost" size="icon" className="ms-auto h-8 w-8" onClick={refresh} aria-label="تحديث">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {data ? (
        <div className="grid grid-cols-4 gap-2">
          <StatChip label="إجمالي" value={data.stats.total} cls="bg-slate-50 border-slate-200 text-slate-700" />
          <StatChip label="مكتملة" value={data.stats.completed} cls="bg-emerald-50 border-emerald-200 text-emerald-700" />
          <StatChip label="فاشلة" value={data.stats.failed} cls="bg-red-50 border-red-200 text-red-700" />
          <StatChip label="جارية" value={data.stats.active} cls="bg-amber-50 border-amber-200 text-amber-700" />
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {["إجمالي", "مكتملة", "فاشلة", "جارية"].map((l) => (
            <div key={l} className="rounded-lg border px-3 py-2 text-center bg-slate-50 border-slate-200 text-slate-400">
              <div className="text-xl font-extrabold leading-6">—</div>
              <div className="text-xs">{l}</div>
            </div>
          ))}
        </div>
      )}

      <div className="nice-scroll max-h-96 overflow-y-auto -mx-1 px-1">
        {error ? (
          <p className="text-sm text-red-600 py-6 text-center">تعذر الاتصال بقاعدة البيانات — تحقق من متغيرات Turso.</p>
        ) : !data || data.tasks.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">
            لا توجد مهام بعد — أي توليد من عميل MCP سيظهر هنا حيًا.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.tasks.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
