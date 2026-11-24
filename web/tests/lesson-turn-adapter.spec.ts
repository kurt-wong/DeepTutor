import { afterEach, describe, expect, it, vi } from "vitest";

import { askTutor } from "@/components/qcore/LessonTurnAdapter";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown> | null = null;
  sentCount = 0;
  closed = false;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent = JSON.parse(data) as Record<string, unknown>;
    this.sentCount += 1;
  }

  close() {
    this.closed = true;
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const context = {
  question_id: "q1",
  revision_id: "r1",
  step_id: "s2",
  step_goal: "分析",
  speech: "先求导",
  source_refs: ["exp:1"],
  question: "为什么先求导？",
};

describe("askTutor", () => {
  afterEach(() => {
    FakeSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("binds the turn to the given session and returns the streamed answer", async () => {
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    const promise = askTutor(context, "题干", { sessionId: "sess-1" });
    const socket = FakeSocket.instances[0];
    expect(socket.url).toContain("/ws");
    socket.onopen?.();
    expect(socket.sent?.type).toBe("start_turn");
    expect(socket.sent?.session_id).toBe("sess-1");
    // The default workspace is inherited from the connection; no workspace_id.
    expect(socket.sent?.workspace_id).toBeUndefined();
    expect(String(socket.sent?.content)).toContain("question_id: q1");
    expect(String(socket.sent?.content)).toContain("不要新增题目条件");

    socket.emit({ type: "session", session_id: "sess-1" });
    socket.emit({ type: "content", content: "先求导" });
    socket.emit({ type: "content", content: "才能判断单调性。" });
    socket.emit({ type: "done", turn_id: "turn-1" });
    await expect(promise).resolves.toEqual({
      text: "先求导才能判断单调性。",
      turnId: "turn-1",
      sessionId: "sess-1",
    });
  });

  it("starts a new session when none is provided", async () => {
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    const promise = askTutor(context, "题干");
    const socket = FakeSocket.instances[0];
    socket.onopen?.();
    expect(socket.sent?.session_id).toBeNull();
    socket.emit({ type: "session", session_id: "new-session" });
    socket.emit({ type: "done" });
    await expect(promise).resolves.toMatchObject({ sessionId: "new-session" });
  });

  it("retries when the previous turn is still recovering", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    const promise = askTutor(context, "题干", { sessionId: "sess-1" });
    const socket = FakeSocket.instances[0];
    socket.onopen?.();
    expect(socket.sentCount).toBe(1);
    socket.emit({
      type: "protocol_error",
      message: "Session already has an active or recovering turn",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.sentCount).toBe(2);
    socket.emit({ type: "done", turn_id: "turn-retry" });
    await expect(promise).resolves.toMatchObject({ turnId: "turn-retry" });
    vi.useRealTimers();
  });

  it("rejects on a protocol error instead of returning an empty answer", async () => {
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    const promise = askTutor(context, "题干");
    const socket = FakeSocket.instances[0];
    socket.onopen?.();
    socket.emit({ type: "protocol_error", message: "start_turn_rejected" });
    await expect(promise).rejects.toThrow("start_turn_rejected");
  });
});
