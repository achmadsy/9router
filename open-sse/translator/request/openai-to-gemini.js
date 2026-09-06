import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
import { getGeminiThoughtSignatureSync } from "../../services/thoughtSignatureStore.js";
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity
} from "../formats/gemini.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";

// Sanitize function names for Gemini API.
// Gemini requires: starts with [a-zA-Z_], followed by [a-zA-Z0-9_.:\-], max 64 chars.
// Replace any invalid character with '_' and truncate to 64.
function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  // Replace any char not in [a-zA-Z0-9_.:\-] with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  // First char must be letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  // Truncate to 64 chars
  return sanitized.substring(0, 64);
}

// Gemini-family upstreams require strict user/model alternation and reject
// requests whose contents end with a "model" turn ("Requests ending model turn
// are not supported." HTTP 400). A trailing model turn can appear when a client
// sends a trailing assistant message (prefill) or an unanswered tool call, or
// when a compression round-trip drops a tool response. Repair both here:
//  - drop trailing model turns entirely (upstream has nothing to respond to);
//  - drop orphaned functionCall parts that lack a matching functionResponse
//    in a later turn (unanswered calls cannot precede a new user turn).

const INSTRUCTIONS_REGEX = /<instructions>([\s\S]*?)<\/instructions>/gi;

// Extract <instructions>...</instructions> blocks from text.
// Returns { instructions: string[], cleanText: string }
function extractInstructionsFromText(text) {
  if (typeof text !== "string" || !text.includes("<instructions>")) {
    return { instructions: [], cleanText: text };
  }
  const instructions = [];
  const cleanText = text.replace(INSTRUCTIONS_REGEX, (_, inner) => {
    const trimmed = inner.trim();
    if (trimmed) instructions.push(trimmed);
    return "";
  }).trim();
  return { instructions, cleanText };
}
function normalizeGeminiContents(contents) {
  // First pass: collect functionResponse ids available anywhere in the conversation.
  const answeredIds = new Set();
  for (const c of contents || []) {
    for (const part of c?.parts || []) {
      if (part.functionResponse?.id) answeredIds.add(part.functionResponse.id);
      else if (part.functionResponse?.name) answeredIds.add(`call_${part.functionResponse.name}`);
    }
  }

  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts) || c.parts.length === 0) continue;
    let parts = c.parts;
    if (c.role === GEMINI_ROLE.MODEL) {
      const kept = parts.filter(part => {
        if (!part.functionCall) return true;
        const id = part.functionCall.id || `call_${part.functionCall.name}`;
        return answeredIds.has(id);
      });
      if (kept.length !== parts.length) parts = kept;
      // Turns left with no meaningful parts (empty text/signature-only) are dropped
      if (parts.length === 0 || parts.every(p => p.text === "" && !p.functionCall)) continue;
    }
    const last = out.at(-1);
    if (last?.role === c.role) last.parts.push(...parts);
    else out.push({ ...c, parts: [...parts] });
  }

  // Second pass: a trailing model turn gives the API nothing to respond to.
  while (out.length > 0 && out.at(-1).role === GEMINI_ROLE.MODEL) {
    out.pop();
  }
  return out;
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(model, body, stream, signature = DEFAULT_THINKING_AG_SIGNATURE, sessionId = null) {
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS
  };

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.max_tokens !== undefined) {
    result.generationConfig.maxOutputTokens = body.max_tokens;
  }

  // Build tool_call_id -> name map
  const tcID2Name = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === OPENAI_BLOCK.FUNCTION && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
    }
  }

  // Build tool responses cache
  const toolResponses = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.TOOL && msg.tool_call_id) {
        toolResponses[msg.tool_call_id] = msg.content;
      }
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM && body.messages.length > 1) {
        result.systemInstruction = {
          role: GEMINI_ROLE.USER,
          parts: [{ text: typeof content === "string" ? content : extractTextContent(content) }]
        };
      } else if (role === ROLE.USER || (role === ROLE.SYSTEM && body.messages.length === 1)) {
        // Extract mid-conversation <instructions> tags (from Claude Code system reminders)
        // Move them to systemInstruction so Gemini treats them as system guidance,
        // not user dialog to echo or converse about.
        let userContent = content;
        if (typeof content === "string" && content.includes("<instructions>")) {
          const { instructions, cleanText } = extractInstructionsFromText(content);
          if (instructions.length > 0) {
            if (!result.systemInstruction) {
              result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [] };
            }
            for (const instr of instructions) {
              result.systemInstruction.parts.push({ text: instr });
            }
          }
          userContent = cleanText;
        } else if (Array.isArray(content)) {
          const cleanedArray = [];
          for (const item of content) {
            if (item && item.type === OPENAI_BLOCK.TEXT && typeof item.text === "string" && item.text.includes("<instructions>")) {
              const { instructions, cleanText } = extractInstructionsFromText(item.text);
              if (instructions.length > 0) {
                if (!result.systemInstruction) {
                  result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [] };
                }
                for (const instr of instructions) {
                  result.systemInstruction.parts.push({ text: instr });
                }
              }
              if (cleanText) {
                cleanedArray.push({ ...item, text: cleanText });
              }
            } else {
              cleanedArray.push(item);
            }
          }
          userContent = cleanedArray;
        }

        const parts = convertOpenAIContentToParts(userContent);
        if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
          parts.push({
            thoughtSignature: signature,
            text: ""
          });
        }

        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({ text });
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolCallIds = [];
          let firstFunctionCallSeen = false;
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const cachedSig = tc.id ? getGeminiThoughtSignatureSync(tc.id, sessionId) : null;
            // First call gets cached signature or fallback; sibling calls remain unsigned if no cached sig
            const callSig = cachedSig || (!firstFunctionCallSeen ? signature : undefined);
            firstFunctionCallSeen = true;

            const part = {
              functionCall: {
                id: tc.id,
                name: sanitizeGeminiFunctionName(tc.function.name),
                args: args
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
            toolCallIds.push(tc.id);
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }

          // Check if there are actual tool responses in the next messages
          const hasActualResponses = toolCallIds.some(fid => toolResponses[fid]);

          if (hasActualResponses) {
            const toolParts = [];
            for (const fid of toolCallIds) {
              if (!toolResponses[fid]) continue;

              let name = tcID2Name[fid];
              if (!name) {
                const idParts = fid.split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = fid;
                }
              }

              let resp = toolResponses[fid];
              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = { result: resp };
              } else if (typeof parsedResp !== "object") {
                parsedResp = { result: parsedResp };
              }

              toolParts.push({
                functionResponse: {
                  id: fid,
                  name: sanitizeGeminiFunctionName(name),
                  response: { result: parsedResp }
                }
              });
            }
            if (toolParts.length > 0) {
              result.contents.push({ role: GEMINI_ROLE.USER, parts: toolParts });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      }
    }
  }

  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(t.input_schema || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(t.name),
          description: t.description || "",
          parameters: cleanedSchema
        });
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(fn.parameters || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(fn.name),
          description: fn.description || "",
          parameters: cleanedSchema
        });
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  result.contents = normalizeGeminiContents(result.contents);
  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream, credentials = null) {
  return openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_AG_SIGNATURE, credentials?._clientSessionId);
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream, credentials = null) {
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE, credentials?._clientSessionId);
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Clean schema for tools
  if (gemini.tools?.[0]?.functionDeclarations) {
    for (const fn of gemini.tools[0].functionDeclarations) {
      if (fn.parameters) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(fn.parameters);
        fn.parameters = cleanedSchema;
        // if (isClaude) {
        //   fn.parameters = cleanedSchema;
        // } else {
        //   fn.parametersJsonSchema = cleanedSchema;
        //   delete fn.parameters;
        // }
      }
    }
  }

  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || (isAntigravity ? deriveSessionId(credentials?.email || credentials?.connectionId) : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    }
  };

  // Antigravity specific fields
  if (isAntigravity) {
    envelope.requestType = "agent";
  } else {
    // Keep safetySettings for Gemini CLI
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" }
    };
  }

  return envelope;
}

