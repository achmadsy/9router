// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.

import { injectSystemPrompt } from "./systemInject.js";
import { CAVEMAN_PROMPTS, getCavemanReduction } from "./cavemanPrompts.js";
import { captureRtkError } from "./sentry.js";

export function injectCaveman(body, format, level) {
  try {
    const prompt = CAVEMAN_PROMPTS[level];
    if (!prompt) return null;
    injectSystemPrompt(body, format, prompt);
    return {
      level,
      reduction: getCavemanReduction(level),
      promptChars: prompt.length,
    };
  } catch (err) {
    captureRtkError(err, "caveman:inject", { format, level });
    return null;
  }
}

export function formatCavemanTag(level) {
  const reduction = getCavemanReduction(level);
  return reduction ? `CAVEMAN:${level} (${reduction})` : `CAVEMAN:${level}`;
}
