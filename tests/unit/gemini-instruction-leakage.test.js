import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest, openaiToAntigravityRequest, openaiToGeminiCLIRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIResponse, stripEchoedInstructions } from "../../open-sse/translator/response/gemini-to-openai.js";

describe("Gemini instruction leakage prevention", () => {
  const SAMPLE_INSTRUCTION = `<instructions>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status.
</instructions>`;

  it("extracts <instructions> from string user turn into systemInstruction for Gemini", () => {
    const out = openaiToGeminiRequest("gemini-2.5-flash", {
      messages: [
        { role: "user", content: `Please inspect the codebase.\n\n${SAMPLE_INSTRUCTION}` },
      ],
    }, false);

    // Verify user turn does NOT contain <instructions>
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0].parts[0].text).toBe("Please inspect the codebase.");
    expect(JSON.stringify(out.contents)).not.toContain("<instructions>");

    // Verify systemInstruction contains extracted directive
    expect(out.systemInstruction).toBeDefined();
    expect(out.systemInstruction.parts.some(p => p.text.includes("TaskCreate"))).toBe(true);
  });

  it("drops user turn completely if it only contains <instructions>", () => {
    const out = openaiToGeminiRequest("gemini-2.5-flash", {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: SAMPLE_INSTRUCTION },
      ],
    }, false);

    // Last turn was purely instructions; trailing model turn normalization drops trailing assistant
    // or preserves non-empty content without instructions
    expect(JSON.stringify(out.contents)).not.toContain("<instructions>");
    expect(out.systemInstruction).toBeDefined();
    expect(out.systemInstruction.parts.some(p => p.text.includes("TaskCreate"))).toBe(true);
  });

  it("extracts <instructions> in openaiToAntigravityRequest Claude-routed envelope", () => {
    const out = openaiToAntigravityRequest("claude-sonnet-4-5", {
      messages: [
        { role: "user", content: `Run tests.\n${SAMPLE_INSTRUCTION}` },
      ],
    }, false, { projectId: "test-proj", _clientSessionId: "sess-123" });

    expect(out.request.contents).toHaveLength(1);
    expect(out.request.contents[0].parts[0].text).toBe("Run tests.");
    expect(JSON.stringify(out.request.contents)).not.toContain("<instructions>");
    expect(out.request.systemInstruction).toBeDefined();
    expect(out.request.systemInstruction.parts.some(p => p.text.includes("TaskCreate"))).toBe(true);
  });

  it("strips echoed instructions in stripEchoedInstructions helper", () => {
    const textWithEcho = `Understood. <instructions>The task tools haven't been used recently.</instructions> I will check the files.`;
    expect(stripEchoedInstructions(textWithEcho)).toBe("Understood.  I will check the files.");

    const unclosedEcho = `Here is plan:<instructions>\nSome leaked prompt`;
    expect(stripEchoedInstructions(unclosedEcho)).toBe("Here is plan:");
  });

  it("strips echoed instructions in streaming geminiToOpenAIResponse", () => {
    const state = { messageId: "msg_1", model: "gemini-2.5-flash", functionIndex: 0 };
    const chunk = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: `Here is the fix: <instructions>Do not leak</instructions> Done.` }
            ]
          }
        }
      ]
    };

    const chunks = geminiToOpenAIResponse(chunk, state);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe("Here is the fix:  Done.");
    expect(chunks[0].choices[0].delta.content).not.toContain("<instructions>");
  });
});
