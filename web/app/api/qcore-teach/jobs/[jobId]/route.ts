import { NextResponse } from "next/server";

import { getSearchJob } from "@/lib/qcore-teach/server-client";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (!/^[a-f0-9]{8,32}$/i.test(jobId)) {
    return NextResponse.json({ detail: "非法 job id" }, { status: 400 });
  }
  let response: Response;
  try {
    response = await getSearchJob(jobId);
  } catch (error) {
    const message = String(error);
    return NextResponse.json(
      {
        detail: message.includes("TSC_SERVICE_TOKEN")
          ? "拍照讲题服务未配置服务令牌"
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
