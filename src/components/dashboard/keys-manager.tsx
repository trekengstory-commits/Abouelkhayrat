"use client";

/**
 * أ) مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مفاتيح المزودين.
 * المفاتيح مقنَّعة دائمًا في العرض (السيرفر لا يعيد القيمة الكاملة أبدًا).
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Plus, Trash2, ToggleLeft, ToggleRight, RefreshCw } from "lucide-react";
import { PROVIDER_LABEL, relativeArabicTime, type KeyInfo } from "@/lib/dashboard-types";

const STATUS_BADGE: Record<KeyInfo["status"], { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  exhausted: { label: "مستنزف", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  disabled: { label: "معطّل", cls: "bg-slate-200 text-slate-600 border-slate-300" },
};

export function KeysManager() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setKeys(data.keys ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function addKey() {
    if (!apiKey.trim()) {
      toast({ title: "أدخل قيمة المفتاح أولًا", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "أُضيف المفتاح بنجاح", description: "سيُجرَّب أولًا حسب ترتيب الإضافة." });
        setApiKey("");
        setLabel("");
        refresh();
      } else {
        toast({ title: data.error ?? "فشل إضافة المفتاح", variant: "destructive" });
      }
    } catch {
      toast({ title: "تعذر الاتصال بالسيرفر", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(k: KeyInfo) {
    const action = k.status === "disabled" ? "enable" : "disable";
    const res = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      toast({ title: action === "disable" ? "عُطّل المفتاح" : "نُشّط المفتاح" });
      refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? "فشل التحديث", variant: "destructive" });
    }
  }

  async function remove(k: KeyInfo) {
    if (!window.confirm(`حذف المفتاح ${k.maskedKey} نهائيًا؟`)) return;
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ title: "حُذف المفتاح" });
      refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? "فشل الحذف", variant: "destructive" });
    }
  }

  return (
    <section aria-label="مدير المفاتيح" className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sm:p-6 flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-emerald-600" />
        <h2 className="text-lg font-bold">مدير المفاتيح</h2>
        <Button variant="ghost" size="icon" className="ms-auto h-8 w-8" onClick={refresh} aria-label="تحديث">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-6">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
        تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      {/* نموذج الإضافة */}
      <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr_1fr_auto] gap-2 items-start">
        <div>
          <label className="sr-only" htmlFor="provider">المزود</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="provider" aria-label="المزود" className="w-full bg-white">
              <SelectValue placeholder="المزود" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="kie">kie.ai</SelectItem>
              <SelectItem value="cometapi">CometAPI</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="sr-only" htmlFor="label">تسمية اختيارية</label>
          <Input
            id="label"
            placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
          />
        </div>
        <div>
          <label className="sr-only" htmlFor="apikey">المفتاح</label>
          <Input
            id="apikey"
            placeholder="قيمة المفتاح API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="ltr font-mono"
            autoComplete="off"
          />
        </div>
        <Button onClick={addKey} disabled={submitting} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="h-4 w-4" /> إضافة
        </Button>
      </div>

      {/* القائمة */}
      <div className="nice-scroll max-h-96 overflow-y-auto -mx-1 px-1">
        {loading ? (
          <p className="text-sm text-slate-500 py-6 text-center">جارٍ التحميل…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">
            لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((k, idx) => (
              <li
                key={k.id}
                className="border border-slate-200 rounded-lg p-3 flex flex-col gap-2 hover:bg-slate-50 transition-colors"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="bg-slate-50 font-mono">
                    #{idx + 1}
                  </Badge>
                  <span className="ltr font-mono text-sm font-semibold text-slate-800">{k.maskedKey}</span>
                  <Badge variant="outline" className="bg-white">
                    {PROVIDER_LABEL[k.provider] ?? k.provider}
                  </Badge>
                  <Badge variant="outline" className={STATUS_BADGE[k.status].cls}>
                    {STATUS_BADGE[k.status].label}
                  </Badge>
                  {k.label && <span className="text-sm text-slate-600">{k.label}</span>}
                  <div className="ms-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggle(k)}
                      className="text-slate-600 hover:text-slate-900"
                    >
                      {k.status === "disabled" ? (
                        <><ToggleRight className="h-4 w-4" /> تنشيط</>
                      ) : (
                        <><ToggleLeft className="h-4 w-4" /> تعطيل</>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(k)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" /> حذف
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>استخدام: {k.usageCount}</span>
                  <span className="text-emerald-700">نجاح: {k.successCount}</span>
                  <span className="text-red-700">فشل: {k.failCount}</span>
                  <span>آخر استخدام: {relativeArabicTime(k.lastUsedAt)}</span>
                  {k.lastError && (
                    <span className="text-red-600 max-w-full truncate" title={k.lastError}>
                      آخر خطأ: {k.lastError}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
