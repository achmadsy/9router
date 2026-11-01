import { describe, it, expect } from "vitest";
import { stripUnsupportedModalities, hasUnsupportedCurrentDocument } from "../../open-sse/translator/concerns/modality.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const NO_VISION = { vision: false, audioInput: true, pdf: true };
const NO_AUDIO = { vision: true, audioInput: false, pdf: true };
const NO_PDF = { vision: true, audioInput: true, pdf: false };
const ALL = { vision: true, audioInput: true, pdf: true };

describe("current document delivery guard", () => {
  const pdf = { type: "file", file: { filename: "probe.pdf", file_data: "data:application/pdf;base64,JVBERg==" } };
  it("detects the actual GLM-5.3 route limitation before the PDF is dropped", () => {
    const body = { messages: [{ role: "user", content: [pdf, { type: "text", text: "Read this PDF" }] }] };
    const before = structuredClone(body);
    expect(getCapabilitiesForModel("glm", "glm-5.3").pdf).toBe(false);
    expect(hasUnsupportedCurrentDocument(body, FORMATS.OPENAI, getCapabilitiesForModel("glm", "glm-5.3"))).toBe(true);
    expect(body).toEqual(before);
    expect(hasUnsupportedCurrentDocument(body, FORMATS.OPENAI, ALL)).toBe(false);
  });
  it("does not reject a previous-turn PDF when the current user request is text", () => {
    const body = { messages: [{ role: "user", content: [pdf] }, { role: "assistant", content: "ok" }, { role: "user", content: "new question" }] };
    expect(hasUnsupportedCurrentDocument(body, FORMATS.OPENAI, NO_PDF)).toBe(false);
  });
  it.each([
    [FORMATS.CLAUDE, { messages: [{ role: "user", content: [{ type: "document" }] }] }],
    [FORMATS.OPENAI_RESPONSES, { input: [{ role: "user", content: [{ type: "input_file" }] }] }],
    [FORMATS.GEMINI, { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf" } }] }] }],
  ])("detects documents in %s without inspecting or fetching their data", (format, body) => {
    expect(hasUnsupportedCurrentDocument(body, format, NO_PDF)).toBe(true);
  });
});

describe("stripUnsupportedModalities", () => {
  it("fast-exits when model supports all modalities", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, ALL)).toBe(false);
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("openai: strips image when vision:false, leaves placeholder", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).toContain("text");
    expect(types).not.toContain("image_url");
    expect(body.messages[0].content.some((b) => b.type === "text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("openai: strips input_audio when audioInput:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "input_audio", input_audio: { data: "x", format: "wav" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "input_audio")).toBe(false);
    expect(body.messages[0].content.some((b) => /audio omitted/.test(b.text || ""))).toBe(true);
  });

  it("openai: strips file when pdf:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "file", file: { filename: "d.pdf", file_data: "data:application/pdf;base64,x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_PDF);
    expect(body.messages[0].content.some((b) => b.type === "file")).toBe(false);
  });

  it("openai: keeps image when vision:true", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(true);
  });

  it("claude: strips image + document by capability", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: false });
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).not.toContain("image");
    expect(types).not.toContain("document");
    expect(types).toContain("text");
  });

  it("gemini: strips inlineData image by mime when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { text: "hi" },
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(body.contents[0].parts.some((p) => p.inlineData)).toBe(false);
    expect(body.contents[0].parts.some((p) => /image omitted/.test(p.text || ""))).toBe(true);
  });

  it("gemini: keeps inlineData pdf when pdf:true, strips image when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
      { inlineData: { mimeType: "application/pdf", data: "y" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    const mimes = body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.mimeType);
    expect(mimes).toEqual(["application/pdf"]);
  });

  it("antigravity: strips inside request.contents", () => {
    const body = { request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] } };
    stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION);
    expect(body.request.contents[0].parts.some((p) => p.inlineData)).toBe(false);
  });

  it("responses: strips input_image when vision:false", () => {
    const body = { input: [{ role: "user", content: [
      { type: "input_text", text: "hi" },
      { type: "input_image", image_url: "data:image/png;base64,x" },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION);
    expect(body.input[0].content.some((b) => b.type === "input_image")).toBe(false);
    expect(body.input[0].content.some((b) => b.type === "input_text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("handles missing/empty body safely", () => {
    expect(stripUnsupportedModalities(null, FORMATS.OPENAI, NO_VISION)).toBe(false);
    expect(stripUnsupportedModalities({}, FORMATS.OPENAI, null)).toBe(false);
    expect(stripUnsupportedModalities({ messages: [] }, FORMATS.OPENAI, NO_VISION)).toBe(true);
  });
});
