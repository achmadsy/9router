/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * Live upstream probes (OpenCode v2, /inference/v1) show that free-tier
 * requests must declare OpenCode's own `read` and `shell` tools with their exact
 * descriptions and parameter schemas; stubbed descriptions, renamed schemas or
 * tool_choice "none" are answered with 403 FreeTierError. Compatible caller
 * tools back those native declarations through request-local name and argument
 * adapters. Incompatible collisions retain the legacy alias path, and every
 * response path restores the caller's original contract.
 */
import os from "node:os";
import path from "node:path";

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

// Verbatim from the OpenCode v2.1.2 CLI. Upstream compares description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using zsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * True when `tool` already carries OpenCode's exact parameter schema for `key`,
 * so changing only its description cannot expose arguments that the caller's
 * handler does not support.
 *
 * This is the common case, not an edge: OpenCode composes `shell`'s description
 * from `process.platform`, so the very same tool run on Windows reports
 * "Commands run on Windows using pwsh." while the captured definition says
 * "Commands run on Linux using bash." — a two-word difference that an exact
 * string compare rejects.
 */
function canNormalizeInPlace(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  return !!def?.parameters
    && JSON.stringify(def.parameters) === JSON.stringify(FINGERPRINT_TOOL_DEFINITIONS[key].parameters);
}

/**
 * Replace `tool`'s definition with OpenCode's while keeping its name, so the
 * wire carries a single, gate-satisfying tool instead of a caller tool plus a
 * placeholder of the same purpose.
 */
function withFingerprintDefinition(tool, key, name = key) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[key];
  const fn = chatFunctionOf(tool);
  return fn
    ? { ...tool, function: { ...fn, name, description, parameters, strict: false } }
    : { ...tool, name, description, parameters, strict: false };
}

function toolDefinitionOf(tool) {
  return tool && (chatFunctionOf(tool) || tool);
}

function parameterProperties(tool) {
  const schema = toolDefinitionOf(tool)?.parameters;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema.properties || {}
    : {};
}

function requiredParameters(tool) {
  const required = toolDefinitionOf(tool)?.parameters?.required;
  return new Set(Array.isArray(required) ? required : []);
}

function firstParameter(tool, names) {
  const properties = parameterProperties(tool);
  return names.find((name) => properties[name] && typeof properties[name] === "object") || "";
}

function hasStringParameter(tool, name) {
  const param = parameterProperties(tool)[name];
  return !!param && (param.type === "string" || (Array.isArray(param.type) && param.type.includes("string")));
}

function hasBooleanParameter(tool, name) {
  const param = parameterProperties(tool)[name];
  return !!param && (param.type === "boolean" || (Array.isArray(param.type) && param.type.includes("boolean")));
}

function hasNumericParameter(tool, name) {
  const param = parameterProperties(tool)[name];
  return !!param && (["integer", "number"].includes(param.type)
    || (Array.isArray(param.type) && param.type.some((type) => type === "integer" || type === "number")));
}

function normalizedName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readAdapterFor(tool) {
  const name = normalizedName(toolNameOf(tool));
  if (!name || !["read", "readfile", "fileread", "getfile", "loadfile"].includes(name)) return null;
  const path = firstParameter(tool, ["path", "file_path", "filePath", "filename", "file"]);
  if (!path || !hasStringParameter(tool, path) || !requiredParameters(tool).has(path)) return null;
  const offset = firstParameter(tool, ["offset", "line_offset", "lineOffset"]);
  const limit = firstParameter(tool, ["limit", "line_limit", "lineLimit"]);
  const adapter = {
    nativeName: "read",
    callerName: toolNameOf(tool),
    required: [...requiredParameters(tool)],
    properties: parameterProperties(tool),
    arguments: {
      path,
      ...(offset && hasNumericParameter(tool, offset) ? { offset } : {}),
      ...(limit && hasNumericParameter(tool, limit) ? { limit } : {}),
    },
  };
  return adapterCoversRequired(adapter) ? adapter : null;
}

