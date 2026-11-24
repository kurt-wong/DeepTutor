import { NextResponse } from "next/server";

import {
  createLessonAccess,
  getTeachingBundle,
} from "@/lib/qcore-teach/server-client";
import { compilerServerConfig, publicCompilerBase } from "@/lib/qcore-teach/server-config";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(status: number, detail: string): NextResponse {
  return NextResponse.json({ detail }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  const config = compilerServerConfig();
  if (!config.serviceToken) {
    return jsonError(503, "拍照讲题服务未配置服务令牌");
  }
  const url = new URL(request.url);
  const questionId = (url.searchParams.get("question_id") ?? "").trim();
  const revisionId = (url.searchParams.get("revision_id") ?? "").trim();
  if (!UUID.test(questionId)) return jsonError(400, "非法 question_id");
  if (revisionId && !UUID.test(revisionId)) return jsonError(400, "非法 revision_id");

  let accessResponse: Response;
  try {
    accessResponse = await createLessonAccess(questionId, revisionId || null);
  } catch (error) {
    return jsonError(502, `拍照讲题服务不可达：${String(error)}`);
  }
  const accessBody = (await accessResponse.json().catch(() => ({}))) as {
    access_token?: string;
    revision_id?: string;
    expires_at?: number;
    detail?: string;
  };
  if (!accessResponse.ok || !accessBody.access_token || !accessBody.revision_id) {
    return jsonError(
      accessResponse.status === 200 ? 502 : accessResponse.status,
      typeof accessBody.detail === "string" ? accessBody.detail : "无法签发讲题访问令牌",
    );
  }

  let bundleResponse: Response;
  try {
    bundleResponse = await getTeachingBundle(questionId, accessBody.revision_id);
  } catch (error) {
    return jsonError(502, `拍照讲题服务不可达：${String(error)}`);
  }
  const bundleText = await bundleResponse.text();
  if (!bundleResponse.ok) {
    return new NextResponse(bundleText, {
      status: bundleResponse.status,
      headers: { "content-type": "application/json" },
    });
  }
  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(bundleText) as Record<string, unknown>;
  } catch {
    return jsonError(502, "讲题服务返回了无效 JSON");
  }

  const lessonUrl = new URL(`${config.lessonBaseUrl}/`);
  lessonUrl.searchParams.set("question_id", questionId);
  lessonUrl.searchParams.set("revision_id", accessBody.revision_id);
  lessonUrl.searchParams.set("api", publicCompilerBase());
  lessonUrl.searchParams.set("access_token", accessBody.access_token);

  return NextResponse.json(
    {
      ...bundle,
      lesson_url: lessonUrl.toString(),
      access_token_expires_at: accessBody.expires_at ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
