import { compilerServerConfig, type CompilerServerConfig } from "./server-config";

// Server-only HTTP client for the Teaching Script Compiler. Keeping every raw
// outbound call here lets the architecture test allow exactly one module for
// the separate compiler service (mirroring lib/qcore-adapter/client.ts).
function configOrThrow(): CompilerServerConfig {
  const config = compilerServerConfig();
  if (!config.serviceToken) {
    throw new Error("TSC_SERVICE_TOKEN is not configured");
  }
  return config;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const config = configOrThrow();
  const headers = new Headers(init?.headers);
  headers.set("X-TSC-Token", config.serviceToken);
  return fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

export function createSearchJob(form: FormData): Promise<Response> {
  return request("/api/search/photo/jobs", { method: "POST", body: form });
}

export function createTextSearch(text: string): Promise<Response> {
  return request("/api/search/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function getSearchJob(jobId: string): Promise<Response> {
  return request(`/api/search/jobs/${encodeURIComponent(jobId)}`);
}

export function createLessonAccess(
  questionId: string,
  revisionId: string | null,
): Promise<Response> {
  return request("/api/lesson-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question_id: questionId, revision_id: revisionId }),
  });
}

export function getTeachingBundle(questionId: string, revisionId: string): Promise<Response> {
  const params = new URLSearchParams({ revision_id: revisionId, language: "zh-CN" });
  return request(
    `/api/teaching-bundles/${encodeURIComponent(questionId)}?${params.toString()}`,
  );
}
