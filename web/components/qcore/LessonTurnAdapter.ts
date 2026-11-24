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
  /** Reuse the lesson's conversation for follow-ups instead of a new session. */
  sessionId?: string | null;
}

function socketUrl(): string {
  const url = new URL(scopedUrl("/ws"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
  const { timeoutMs = 90000, onDelta, signal, sessionId } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    let turnId = "";
    let activeSessionId = "";
    let startAttempts = 0;
    const socket = new WebSocket(socketUrl());
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
      else resolve({ text, turnId, sessionId: activeSessionId || sessionId || "" });
    }

    function onAbort() {
      finish(new Error("已取消"));
    }

    signal?.addEventListener("abort", onAbort);

    function startTurn() {
      startAttempts += 1;
      socket.send(
        JSON.stringify({
          type: "start_turn",
          protocol_version: "2.0",
          content: buildFollowUpPrompt(context, question),
          capability: "chat",
          session_id: sessionId ?? null,
          client_submission_id: `lesson-${context.step_id}-${Date.now()}-${startAttempts}`,
        }),
      );
    }

    socket.onerror = () => finish(new Error("Turn WebSocket 连接失败"));
    socket.onclose = () => {
      if (!settled && !text) finish(new Error("Turn 连接被关闭"));
    };
    socket.onopen = () => {
      startTurn();
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
        const message = String(data.message ?? data.error_code ?? "Turn 失败");
        // The previous turn can still be "recovering" for a moment after `done`;
        // retry the same session instead of surfacing a spurious failure.
        if (
          message.includes("active or recovering turn") &&
          startAttempts < 5 &&
          !text
        ) {
          window.setTimeout(() => {
            if (!settled) startTurn();
          }, 1200 + startAttempts * 400);
          return;
        }
        finish(new Error(message));
        return;
      }
      if (type === "session") {
        activeSessionId = String(data.session_id ?? activeSessionId);
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
