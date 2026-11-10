/**
 * ‏GET  /api/keys — قائمة المفاتيح كاملة مع الإخفاء الدائم (لا يُعاد المفتاح الكامل أبدًا)
 * ‏POST /api/keys — إضافة مفتاح {provider, api_key, label?} مع رفض التكرار لنفس المزود
 */
import { NextResponse } from "next/server";
import { ensureSchema, listKeys, createKey, findKeyByValue } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** شكل المفتاح المعروض للواجهة — قيمة المفتاح الكاملة لا تخرج من هنا أبدًا */
function publicView(k: Awaited<ReturnType<typeof listKeys>>[number]) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.apiKey),
    status: k.status,
    usageCount: k.usageCount,
    successCount: k.successCount,
    failCount: k.failCount,
    lastUsedAt: k.lastUsedAt,
    lastCheckedAt: k.lastCheckedAt,
    lastError: k.lastError,
    createdAt: k.createdAt,
  };
}

export async function GET() {
  try {
    await ensureSchema();
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(publicView) });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر جلب المفاتيح: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json().catch(() => null)) as {
      provider?: string;
      api_key?: string;
      label?: string;
    } | null;

    const provider = body?.provider;
    const apiKey = body?.api_key?.trim();
    const label = body?.label?.trim() ?? "";

    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json(
        { error: "المزود يجب أن يكون kie أو cometapi." },
        { status: 400 }
      );
    }
    if (!apiKey || apiKey.length < 8) {
      return NextResponse.json(
        { error: "أدخل قيمة مفتاح صالحة (8 أحرف على الأقل)." },
        { status: 400 }
      );
    }
    const dup = await findKeyByValue(provider, apiKey);
    if (dup) {
      return NextResponse.json(
        { error: `هذا المفتاح مضاف مسبقًا لدى ${provider === "kie" ? "kie.ai" : "CometAPI"} — رفض التكرار.` },
        { status: 409 }
      );
    }
    const created = await createKey({ provider, apiKey, label });
    return NextResponse.json({ key: publicView(created) }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر إضافة المفتاح: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