// Wrap Claude format in Cloud Code envelope for Antigravity
function wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials = null, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    requestType: "agent",
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: claudeRequest.temperature || 1,
        maxOutputTokens: claudeRequest.max_tokens || 4096
      }
    }
  };

  // Build tool_use id -> name map so functionResponse can use the correct name
  const toolUseIdToName = {};
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
            toolUseIdToName[block.id] = block.name;
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  const extractedInstructions = [];
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];

      if (Array.isArray(msg.content)) {
        let firstToolUseSeen = false;
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TEXT) {
            if (msg.role !== ROLE.ASSISTANT && typeof block.text === "string" && block.text.includes("<instructions>")) {
              const { instructions, cleanText } = extractInstructionsFromText(block.text);
              extractedInstructions.push(...instructions);
              if (cleanText) parts.push({ text: cleanText });
            } else {
              parts.push({ text: block.text });
            }
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            const cachedSig = block.id ? getGeminiThoughtSignatureSync(block.id, credentials?._clientSessionId) : null;
            const callSig = cachedSig || (!firstToolUseSeen ? signature : undefined);
            firstToolUseSeen = true;

            const part = {
              functionCall: {
                id: block.id,
                name: sanitizeGeminiFunctionName(block.name),
                args: block.input || {}
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              content = content.map(c => c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c)).join("\n");
            }
            // Resolve the original tool name from the id — Gemini requires it to match the functionCall name
            const resolvedName = toolUseIdToName[block.tool_use_id]
              ? sanitizeGeminiFunctionName(toolUseIdToName[block.tool_use_id])
              : "tool";
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: resolvedName,
                response: { result: tryParseJSON(content) || content }
              }
            });
          }
        }
      } else if (typeof msg.content === "string") {
        if (msg.role !== ROLE.ASSISTANT && msg.content.includes("<instructions>")) {
          const { instructions, cleanText } = extractInstructionsFromText(msg.content);
          extractedInstructions.push(...instructions);
          if (cleanText) parts.push({ text: cleanText });
        } else {
          parts.push({ text: msg.content });
        }
      }

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(tool.input_schema);
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(tool.name),
          description: tool.description || "",
          parameters: cleanedSchema
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" }
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: block.text });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: claudeRequest.system });
    }
  }

  for (const instr of extractedInstructions) {
    systemParts.push({ text: instr });
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  envelope.request.contents = normalizeGeminiContents(envelope.request.contents);
  return envelope;
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials);
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, (model, body, stream, credentials) => wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream), credentials), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
