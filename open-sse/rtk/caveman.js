// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.

import { injectSystemPrompt } from "./systemInject.js";
import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";
import { captureRtkError } from "./sentry.js";

export function injectCaveman(body, format, level) {
  try {
    const prompt = CAVEMAN_PROMPTS[level];
    if (!prompt) return;
    injectSystemPrompt(body, format, prompt);
  } catch (err) {
    captureRtkError(err, "caveman:inject", { format, level });
  }
}
