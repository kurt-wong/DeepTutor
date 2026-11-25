import { NextResponse } from "next/server";

import { createTextSearch } from "@/lib/qcore-teach/server-client";

export const runtime = "nodejs";

// Same-origin proxy for searching a user-selected OCR segment.
export async function POST(request: Request): Promise<NextResponse> {
  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ detail: "请求不是有效 JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ detail: "缺少 text 字段" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await createTextSearch(text);
  } catch (error) {
    const message = String(error);
    return NextResponse.json(
      {
        detail: message.includes("TSC_SERVICE_TOKEN")
          ? "拍照讲题服务未配置服务令牌（TSC_SERVICE_TOKEN）"
          : `拍照讲题服务不可达：${message}`,
      },
      { status: message.includes("TSC_SERVICE_TOKEN") ? 503 : 502 },
    );
  }
  const payload = await response.text();
  return new NextResponse(payload, {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
