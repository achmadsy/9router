import { describe, expect, it } from "vitest";
import { detectClientTool, isNativePassthrough } from "../../open-sse/utils/clientDetector.js";

describe("OpenCode native client detection", () => {
  it("detects the v2 CLI and enables native OpenCode passthrough", () => {
    const client = detectClientTool({ "user-agent": "opencode/latest/2.1.2/cli", "x-app": "cli" }, {});
    expect(client).toBe("opencode");
    expect(isNativePassthrough(client, "opencode")).toBe(true);
  });

  it("does not confuse legacy or unrelated CLI user agents with OpenCode v2", () => {
    expect(detectClientTool({ "user-agent": "opencode/1.18.31", "x-app": "cli" }, {})).toBe("claude");
    expect(detectClientTool({ "user-agent": "claude-code/2.1.0" }, {})).toBe("claude");
  });
});
