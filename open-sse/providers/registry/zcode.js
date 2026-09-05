const zcode = {
  id: "zcode",
  alias: "zcode",
  display: {
    name: "ZCode (Z.AI)",
    description: "Z.AI Coding Plan via ZCode OAuth subscription",
    icon: "glm",
    color: "#3B82F6",
    textIcon: "ZC",
    docUrl: "https://z.ai",
    website: "https://z.ai",
    notice: {
      text: "Z.AI Coding Plan (Subscription-only). Requires active ZCode membership.",
      signupUrl: "https://z.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    format: "claude",
  },
  models: [
    { id: "glm-5.3", name: "GLM 5.3", upstreamModelId: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM 5.2", upstreamModelId: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM 5.1", upstreamModelId: "GLM-5.1" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo", upstreamModelId: "GLM-5-Turbo" },
    { id: "glm-4.7", name: "GLM 4.7", upstreamModelId: "GLM-4.7" },
  ],
  features: {
    usage: true,
    usageApikey: false,
    modelSwitch: true,
    thinking: true,
    systemPrompt: true,
  },
};

export default zcode;
