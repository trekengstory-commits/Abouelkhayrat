/**
 * طبقة المفاتيح — قلب نظام التبديل التسلسلي.
 * ------------------------------------------------------------
 * 1) maskKey: إخفاء إلزامي في كل الاستجابات والسجلات.
 * 2) classifyProviderError: تصنيف موحّد لأخطاء المزودين يقود سياسة التبديل.
 * 3) getAdapter: ربط المزود بمحوّله.
 */
import { ProviderError, type ErrorClass, type ProviderAdapter, type ProviderKey } from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import type { ProviderId } from "./models";
import type { KeyRow } from "./turso";

/** إخفاء المفتاح: أول 7 + •••••••• + آخر 4 (أو أول 3 + •••• للقصير) */
export function maskKey(key: string): string {
  if (key.length > 10) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  if (key.length > 0) return `${key.slice(0, 3)}••••`;
  return "••••";
}

const BALANCE_WORDS = [
  "insufficient",
  "quota",
  "balance",
  "credit",
  "out of credits",
  "exhausted",
  "充值",
];
const AUTH_WORDS = ["invalid api key", "unauthorized", "forbidden", "authentication"];
const MODEL_WORDS = ["model not found", "unsupported model", "not supported"];

const hasAny = (msg: string, words: string[]) => words.some((w) => msg.includes(w));

/**
 * تصنيف موحّد لخطأ المزود — يحدد الإجراء:
 *  disabled  → علّم المفتاح disabled تلقائيًا وانتقل للتالي
 *  exhausted → علّمه exhausted (يبقى في القاعدة) وانتقل للتالي
 *  provider  → الموديل غير مدعوم لدى هذا المزود → انتقل للتالي
 *  params    → توقف فورًا (تبديل المفاتيح لا يحل خطأ معطيات)
 *  temporary → 429/5xx/شبكة/مهلة → انتقل للتالي الآن
 * ملاحظة: نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */
export function classifyProviderError(err: ProviderError): ErrorClass {
  if (err.errorClass) return err.errorClass;
  const status = err.status ?? 0;
  const msg = (err.message || "").toLowerCase();

  // حالات التوثيق الصريحة (401/403) لها الأولوية القصوى
  if (status === 401 || status === 403) return "disabled";
  // نفاد الرصيد الصريح 402
  if (status === 402) return "exhausted";
  // رسائل نفاد الرصيد (أي حالة — قد تصل بحالة 400 لدى بعض المزودين)
  if (hasAny(msg, BALANCE_WORDS)) return "exhausted";
  // رسائل توثيق بحالة أخرى
  if (hasAny(msg, AUTH_WORDS)) return "disabled";
  // موديل غير مدعوم لدى المزود (400/404/422)
  if (
    (status === 400 || status === 404 || status === 422) &&
    (hasAny(msg, MODEL_WORDS) || (msg.includes("model") && msg.includes("not supported")))
  ) {
    return "provider";
  }
  // خطأ معطيات الطلب
  if (status === 400 || status === 422) return "params";
  // الباقي مؤقت: 429، 5xx، شبكة (status=0)، مهلة
  return "temporary";
}

/** هل رسالة فشل منتصف المهمة توحي بمشكلة مفتاح/رصيد؟ (تُحدِّد إعادة الإنشاء) */
export function looksLikeKeyIssue(message: string): { issue: boolean; cls: ErrorClass } {
  const msg = (message || "").toLowerCase();
  if (hasAny(msg, ["unauthorized", "401", "invalid api key", "authentication"])) {
    return { issue: true, cls: "disabled" };
  }
  if (hasAny(msg, BALANCE_WORDS) || msg.includes("402")) {
    return { issue: true, cls: "exhausted" };
  }
  return { issue: false, cls: "temporary" };
}

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}

/** تحويل صف مفتاح من القاعدة إلى مفتاح مزود (بالقيمة الكاملة — داخلي فقط) */
export function toProviderKey(row: KeyRow): ProviderKey {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label || `${row.provider}-key`,
    apiKey: row.apiKey,
  };
}
