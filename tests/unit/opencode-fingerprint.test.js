import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  applyEnvFingerprint,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  adaptOpenAIStreamToolCalls,
  adaptResponsesStreamToolCalls,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

describe("opencodeFingerprint — request side", () => {
  it("appends exact read/shell definitions when caller tools have no usable schema", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual([...CC_TOOLS, ...OPENCODE_FINGERPRINT_TOOLS]);
    expect(map.size).toBe(0);
    const shell = body.tools.find((tool) => tool.name === "shell");
    expect(shell.description).toMatch(/^Execute a shell command/);
    expect(shell.parameters.required).toEqual(["command"]);
    expect(shell.strict).toBe(false);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["Edit", "read", "shell"]);
    const read = body.tools.find((tool) => tool.function?.name === "read");
    expect(read.function.parameters.required).toEqual(["path"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const body = { tools: flat(["read", "read_client", "Edit"]) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client2", "read_client", "Edit", "read", "shell"]);
    expect(map.get("read_client2")).toBe("read");
  });

  it("keeps a caller tool that already carries OpenCode's exact definition", () => {
    const first = { tools: [] };
    applyFingerprintTools(first, true);
    const official = first.tools.map((tool) => ({ ...tool }));

    const body = { tools: official };
    const map = applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(map.size).toBe(0);
    expect(body.instructions).toContain("<env>");
  });

  it("drops duplicate declarations of one fingerprint name", () => {
    const body = { tools: flat(["shell", "shell"]) };
    applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
  });

  it("defaults Responses tool_choice to auto and never to none for chat", () => {
    const responses = { tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.tool_choice).toBe("auto");

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(namesOf(chatBody.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(chatBody.tool_choice).toBeUndefined();
  });

  it("adds placeholder guidance where no generated chat envelope will explain the tools", () => {
    const responses = { instructions: "Be brief.", tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.instructions).toContain("Do not call the `read` or `shell` tools;");
    expect(responses.instructions).toContain("<env>");

    const chatBody = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(chatBody.messages).toHaveLength(2);
    expect(chatBody.messages[0].content).toContain("<env>");
    expect(chatBody.messages[0].content).not.toContain("placeholders that do nothing");

    const noSystem = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(noSystem, false);
    expect(noSystem.messages[0]).toEqual({ role: "system", content: expect.stringContaining("<env>") });

    const claudeShape = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(claudeShape, false, { claude: true });
    expect(claudeShape.messages).toHaveLength(1);
    expect(claudeShape.system).toContain("<env>");
  });

  it("retargets flat tool_choice that points at an aliased tool", () => {
    const body = { tools: flat(["shell"]), tool_choice: { type: "function", name: "shell" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("shell_client");
  });

  it("retargets nested tool_choice that points at an aliased tool", () => {
    const body = {
      tools: chat(["read"]),
      tool_choice: { type: "function", function: { name: "read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(["read"]) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — in-place normalization", () => {
  // OpenCode builds shell's description from process.platform, so the very same
  // tool on Windows or macOS never matches the captured Linux definition.
  const shellTool = (os, shell, name = "shell") => ({
    type: "function",
    name,
    description:
      "Execute a shell command and return its output. Commands run on " + os + " using " + shell + ". Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
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
  });

  const asChat = (tool) => ({
    type: tool.type,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  });
  const windowsShell = () => shellTool("Windows", "pwsh");

  it("adopts OpenCode's definition when the native name and arguments line up", () => {
    const body = { tools: [windowsShell(), { type: "function", name: "Edit" }] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "Edit", "read"]);
    expect(map.size).toBe(0);
    expect(takeRenamedToolNames(body)).toBeNull();
    expect(body.tools[0].description).toContain("Commands run on Linux using zsh.");
    expect(body.tools[0].parameters.required).toEqual(["command"]);
    // Only the genuinely absent `read` is still advertised as a placeholder.
    expect(body.instructions).toContain("Do not call the `read` tool; it is a placeholder that does nothing. Use the other tools you have been given instead.");
    expect(body.instructions).toContain("<env>");
  });

  it("normalizes the nested chat shape without adding a system note", () => {
    const body = { tools: [asChat(windowsShell())] };
    const map = applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    expect(map.size).toBe(0);
    expect(body.messages).toBeUndefined();
    expect(body.tools[0].function.description).toContain("Commands run on Linux using zsh.");
  });

  it("wires a real OpenCode client down to exactly read + shell", () => {
    const seeded = { tools: [] };
    applyFingerprintTools(seeded, false);
    const officialRead = seeded.tools.find((tool) => tool.function?.name === "read");

    const body = { tools: [officialRead, asChat(windowsShell())] };
    const map = applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["read", "shell"]);
    expect(map.size).toBe(0);
    expect(body.messages).toBeUndefined();
  });

  it("no longer invents alias names that a client plugin may already own", () => {
    const pluginTool = (name) => ({
      type: "function",
      name,
      description: "Execute a shell command and return its output.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    });
    const body = { tools: [pluginTool("shell_client"), pluginTool("shell_client2"), windowsShell()] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell_client", "shell_client2", "shell", "read"]);
    expect(map.size).toBe(0);
  });

  it("adapts a reserved shell name when its core command contract is usable", () => {
    const body = {
      tools: [{
        type: "function",
        name: "shell",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    expect(map.get("shell").callerName).toBe("shell");
    expect(map.get("shell").arguments.command).toBe("cmd");
    expect(body.instructions).toContain("`read` tool");
  });

  it("adapts a different harness that exposes only a command argument", () => {
    const body = {
      tools: [{
        type: "function",
        name: "shell",
        description: "Execute a command in this harness.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "Command to run" } },
          required: ["command"],
          additionalProperties: false,
        },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    expect(map.get("shell").callerName).toBe("shell");
    expect(body.tools[0].parameters.properties).toHaveProperty("workdir");
  });

  it("does not normalize a different harness with altered parameter semantics", () => {
    const tool = windowsShell();
    tool.parameters.properties.timeout.description = "Timeout in seconds";
    const body = { tools: [tool] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    expect(map.get("shell").arguments).not.toHaveProperty("timeout");
    expect(body.tools[0].parameters.properties.timeout.description).toContain("milliseconds");
  });

  it("adapts read while dropping caller-only optional arguments from native history", () => {
    const body = {
      tools: [{
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } }, required: ["path"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read", "shell"]);
    expect(map.get("read").callerName).toBe("read");
    expect(map.get("read").arguments).toEqual({ path: "path" });
  });

  it("conceals when the caller is missing a required fingerprint argument", () => {
    const body = {
      tools: [{
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {}, required: [] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client", "read", "shell"]);
    expect(map.get("read_client")).toBe("read");
  });
});

describe("opencodeFingerprint — generic harness adapters", () => {
  const claudeRead = {
    type: "function",
    name: "Read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
        pages: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  };
  const claudeBash = {
    type: "function",
    name: "Bash",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
        description: { type: "string" },
        run_in_background: { type: "boolean" },
        dangerouslyDisableSandbox: { type: "boolean" },
      },
      required: ["command", "description", "run_in_background", "dangerouslyDisableSandbox"],
      additionalProperties: false,
    },
  };

  it("backs native read and shell with Claude-style caller tools", () => {
    const body = { tools: [claudeRead, claudeBash, { type: "function", name: "Edit" }] };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read", "shell", "Edit"]);
    expect(map.get("read").callerName).toBe("Read");
    expect(map.get("shell").callerName).toBe("Bash");
    expect(body.instructions).toContain("`read` (the caller's `Read` tool)");
    expect(body.instructions).toContain("`shell` (the caller's `Bash` tool)");
  });

  it("restores Claude-style names and argument contracts", () => {
    const body = { tools: [claudeRead, claudeBash] };
    const map = applyFingerprintTools(body, true);
    const response = {
      choices: [{ message: { tool_calls: [
        { function: { name: "read", arguments: '{"path":"/tmp/a","offset":2}' } },
        { function: { name: "shell", arguments: '{"command":"pwd","background":true}' } },
      ] } }],
    };

    const out = restoreToolNames(response, map);
    expect(out.choices[0].message.tool_calls[0].function).toEqual({
      name: "Read",
      arguments: '{"file_path":"/tmp/a","offset":2}',
    });
    expect(JSON.parse(out.choices[0].message.tool_calls[1].function.arguments)).toEqual({
      command: "pwd",
      run_in_background: true,
      description: "pwd",
      dangerouslyDisableSandbox: false,
    });
  });

  it("adapts lowercase Codex/OpenAI-style tools without client detection", () => {
    const body = {
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { filePath: { type: "string" }, lineOffset: { type: "integer" } },
            required: ["filePath"],
          },
        },
      }, {
        type: "function",
        function: {
          name: "terminal",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" } },
            required: ["cmd"],
          },
        },
      }],
    };
    const map = applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["read", "shell"]);
    expect(map.get("read").callerName).toBe("read_file");
    expect(map.get("shell").callerName).toBe("terminal");
  });

  it("does not confuse a write_file tool with a read capability", () => {
    const body = {
      tools: [{
        type: "function",
        name: "write_file",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["write_file", "read", "shell"]);
    expect(map.size).toBe(0);
  });

  it("keeps an incompatible reserved tool separate from a compatible alias", () => {
    const body = {
      tools: [{
        type: "function",
        name: "read",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }, claudeRead],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client", "read", "shell"]);
    expect(map.get("read_client")).toBe("read");
    expect(map.get("read").callerName).toBe("Read");
  });

  it("rejects a semantic alias whose required arguments cannot be synthesized", () => {
    const body = {
      tools: [{
        type: "function",
        name: "terminal",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, approval_ticket: { type: "string" } },
          required: ["command", "approval_ticket"],
        },
      }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["terminal", "read", "shell"]);
    expect(map.size).toBe(0);
  });

  it("keeps guarded placeholders for incompatible unknown harness tools", () => {
    const body = {
      instructions: "Be useful.",
      tools: [{ type: "function", name: "filesystem_lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["filesystem_lookup", "read", "shell"]);
    expect(map.size).toBe(0);
    expect(body.instructions).toContain("placeholders that do nothing");
  });

  it("rewrites prior caller tool history into the native contract", () => {
    const body = {
      tools: [claudeRead],
      messages: [{ role: "assistant", tool_calls: [{ function: { name: "Read", arguments: '{"file_path":"/tmp/a","pages":"1"}' } }] }],
    };
    applyFingerprintTools(body, true);

    expect(body.messages[0].tool_calls[0].function).toEqual({
      name: "read",
      arguments: '{"path":"/tmp/a"}',
    });
  });

  it("buffers Responses argument events before restoring a caller schema", () => {
    const body = { tools: [claudeRead] };
    const map = applyFingerprintTools(body, true);
    const state = {};
    const added = adaptResponsesStreamToolCalls({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_c1", type: "function_call", call_id: "c1", name: "read", arguments: "" },
    }, map, state);
    const delta = adaptResponsesStreamToolCalls({
      type: "response.function_call_arguments.delta",
      item_id: "fc_c1",
      output_index: 0,
      delta: '{"path":"/tmp/a"}',
    }, map, state);
    const done = adaptResponsesStreamToolCalls({
      type: "response.function_call_arguments.done",
      item_id: "fc_c1",
      output_index: 0,
      arguments: '{"path":"/tmp/a"}',
    }, map, state);

    expect(added.item.name).toBe("Read");
    expect(delta.delta).toBe("");
    expect(done.arguments).toBe('{"file_path":"/tmp/a"}');
  });

  it("restores adapted tools in Responses terminal output", () => {
    const body = { tools: [claudeRead] };
    const map = applyFingerprintTools(body, true);
    const event = adaptResponsesStreamToolCalls({
      type: "response.completed",
      response: { output: [{ type: "function_call", name: "read", arguments: '{"path":"/tmp/a"}' }] },
    }, map, {});

    expect(event.response.output[0]).toEqual({
      type: "function_call",
      name: "Read",
      arguments: '{"file_path":"/tmp/a"}',
    });
  });

  it("buffers fragmented arguments before restoring a caller schema", () => {
    const body = { tools: [claudeRead] };
    const map = applyFingerprintTools(body, true);
    const state = {};
    const first = adaptOpenAIStreamToolCalls({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"pa' } }] }, finish_reason: null }],
    }, map, state);
    const second = adaptOpenAIStreamToolCalls({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/a"}' } }] }, finish_reason: null }],
    }, map, state);
    const finish = adaptOpenAIStreamToolCalls({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, map, state);

    expect(first.choices[0].delta.tool_calls[0].function.name).toBe("Read");
    expect(first.choices[0].delta.tool_calls[0].function.arguments).toBe("");
    expect(second.choices[0].delta.tool_calls[0].function.arguments).toBe("");
    expect(finish.choices[0].delta.tool_calls[0].function.arguments).toBe('{"file_path":"/tmp/a"}');
  });
});

describe("applyEnvFingerprint", () => {
  it("appends the environment marker to chat system text", () => {
    const body = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages[0].content).toContain("Be brief.");
    expect(body.messages[0].content).toContain("<env>");
  });

  it("does not duplicate an existing environment marker", () => {
    const body = { messages: [{ role: "system", content: "x\n\n<env>\n</env>" }] };
    expect(applyEnvFingerprint(body, false)).toBe(false);
    expect(body.messages[0].content.match(/<env>/g)).toHaveLength(1);
  });

  it("supports Responses instructions", () => {
    const body = { instructions: "Be brief." };
    expect(applyEnvFingerprint(body, true)).toBe(true);
    expect(body.instructions).toContain("Be brief.");
    expect(body.instructions).toContain("<env>");
  });

  it("supports Claude system text blocks without adding a system message", () => {
    const body = { system: [{ type: "text", text: "Be brief." }], messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system[0].text).toContain("<env>");
    expect(body.messages).toHaveLength(1);
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches exact fingerprint names only", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" shell ")).toBe("shell");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
