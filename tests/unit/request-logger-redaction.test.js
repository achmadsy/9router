// HIGH3: requestLogger must redact credential headers and query key params.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const originalEnable = process.env.ENABLE_REQUEST_LOGS;
let tempDir;
let createRequestLogger;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-reqlog-"));
  process.env.ENABLE_REQUEST_LOGS = "true";
  process.chdir(tempDir);
  ({ createRequestLogger } = await import("open-sse/utils/requestLogger.js"));
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalEnable === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalEnable;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function readLoggedFile(sessionPath, filename) {
  return fs.readFileSync(path.join(sessionPath, filename), "utf8");
}

describe("requestLogger sensitive redaction", () => {
  it("redacts Authorization / x-api-key / cookie headers and strips ?key=", async () => {
    const logger = await createRequestLogger("openai", "openai", "gpt-4o");
    expect(logger.sessionPath).toBeTruthy();

    logger.logClientRawRequest("/v1/chat/completions?key=super-secret-query", { prompt: "hi" }, {
      Authorization: "Bearer sk-secret-token",
      "x-api-key": "sk-goog-secret",
      Cookie: "session=abc",
      "content-type": "application/json",
    });
    logger.logTargetRequest("https://api.openai.com/v1/chat/completions?key=upstream-secret", {
      Authorization: "Bearer provider-credential",
      "x-goog-api-key": "google-cred",
    }, { model: "gpt-4o" });

    const reqRaw = readLoggedFile(logger.sessionPath, "1_req_client.json");
    const targetRaw = readLoggedFile(logger.sessionPath, "4_req_target.json");

    expect(reqRaw).not.toContain("sk-secret-token");
    expect(reqRaw).not.toContain("sk-goog-secret");
    expect(reqRaw).not.toContain("session=abc");
    expect(reqRaw).not.toContain("super-secret-query");
    expect(reqRaw).toContain("[REDACTED]");

    expect(targetRaw).not.toContain("provider-credential");
    expect(targetRaw).not.toContain("google-cred");
    expect(targetRaw).not.toContain("upstream-secret");
    expect(targetRaw).toContain("[REDACTED]");
  });
});
