export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    // 429 FreeUsageLimitError is session-scoped (quota is accounted per
    // x-opencode-session): the executor's computeRetryDelay rotates the
    // session and vetoes every other 429, so only free-limit errors retry.
    retry: { 429: { attempts: 2, delayMs: 300 } },
    // Upstream free-tier gate rejects stream:false with 403 FreeTierError
    // (verified live). Force SSE upstream; chatCore converts back to JSON
    // for non-streaming clients via the existing forced-SSE path.
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: [
        "muse-spark-1.2-contributor-free",
        "muse-spark-1.3-contributor-free",
      ],
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content.
      reasoningAliasFields: true,
    },
  },
  models: [
    // Muse Spark models are served by /zen/v1/responses; the rest stay on
    // /chat/completions, so the format is declared per-model, not per-provider.
    // Custom models (e.g. union-alpha, messages-only) carry their endpoint via
    // the dashboard Add Custom Model dropdown — stored on the row as
    // targetFormat, not here.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
