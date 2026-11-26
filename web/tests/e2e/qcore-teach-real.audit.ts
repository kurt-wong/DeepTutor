import { expect, test } from "@playwright/test";
import path from "node:path";

// Real-service browser E2E: real photo upload -> real OCR job -> structure ->
// target selection -> real text search -> candidates. No OCR/search mocking.
test.use({ channel: "msedge" });

test("real multi-question photo reaches candidates through target selection", async ({ page }) => {
  test.setTimeout(600_000);
  let searchTextBody = "";
  page.on("request", (request) => {
    if (request.url().includes("/api/qcore-teach/search-text")) {
      searchTextBody = request.postData() || "";
    }
  });
  await page.goto("/learning/qcore/teach");
  await expect(page.getByTestId("teach-upload")).toBeVisible();

  const file = path.resolve(
    process.cwd(),
    "../../Interactive Lesson/tests/pic/V11/IMG_8161.jpeg",
  );
  await page.getByTestId("teach-file-input").setInputFiles(file);

  await expect(page.getByTestId("teach-target-selection")).toBeVisible({ timeout: 480_000 });
  await expect(page.getByTestId("teach-target-unit-1")).toBeVisible();
  await page.getByTestId("teach-target-unit-1").check();
  await page.getByTestId("teach-target-unit-2").check();
  await page.getByTestId("teach-target-unit-3").check();
  await page.getByTestId("teach-target-confirm").click();

  await expect(page.getByTestId("teach-candidates")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("teach-start-0")).toBeVisible();
  expect(searchTextBody).toContain("长江经济带");
  expect(searchTextBody).toContain("8.");
});