function shellAdapterFor(tool) {
  const name = normalizedName(toolNameOf(tool));
  if (!name || !["bash", "shell", "terminal", "executecommand", "runcommand", "command"].includes(name)) return null;
  const command = firstParameter(tool, ["command", "cmd", "script"]);
  if (!command || !hasStringParameter(tool, command) || !requiredParameters(tool).has(command)) return null;
  const workdir = firstParameter(tool, ["workdir", "cwd", "working_directory", "workingDirectory"]);
  const timeout = firstParameter(tool, ["timeout", "timeout_ms", "timeoutMs"]);
  const timeoutDescription = String(parameterProperties(tool)[timeout]?.description || "").toLowerCase();
  const timeoutIsMilliseconds = timeout === "timeout_ms" || timeout === "timeoutMs"
    || timeoutDescription.includes("millisecond") || timeoutDescription.includes(" ms");
  const background = firstParameter(tool, ["background", "run_in_background", "runInBackground"]);
  const adapter = {
    nativeName: "shell",
    callerName: toolNameOf(tool),
    required: [...requiredParameters(tool)],
    properties: parameterProperties(tool),
    arguments: {
      command,
      ...(workdir && hasStringParameter(tool, workdir) ? { workdir } : {}),
      ...(timeout && timeoutIsMilliseconds && hasNumericParameter(tool, timeout) ? { timeout } : {}),
      ...(background && hasBooleanParameter(tool, background) ? { background } : {}),
    },
  };
  return adapterCoversRequired(adapter) ? adapter : null;
}

function compatibleAdapterFor(tool, key) {
  return key === "read" ? readAdapterFor(tool) : shellAdapterFor(tool);
}

function nativeArgumentName(adapter, callerArgument) {
  return Object.entries(adapter.arguments).find(([, caller]) => caller === callerArgument)?.[0] || callerArgument;
}

function defaultRequiredArgument(name, schema, input) {
  const normalized = normalizedName(name);
  if (["description", "summary", "reason"].includes(normalized)) {
    return typeof input.command === "string" ? input.command.slice(0, 120) : "Run tool";
  }
  if (["dangerouslydisablesandbox", "background", "runinbackground", "allowlarge"].includes(normalized)) return false;
  if (["timeout", "timeoutms"].includes(normalized)) return 120000;
  if (schema?.default !== undefined) return schema.default;
  return undefined;
}

function adapterCoversRequired(adapter) {
  const mapped = new Set(Object.values(adapter.arguments));
  return (adapter.required || []).every((name) =>
    mapped.has(name) || defaultRequiredArgument(name, adapter.properties?.[name], {}) !== undefined);
}

