import { describe, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn(),
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(), saveRequestDetail: vi.fn() }));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
describe("current PDF routing", () => {
  it("returns an explicit unsupported-document error before any GLM executor call", async () => {
    const result = await handleChatCore({
      body: { model: "glm/glm-5.3", stream: false, messages: [{ role: "user", content: [
        { type: "file", file: { filename: "probe.pdf", file_data: "data:application/pdf;base64,JVBERg==" } },
        { type: "text", text: "What word appears in this PDF?" },
      ] }] },
      modelInfo: { provider: "glm", model: "glm-5.3" }, credentials: { apiKey: "test-key" },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "pdf-guard-test",
    });
    expect(result.response.status).toBe(400);
    expect(result.noCooldown).toBe(true);
    expect((await result.response.json()).error.message).toContain("PDF/document input is not supported");
    expect(execute).not.toHaveBeenCalled();
  });
});
