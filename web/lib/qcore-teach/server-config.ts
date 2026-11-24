import fs from "node:fs";
import path from "node:path";

// Server-only configuration. The service token must never reach the browser.
export interface CompilerServerConfig {
  baseUrl: string;
  lessonBaseUrl: string;
  serviceToken: string;
}

function readLocalToken(): string {
  const candidates = [
    process.env.TSC_CONFIG_FILE,
    path.resolve(process.cwd(), "../../Teaching Script Compiler/.env.local"),
    path.resolve(process.cwd(), "../Teaching Script Compiler/.env.local"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const text = fs.readFileSync(candidate, "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith("TSC_SERVICE_TOKEN=")) continue;
        return line.slice("TSC_SERVICE_TOKEN=".length).trim();
      }
    } catch {
      // Fall through to the next candidate; missing token is handled by callers.
    }
  }
  return "";
}

export function compilerServerConfig(): CompilerServerConfig {
  return {
    baseUrl: (process.env.TSC_BASE_URL ?? "http://127.0.0.1:8820").replace(/\/+$/, ""),
    lessonBaseUrl: (process.env.LESSON_BASE_URL ?? "http://127.0.0.1:8821").replace(/\/+$/, ""),
    serviceToken: (process.env.TSC_SERVICE_TOKEN ?? "").trim() || readLocalToken(),
  };
}

export function publicCompilerBase(): string {
  return (process.env.NEXT_PUBLIC_TSC_BASE ?? "http://127.0.0.1:8820").replace(/\/+$/, "");
}
