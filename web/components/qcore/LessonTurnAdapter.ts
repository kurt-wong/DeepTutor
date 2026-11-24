"use client";

// EULER-STYLE-INTERACTIVE-LESSON-PILOT-01 — DeepTutor Turn adapter for the
// minimal lesson follow-up. It reuses the existing `/ws` Turn protocol instead
// of inventing a chat API: one start_turn with a context preamble, stream
// `content` events until `done`. If the Turn channel is unavailable the caller
// shows the blocked state and keeps the exact context payload for a later retry.

import { scopedUrl } from "@/lib/workspace-scope";

export interface FollowUpContext {
  question_id: string;
  revision_id: string;
  step_id: string;
  step_goal: string;
  speech: string;
  source_refs: string[];
  question?: string;
  title?: string;
}

export interface TurnAnswer {
  text: string;
  turnId: string;
  sessionId: string;
}

interface TurnOptions {
  timeoutMs?: number;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

let cachedWorkspaceId: string | null = null;

/** Pick a ready content workspace so the Turn has a real folder to bind to. */
export async function resolveWorkspaceId(): Promise<string> {
  if (cachedWorkspaceId !== null) return cachedWorkspaceId;
  try {
    const response = await fetch("/api/settings/workspace/registrations", {
      cache: "no-store",
    });
    if (!response.ok) {
      cachedWorkspaceId = "";
      return "";
    }
    const body = (await response.json()) as {
      workspaces?: { workspace_id?: string; status?: string; archived?: boolean }[];
    };
    const ready = (body.workspaces ?? []).find(
      (workspace) => workspace.status === "ready" && !workspace.archived,
    );
    cachedWorkspaceId = ready?.workspace_id ?? "";
    return cachedWorkspaceId;
  } catch {
    cachedWorkspaceId = "";
    return "";
  }
}

function socketUrl(workspaceId: string): string {
  const url = new URL(scopedUrl("/ws"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("dt_workspace", workspaceId);
  return url.toString();
}

export function buildFollowUpPrompt(context: FollowUpContext, question: string): string {
  return [
    "【讲题追问】",
    "题目来源：Question Core 已发布 Revision（QCore 是唯一题目事实源）。",
    `question_id: ${context.question_id}`,
    `revision_id: ${context.revision_id}`,
    context.title ? `标题：${context.title}` : "",
    "题目（只读，不得改写、不得补充条件）：",
    question.slice(0, 2500),
    "",
    `当前教学步骤：${context.step_id} · ${context.step_goal}`,
    `当前讲解：${context.speech}`,
    `可引用来源：${context.source_refs.join(", ")}`,
    "",
    "学生问题：",
    context.question?.trim() || "为什么这一步要这样做？",
    "",
    "回答要求：只依据上面的题干与官方解析解释当前步骤；不要新增题目条件、不要修改标准答案；"
      + "如果证据不足以回答，明确说明“现有解析未覆盖”，不要臆测。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function askTutor(
  context: FollowUpContext,
  question: string,
  options: TurnOptions = {},
): Promise<TurnAnswer> {
  const { timeoutMs = 90000, onDelta, signal } = options;
  const workspaceId = await resolveWorkspaceId();
  if (!workspaceId) {
    throw new Error("没有可用的 DeepTutor workspace（Turn 无法绑定目录）");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    let turnId = "";
    let sessionId = "";
    const socket = new WebSocket(socketUrl(workspaceId));
    const timer = window.setTimeout(() => {
      finish(new Error("Turn 超时（90s）"));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // ignore
      }
    }

    function finish(error: Error | null) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ text, turnId, sessionId });
    }

    function onAbort() {
      finish(new Error("已取消"));
    }

    signal?.addEventListener("abort", onAbort);

    socket.onerror = () => finish(new Error("Turn WebSocket 连接失败"));
    socket.onclose = () => {
      if (!settled && !text) finish(new Error("Turn 连接被关闭"));
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "start_turn",
          protocol_version: "2.0",
          content: buildFollowUpPrompt(context, question),
          capability: "chat",
          session_id: null,
          workspace_id: workspaceId,
          client_submission_id: `lesson-${context.step_id}-${Date.now()}`,
        }),
      );
    };
    socket.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(data.type ?? "");
      if (type === "protocol_error" || type === "error") {
        finish(new Error(String(data.message ?? data.error_code ?? "Turn 失败")));
        return;
      }
      if (type === "session") {
        sessionId = String(data.session_id ?? sessionId);
        return;
      }
      if (type === "content") {
        const chunk = String(data.content ?? "");
        if (chunk) {
          text += chunk;
          onDelta?.(text);
        }
        return;
      }
      if (type === "done") {
        turnId = String(data.turn_id ?? turnId);
        finish(null);
      }
      // `result` is followed by `done`; wait for the terminal event so no
      // trailing content chunk is lost.
    };
  });
}