function callerArguments(adapter, input) {
  if (!adapter || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const output = Object.fromEntries(Object.entries(input)
    .filter(([name]) => adapter.arguments[name])
    .map(([name, value]) => [adapter.arguments[name], value]));
  for (const name of adapter.required || []) {
    if (output[name] !== undefined) continue;
    const value = defaultRequiredArgument(name, adapter.properties?.[name], input);
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function nativeArguments(adapter, input) {
  if (!adapter || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const callerArguments = new Set(Object.values(adapter.arguments));
  return Object.fromEntries(Object.entries(input)
    .filter(([name]) => callerArguments.has(name))
    .map(([name, value]) => [nativeArgumentName(adapter, name), value]));
}

function transformJsonArguments(value, adapter, direction) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    const transformed = direction === "caller"
      ? callerArguments(adapter, parsed)
      : nativeArguments(adapter, parsed);
    return JSON.stringify(transformed);
  } catch {
    return value;
  }
}

function findGenericAdapters(tools) {
  const adapters = new Map();
  if (!Array.isArray(tools)) return adapters;
  for (const key of OPENCODE_FINGERPRINT_TOOLS) {
    const candidates = tools
      .map((tool, index) => ({ tool, index, adapter: compatibleAdapterFor(tool, key) }))
      .filter(({ tool, adapter }) => adapter
        && !isFingerprintDefinition(tool, key)
        && !(fingerprintToolKey(toolNameOf(tool)) === key && canNormalizeInPlace(tool, key)));
    if (!candidates.length) continue;
    const exact = candidates.find(({ tool }) => fingerprintToolKey(toolNameOf(tool)) === key);
    adapters.set(key, exact || candidates[0]);
  }
  return adapters;
}

/**
 * Keep exact native definitions in place and conceal incompatible declarations
 * that already occupy a required native name. Semantic aliases such as Read or
 * Bash are handled separately by the generic adapter pass.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const concealed = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }

    if (isFingerprintDefinition(tool, key)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(tool);
      }
      continue;
    }

    if (canNormalizeInPlace(tool, key)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(withFingerprintDefinition(tool, key));
      }
      continue;
    }

    if (concealed.has(key)) continue;
    concealed.add(key);
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

function applyGenericAdapters(tools, adapters, map) {
  if (!adapters.size || !Array.isArray(tools)) return tools;
  const byTool = new Map([...adapters.values()].map((entry) => [entry.tool, entry.adapter]));
  return tools.map((tool) => {
    const adapter = byTool.get(tool);
    if (!adapter) return tool;
    map.set(adapter.nativeName, adapter);
    return withFingerprintDefinition(tool, adapter.nativeName);
  });
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(flat
      ? { type: "function", name, description, parameters, strict: false }
      : { type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

function originalName(mapping) {
  return typeof mapping === "string" ? mapping : mapping?.callerName;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map]
    .map(([alias, mapping]) => [originalName(mapping), alias])
    .filter(([original]) => original));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (item?.type !== "function_call" || !aliases.has(item.name)) return item;
      const alias = aliases.get(item.name);
      const adapter = map.get(alias);
      return {
        ...item,
        name: alias,
        ...(typeof adapter === "object" && typeof item.arguments === "string"
          ? { arguments: transformJsonArguments(item.arguments, adapter, "native") }
          : {}),
      };
    });
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (!aliases.has(name)) return call;
          const alias = aliases.get(name);
          const adapter = map.get(alias);
          return {
            ...call,
            function: {
              ...call.function,
              name: alias,
              ...(typeof adapter === "object" && typeof call.function?.arguments === "string"
                ? { arguments: transformJsonArguments(call.function.arguments, adapter, "native") }
                : {}),
            },
          };
        }),
      };
    });
  }
}

// Without the old "must not be used" descriptions the model does call the
// appended tools (live probe: `read` on "what files are in /etc?"), so tell it
// in the system prompt instead. Upstream does not gate on the prompt text.
// Wording matters: "not available" made the model also refuse the caller's own
// Read/Bash; "placeholders ... use the other tools" kept those working.
// The marker gate reads text only: a foreign system prompt plus this exact block
// passes, so the marker is appended to the caller's own prompt rather than
// replacing it. Values mirror a real CLI instance on this host.
const ENV_TAG = "<env>";
const ENV_HEADING = "Here is some useful information about the environment you are running in:";
const ENV_TMP_DIR = path.join(os.tmpdir(), "opencode");
const ENV_WORKING_DIR = process.cwd();
const ENV_FINGERPRINT_PROMPT = [
  ENV_HEADING,
  ENV_TAG,
  `  Working directory: ${ENV_WORKING_DIR}`,
  `  Workspace root folder: ${ENV_WORKING_DIR}`,
  "  Is directory a git repo: no",
  `  Platform: ${process.platform}`,
  `  Prefer ${ENV_TMP_DIR} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
  "</env>",
].join("\n");

function systemCarriesEnv(system) {
  if (typeof system === "string") return system.includes(ENV_TAG);
  if (Array.isArray(system)) {
    return system.some((block) => typeof block?.text === "string" && block.text.includes(ENV_TAG));
  }
  return false;
}

function appendSystemText(system, text) {
  if (typeof system === "string") {
    return system.trim() ? `${system}\n\n${text}` : text;
  }
  const blocks = Array.isArray(system) ? [...system] : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (typeof block?.text === "string") {
      const existing = block.text.trim();
      blocks[i] = { ...block, text: existing ? `${block.text}\n\n${text}` : text };
      return blocks;
    }
  }
  return [...blocks, { type: "text", text }];
}

function appendSystemNote(body, flat, note, claude = false) {
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  if (claude || body.system !== undefined) {
    body.system = appendSystemText(body.system, note);
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

function noteAdaptedTools(body, flat, map, claude = false) {
  const adapters = [...map.values()].filter((mapping) => mapping && typeof mapping === "object");
  if (!adapters.length) return;
  const labels = adapters.map((adapter) =>
    adapter.nativeName === adapter.callerName
      ? `\`${adapter.nativeName}\``
      : `\`${adapter.nativeName}\` (the caller's \`${adapter.callerName}\` tool)`);
  appendSystemNote(body, flat,
    `The ${labels.join(" and ")} ${labels.length === 1 ? "tool is" : "tools are"} functional and available. Use the native names and schemas shown in the tool definitions.`,
    claude);
}

function noteUnavailableTools(body, flat, names, claude = false) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  appendSystemNote(body, flat, note, claude);
}

export function applyEnvFingerprint(body, flat, { claude = false } = {}) {
  try {
    if (!body || typeof body !== "object") return false;
    if (flat) {
      if (body.instructions !== undefined && typeof body.instructions !== "string") return false;
      if (systemCarriesEnv(body.instructions)) return false;
      body.instructions = typeof body.instructions === "string" && body.instructions.trim()
        ? `${body.instructions}\n\n${ENV_FINGERPRINT_PROMPT}`
        : ENV_FINGERPRINT_PROMPT;
      return true;
    }
    if (claude || body.system !== undefined) {
      if (systemCarriesEnv(body.system)) return false;
      body.system = appendSystemText(body.system, ENV_FINGERPRINT_PROMPT);
      return true;
    }
    if (!Array.isArray(body.messages)) return false;
    const idx = body.messages.findIndex((message) => message?.role === "system");
    if (idx >= 0) {
      const target = body.messages[idx];
      if (systemCarriesEnv(target.content)) return false;
      const content = appendSystemText(target.content, ENV_FINGERPRINT_PROMPT);
      body.messages = body.messages.map((message, i) => (i === idx ? { ...message, content } : message));
      return true;
    }
    body.messages = [{ role: "system", content: ENV_FINGERPRINT_PROMPT }, ...body.messages];
    return true;
  } catch {
    return false;
  }
}

/**
 * Full request-side pass: normalize caller tools that collide with a
 * fingerprint name, append OpenCode's definitions for any that are missing, and
 * tell the model the appended ones are off-limits.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat, { claude = false } = {}) {
  if (!body || typeof body !== "object") return new Map();

  const hadCallerTools = Array.isArray(body.tools) && body.tools.length > 0;
  const genericAdapters = findGenericAdapters(body.tools);
  const adaptedMap = new Map();
  const adaptedTools = applyGenericAdapters(Array.isArray(body.tools) ? body.tools : [], genericAdapters, adaptedMap);
  const { tools, map } = concealFingerprintToolNames(adaptedTools);
  for (const [name, adapter] of adaptedMap) map.set(name, adapter);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  noteAdaptedTools(body, flat, map, claude);
  if (appended.length && (flat || hadCallerTools)) noteUnavailableTools(body, flat, appended, claude);
  applyEnvFingerprint(body, flat, { claude });

  // Responses keeps its explicit auto default. Never default to "none": upstream
  // answers tool_choice "none" with 403 FreeTierError.
  if (!body.tool_choice && flat) body.tool_choice = "auto";

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

export function restoreToolName(name, map) {
  const mapping = typeof name === "string" ? map?.get(name) : null;
  return originalName(mapping) || name;
}

export function restoreToolArguments(name, input, map) {
  const mapping = typeof name === "string" ? map?.get(name) : null;
  if (!mapping || typeof mapping === "string") return input;
  return typeof input === "string"
    ? transformJsonArguments(input, mapping, "caller")
    : callerArguments(mapping, input);
}

function restoreOpenAICall(call, map) {
  const name = call?.function?.name;
  if (typeof name !== "string" || !map.has(name)) return call;
  return {
    ...call,
    function: {
      ...call.function,
      name: restoreToolName(name, map),
      ...(call.function.arguments !== undefined
        ? { arguments: restoreToolArguments(name, call.function.arguments, map) }
        : {}),
    },
  };
}

function restoreResponsesItem(item, map) {
  if (item?.type !== "function_call" || typeof item.name !== "string" || !map.has(item.name)) return item;
  return {
    ...item,
    name: restoreToolName(item.name, map),
    ...(item.arguments !== undefined
      ? { arguments: restoreToolArguments(item.name, item.arguments, map) }
      : {}),
  };
}

/**
 * Buffer argument fragments for adapted OpenAI tool calls until valid JSON is
 * available, then emit one translated argument delta on the finish chunk.
 */
export function adaptOpenAIStreamToolCalls(payload, map, state) {
  if (!map?.size || !payload?.choices || !state) return payload;
  state.calls ??= new Map();
  let changed = false;
  const choices = payload.choices.map((choice) => {
    const calls = choice?.delta?.tool_calls;
    let nextChoice = choice;
    if (Array.isArray(calls)) {
      const nextCalls = calls.map((call) => {
        const index = call.index ?? 0;
        const sentName = call?.function?.name;
        const mapping = sentName ? map.get(sentName) : state.calls.get(index)?.mapping;
        if (!mapping || typeof mapping === "string") return call;
        const current = state.calls.get(index) || { sentName, mapping, arguments: "" };
        if (sentName) current.sentName = sentName;
        if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
        state.calls.set(index, current);
        changed = true;
        return {
          ...call,
          function: {
            ...call.function,
            ...(sentName ? { name: restoreToolName(sentName, map) } : {}),
            ...(call.function?.arguments !== undefined ? { arguments: "" } : {}),
          },
        };
      });
      nextChoice = { ...choice, delta: { ...choice.delta, tool_calls: nextCalls } };
    }

    if (choice?.finish_reason && state.calls.size) {
      const translated = [];
      for (const [index, current] of state.calls) {
        if (!current.arguments) continue;
        translated.push({
          index,
          function: {
            arguments: restoreToolArguments(current.sentName, current.arguments, map),
          },
        });
      }
      if (translated.length) {
        changed = true;
        nextChoice = {
          ...nextChoice,
          delta: {
            ...(nextChoice.delta || {}),
            tool_calls: [...(nextChoice.delta?.tool_calls || []), ...translated],
          },
        };
      }
    }
    return nextChoice;
  });
  return changed ? { ...payload, choices } : payload;
}

function responseCallKey(item, fallback = "") {
  return item?.id || item?.call_id || fallback;
}

/** Buffer and translate Responses API argument events for adapted tools. */
export function adaptResponsesStreamToolCalls(payload, map, state) {
  if (!map?.size || !payload || !state) return payload;
  state.calls ??= new Map();
  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string") {
    const mapping = map.get(item.name);
    if (mapping && typeof mapping === "object") {
      const key = responseCallKey(item, String(payload.output_index ?? ""));
      state.calls.set(key, { sentName: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "" });
      put("item", {
        ...item,
        name: restoreToolName(item.name, map),
        ...(item.arguments !== undefined ? { arguments: restoreToolArguments(item.name, item.arguments, map) } : {}),
      });
    }
  }

  const key = payload.item_id || payload.call_id || String(payload.output_index ?? "");
  const call = state.calls.get(key);
  if (call && payload.type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
    call.arguments += payload.delta;
    put("delta", "");
  }
  if (call && payload.type === "response.function_call_arguments.done") {
    const argumentsText = typeof payload.arguments === "string" ? payload.arguments : call.arguments;
    put("arguments", restoreToolArguments(call.sentName, argumentsText, map));
  }

  if (payload.response && typeof payload.response === "object" && Array.isArray(payload.response.output)) {
    put("response", {
      ...payload.response,
      output: payload.response.output.map((entry) => restoreResponsesItem(entry, map)),
    });
  }

  return out;
}

/** Restore caller tool spellings and argument contracts in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", {
        ...block,
        name: restoreToolName(block.name, map),
        ...(block.input !== undefined ? { input: restoreToolArguments(block.name, block.input, map) } : {}),
      });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? {
            ...block,
            name: restoreToolName(block.name, map),
            ...(block.input !== undefined ? { input: restoreToolArguments(block.name, block.input, map) } : {}),
          }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const restored = restoreOpenAICall(call, map);
          if (restored !== call) changed = true;
          return restored;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) => restoreResponsesItem(item, map)));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", restoreResponsesItem(item, map));
  }

  if (typeof payload.name === "string" && map.has(payload.name)) {
    const sentName = payload.name;
    put("name", restoreToolName(sentName, map));
    if (payload.arguments !== undefined) put("arguments", restoreToolArguments(sentName, payload.arguments, map));
  }

  return out;
}
