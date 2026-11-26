import { expect, test } from "@playwright/test";

// Browser UI E2E across the OCR boundary. The real OCR/Compiler smoke is run
// separately; this test fixes the search job result so the page interaction is
// deterministic and not blocked by the remote OCR queue.
test.use({ channel: "msedge" });

const multiResult = {
  search_id: "e2e-multi",
  decision: "ambiguous",
  requires_confirmation: true,
  may_teach: false,
  message: "这张照片包含多道题，请选择目标题",
  candidates: [],
  structure: {
    status: "ambiguous",
    requires_selection: true,
    reasons: ["MULTIPLE_QUESTIONS", "SHARED_MATERIAL_PRESENT"],
    prefix_chars: 0,
    prefix_is_tail: false,
    prefix: "",
    prefix_preview: "",
    units: [
      { index: 0, number: "5", chars: 40, start: 0, end: 40, text: "5. 独立题", context: "", preview: "5. 独立题" },
      { index: 1, number: "6", chars: 40, start: 40, end: 80, text: "6. 第一小问", context: "长江经济带共享材料", preview: "6. 第一小问" },
      { index: 2, number: "7", chars: 40, start: 80, end: 120, text: "7. 第二小问", context: "长江经济带共享材料", preview: "7. 第二小问" },
      { index: 3, number: "8", chars: 40, start: 120, end: 160, text: "8. 第三小问", context: "长江经济带共享材料", preview: "8. 第三小问" },
    ],
  },
  ocr: { status: "ok", text: "5. 独立题\n6. 第一小问\n7. 第二小问\n8. 第三小问", engine: "mock" },
};

const candidate = {
  question_id: "11111111-1111-1111-1111-111111111111",
  revision_id: "22222222-2222-2222-2222-222222222222",
  score: 0.91,
  score_parts: { lexical: 0.9, semantic: 0.8, structure: 0.9, llm: null },
  match_evidence: [{ type: "number", value: "6" }],
  source_document_id: "e2e-paper",
  printed_number: "6",
  question_type: "single_choice",
  title: "长江经济带资源环境承载力",
  has_image: true,
  has_table: false,
  llm: null,
  needs_confirmation: false,
};

const selectedResult = {
  search_id: "e2e-selected",
  decision: "high_confidence",
  requires_confirmation: false,
  may_teach: true,
  message: "已找到目标题",
  candidates: [candidate],
  structure: {
    status: "reliable",
    requires_selection: false,
    reasons: [],
    prefix_chars: 0,
    prefix_is_tail: false,
    prefix: "",
    prefix_preview: "",
    units: [{ index: 0, number: "6", chars: 40, start: 0, end: 40, text: "6. 第一小问", context: "长江经济带共享材料", preview: "6. 第一小问" }],
  },
};

const singleResult = {
  search_id: "e2e-single",
  decision: "high_confidence",
  requires_confirmation: false,
  may_teach: true,
  message: "已找到单题",
  candidates: [candidate],
  structure: {
    status: "reliable",
    requires_selection: false,
    reasons: [],
    prefix_chars: 0,
    prefix_is_tail: false,
    prefix: "",
    prefix_preview: "",
    units: [{ index: 0, number: "66", chars: 40, start: 0, end: 40, text: "66. 单题", context: "", preview: "66. 单题" }],
  },
  ocr: { status: "ok", text: "66. 单题", engine: "mock" },
};

let capturedSearchText = "";

test.beforeEach(() => {
  capturedSearchText = "";
});

async function mockSearch(page: import("@playwright/test").Page, result: unknown) {
  await page.route("**/api/qcore-teach/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/qcore-teach/search") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ job_id: "e2e-job", status: "queued" }),
      });
      return;
    }
    if (pathname === "/api/qcore-teach/jobs/e2e-job") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ job_id: "e2e-job", status: "succeeded", stage: "done", result }),
      });
      return;
    }
    if (pathname === "/api/qcore-teach/search-text") {
      const body = route.request().postDataJSON() as { text?: string };
      capturedSearchText = body.text || "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(selectedResult),
      });
      return;
    }
    await route.continue();
  });
}

async function upload(page: import("@playwright/test").Page, name: string) {
  await page.getByTestId("teach-file-input").setInputFiles({
    name,
    mimeType: "image/jpeg",
    buffer: Buffer.from([1, 2, 3]),
  });
}

test("multi-question photo requires target selection and returns candidates", async ({ page }) => {
  await mockSearch(page, multiResult);
  await page.goto("/learning/qcore/teach");
  await upload(page, "multi.jpg");

  await expect(page.getByTestId("teach-target-selection")).toBeVisible();
  await page.getByTestId("teach-target-unit-1").check();
  await page.getByTestId("teach-target-unit-2").check();
  await page.getByTestId("teach-target-unit-3").check();
  await page.getByTestId("teach-target-confirm").click();

  await expect(page.getByTestId("teach-candidates")).toBeVisible();
  await expect(page.getByTestId("teach-start-0")).toBeVisible();
  await expect(page.getByTestId("teach-target-selection")).toHaveCount(0);
  expect(capturedSearchText).toContain("长江经济带");
  expect(capturedSearchText).toContain("8. 第三小问");
  expect(capturedSearchText).not.toContain("5. 独立题");
});

test("single-question photo skips target selection", async ({ page }) => {
  await mockSearch(page, singleResult);
  await page.goto("/learning/qcore/teach");
  await upload(page, "single.jpg");

  await expect(page.getByTestId("teach-candidates")).toBeVisible();
  await expect(page.getByTestId("teach-target-selection")).toHaveCount(0);
});
