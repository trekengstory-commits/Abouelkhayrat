/**
 * ‏PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي: {action: "disable" | "enable"}
 * ‏DELETE /api/keys/{id} — حذف نهائي
 */
import { NextResponse } from "next/server";
import { ensureSchema, getKey, setKeyStatus, deleteKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { action?: string } | null;
    const action = body?.action;
    if (action !== "disable" && action !== "enable") {
      return NextResponse.json(
        { error: 'الإجراء المقبول: {"action": "disable"} أو {"action": "enable"}' },
        { status: 400 }
      );
    }
    const existing = await getKey(id);
    if (!existing) {
      return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
    }
    const updated = await setKeyStatus(id, action === "disable" ? "disabled" : "active");
    return NextResponse.json({ ok: true, status: updated?.status });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر تحديث المفتاح: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await ctx.params;
    const ok = await deleteKey(id);
    if (!ok) return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر حذف المفتاح: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
