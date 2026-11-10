/**
 * ‏GET /api/tasks?limit=20&type=&status= — لوحة المهام:
 * إحصائيات + أحدث المهام (روابط النتائج عند الاكتمال — بلا أي مفاتيح)
 */
import { NextResponse } from "next/server";
import { ensureSchema, listRecentTasks, taskStats, type TaskStatus, type TaskType } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    const type = (url.searchParams.get("type") ?? undefined) as TaskType | undefined;
    const status = (url.searchParams.get("status") ?? undefined) as TaskStatus | undefined;

    const [stats, tasks] = await Promise.all([
      taskStats(),
      listRecentTasks(limit, {
        type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
        status: status && ["pending", "processing", "completed", "failed"].includes(status) ? status : undefined,
      }),
    ]);

    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        provider: t.provider,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 160),
        resultUrls: t.resultUrls,
        errorMessage: t.errorMessage,
        attemptsCount: t.attempts.length,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `تعذر جلب المهام: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
