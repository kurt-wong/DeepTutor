import { NextResponse } from "next/server";

import { createSearchJob } from "@/lib/qcore-teach/server-client";

export const runtime = "nodejs";

// Same-origin proxy for photo upload. The browser never sees the service token.
export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ detail: "请求不是有效的 multipart 表单" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "缺少 file 字段" }, { status: 400 });
  }
  const upstream = new FormData();
  upstream.append("file", file, file.name || "photo.jpg");

  let response: Response;
  try {
    response = await createSearchJob(upstream);
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
  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
