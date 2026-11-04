import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";

const rawUsage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 540_000, cache_creation_input_tokens: 10_000 };
const expected = { prompt_tokens: 550_010, completion_tokens: 50, total_tokens: 550_060, cached_tokens: 540_000, cache_creation_input_tokens: 10_000 };

function claudeEvents(usage = rawUsage) {
  return [
    { type: "message_start", message: { id: "msg_cache", model: "test-model", usage } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    { type: "message_stop" },
  ];
}

async function runStream(events, targetFormat, sourceFormat) {
  let captured;
  const raw = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const transform = createSSEStream({
    targetFormat, sourceFormat, provider: "test-provider", model: "test-model",
    onStreamComplete: (_content, usage) => { captured = usage; },
  });
  const output = await new Response(new Response(raw).body.pipeThrough(transform)).text();
  return { output, usage: canonicalizeUsage(captured) };
}

describe("shared streaming cache accounting", () => {
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, FORMATS.GEMINI])(
    "counts Claude input/cache exactly once for %s clients", async (sourceFormat) => {
      const { usage } = await runStream(claudeEvents(), FORMATS.CLAUDE, sourceFormat);
      expect(usage).toEqual(expected);
      const pricing = { input: 3, output: 15, cached: 0.3, cache_creation: 3.75 };
      const cost = (10 * 3 + 540_000 * 0.3 + 10_000 * 3.75 + 50 * 15) / 1_000_000;
      expect(calculateCostFromTokens(usage, pricing)).toBeCloseTo(cost, 12);
    },
  );

  it("marks translated cache-inclusive state before normalization", () => {
    const state = initState(FORMATS.OPENAI);
    for (const event of claudeEvents()) translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, event, state);
    expect(state.usage.cached_tokens).toBe(540_000);
    expect(state.usage.prompt_tokens_details).toEqual({ cached_tokens: 540_000, cache_creation_tokens: 10_000 });
    expect(canonicalizeUsage(state.usage)).toEqual(expected);
  });

  it("preserves inclusive input when only cache creation is reported", async () => {
    const { usage } = await runStream(claudeEvents({ input_tokens: 10, cache_creation_input_tokens: 550_000 }), FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(usage).toEqual({ ...expected, cached_tokens: 0, cache_creation_input_tokens: 550_000 });
  });

  it("does not lose cache when message_stop arrives without a stop-reason delta", () => {
    const state = initState(FORMATS.OPENAI);
    translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, claudeEvents()[0], state);
    const chunks = translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, { type: "message_stop" }, state);
    expect(chunks[0].usage.prompt_tokens).toBe(550_010);
    expect(chunks[0].usage.prompt_tokens_details.cached_tokens).toBe(540_000);
  });

  it("keeps Kiro cached input inclusive when emitting Claude usage", async () => {
    const events = [
      { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: {
        prompt_tokens: 550_010, completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 540_000, cache_creation_tokens: 10_000 },
      } },
    ];
    const { usage } = await runStream(events, FORMATS.KIRO, FORMATS.CLAUDE);
    expect(usage).toEqual(expected);
  });

  it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])(
    "keeps OpenAI cached input inclusive for %s clients", async (sourceFormat) => {
      const events = [
        { id: "chatcmpl-cache", model: "test-model", choices: [{ delta: { content: "hello" }, finish_reason: null }] },
        { id: "chatcmpl-cache", choices: [{ delta: {}, finish_reason: "stop" }], usage: {
          prompt_tokens: 550_010, completion_tokens: 50, total_tokens: 550_060,
          prompt_tokens_details: { cached_tokens: 540_000, cache_creation_tokens: 10_000 },
        } },
      ];
      const { usage } = await runStream(events, FORMATS.OPENAI, sourceFormat);
      expect(usage).toEqual(expected);
    },
  );
});
