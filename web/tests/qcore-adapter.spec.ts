// QCore Student API adapter contract tests (QCORE-DT-MIN-INTEGRATION-01).
import { afterEach, describe, expect, it, vi } from "vitest";

import assetMapJson from "@/lib/qcore-adapter/asset-map-175.json";
import {
  QcNotFoundError,
  QcUnavailableError,
  fetchQuestionDetail,
  fetchQuestionList,
} from "@/lib/qcore-adapter/client";

const assetEntries = (
  assetMapJson as { entries: Record<string, { url_path: string; content_hash: string }> }
).entries;
const firstAssetId = Object.keys(assetEntries).sort()[0];
const firstAsset = assetEntries[firstAssetId];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const detailBody = {
  question_id: "q1",
  revision_id: "r1",
  revision_number: 2,
  question_type: "reading",
  content: {
    bodies: [
      {
        local_id: "b1",
        question_type: "reading",
        printed_number: "1",
        stem_blocks: [{ kind: "text", text: "题干" }],
        options: [
          {
            label: "A",
            blocks: [{ kind: "text", text: "A. 选项甲" }],
          },
        ],
        parent_question_ref: null,
        sub_question_ids: [],
      },
    ],
    materials: [
      {
        material_id: "m1",
        blocks: [
          { kind: "text", text: "材料" },
          { kind: "image", asset_id: firstAssetId, alt_text: "图" },
        ],
        line_start: 1,
        line_end: 2,
      },
    ],
    assets: [
      {
        asset_id: firstAssetId,
        storage_path: firstAsset.url_path.replace(/^.*\/imgs\//, "_imgs/"),
        mime_type: "image/jpeg",
      },
    ],
  },
  answer_visible: false,
  explanation_visible: false,
  answers: [],
  answers_note: "answers hidden by visibility policy",
  explanation_blocks: [],
  explanation_note: "explanation hidden by visibility policy",
};

describe("QCore adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the published list from the student API", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        count: 1,
        questions: [
          {
            question_id: "q1",
            revision_id: "r1",
            printed_number: "1",
            section: "阅读",
            question_type: "reading",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const list = await fetchQuestionList();
    expect(list).toEqual([
      {
        questionId: "q1",
        revisionId: "r1",
        printedNumber: "1",
        section: "阅读",
        questionType: "reading",
        admissionReview: null,
        admissionCompleteness: null,
        publicationState: null,
        sourceDocumentId: null,
      },
    ]);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("/student/questions");
    expect(calledUrl).not.toContain("/internal/");
  });

  it("maps detail content, options and whitelisted asset URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detailBody)));

    const { question } = await fetchQuestionDetail("q1");
    expect(question.questionId).toBe("q1");
    expect(question.revisionNumber).toBe(2);
    expect(question.content.bodies[0].options[0].label).toBe("A");
    expect(question.content.bodies[0].options[0].blocks[0]).toMatchObject({
      kind: "text",
      text: "选项甲",
    });
    const image = question.content.materials[0].blocks[1];
    expect(image.kind).toBe("image");
    if (image.kind === "image") {
      expect(image.url).toBe(
        `http://127.0.0.1:8812/${firstAsset.url_path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      );
    }
    expect(question.answers).toEqual([]);
    expect(question.answerVisible).toBe(false);
  });

  it("maps 404 to QcNotFoundError (unpublished is not a system failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "nope" }, 404)));
    await expect(fetchQuestionDetail("missing")).rejects.toBeInstanceOf(QcNotFoundError);
  });

  it("maps network failure to QcUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(fetchQuestionList()).rejects.toBeInstanceOf(QcUnavailableError);
  });
});
