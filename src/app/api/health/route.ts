/**
 * ‏GET /api/health — حالة السيرفر: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، الحماية
 */
import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = "turso-error";
  try {
    await ensureSchema();
    database = (await dbHealthy()) ? "turso-connected" : "turso-error";
  } catch {
    database = "turso-error";
  }

  const mergerConfigured = mergerBase() !== null;
  const mergerHealthyFlag = mergerConfigured ? await mergerHealthy() : false;

  return NextResponse.json(
    {
      ok: database === "turso-connected",
      database,
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({
        canonical: m.canonical,
        type: m.type,
        providers: m.providers,
      })),
      merger: {
        base: mergerBase() ?? "",
        healthy: mergerHealthyFlag,
        configured: mergerConfigured,
      },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN?.trim()),
    },
    { status: 200 }
  );
}
