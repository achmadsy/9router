import os from "node:os";

/** Main-agent CLI prefix in ZCode 3.17.2. */
export const ZCODE_SYSTEM_IDENTITY_MARKER = "You are ZCode, an interactive agent";

export const ZCODE_SYSTEM_IDENTITY = ZCODE_SYSTEM_IDENTITY_MARKER;

/** Native main-agent identity; a nonempty output style selects its alternate opening. */
export function buildZcodeIdentityPrompt(outputStyle = null, { midConversationSystem = true } = {}) {
  const identityLine = outputStyle?.prompt?.trim()
    ? 'You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.'
    : "You are an agent working with the user toward their goals, using your own judgment along the way.";
  return [
    [
      "",
      identityLine,
      "",
      "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.",
    ].join("\n"),
    "",
    "# Harness",
    " - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    " - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    ` - ${midConversationSystem ? "The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results." : "`<system-reminder>` tags in messages and tool results are injected by the harness, not the user."} Hooks may intercept tool calls; treat hook output as user feedback.`,
    " - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    " - Reference code as `file_path:line_number` — it's clickable.",
  ].join("\n");
}

/** Default identity (no output style) — kept as the constant the marker/detection uses. */
export const ZCODE_SYSTEM_HARNESS = buildZcodeIdentityPrompt();

/** Main-agent Dynamic Behavior section in ZCode 3.17.2. */
export function buildZcodeDynamicBehaviorSection() {
  return [
    "Write code that reads like the surrounding code: match its comment density, naming, and idiom.",
    "When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.",
    "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.",
  ].join("\n\n");
}

/** Main-agent Context Management section in ZCode 3.17.2. */
export function buildZcodeContextManagementSection() {
  const defaultBlock = [
    "# Context management",
    "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.",
  ].join("\n");
  const additional = "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey";
  return [defaultBlock, additional].join("\n\n");
}

/**
 * Native Output Style section (kTr). Emitted only when an outputStyle with a non-empty
 * prompt is active; dynamic cacheHint in native (mapped to ephemeral here like all blocks).
 */
export function buildZcodeOutputStyleSection(outputStyle = null) {
  const prompt = outputStyle?.prompt?.trim();
  if (!prompt) return null;
  const name = outputStyle?.name?.trim() || "custom";
  return [`# Output Style: ${name}`, prompt].join("\n");
}

/**
 * Native Explore subagent prompt (q0t, embeddedSearchEnabled=false default). A read-only
 * file-search/codebase-research specialist. Replaces the main identity for Explore subagent
 * requests; used when the request is a subagent (x-zcode-session-type: subagent).
 */
export function buildZcodeExplorePrompt({ embeddedSearchEnabled = false } = {}) {
  const guidelines = embeddedSearchEnabled
    ? [
        "- Use `find` in Bash for broad file pattern matching",
        "- Use `grep` in Bash for searching file contents with regex",
      ]
    : [
        "- Use Glob for broad file pattern matching",
        "- Use Grep for searching file contents with regex",
      ];
  const bashAllowlist = embeddedSearchEnabled
    ? "ls, git status, git log, git diff, find, grep, cat, head, tail"
    : "ls, git status, git log, git diff, find, cat, head, tail";
  return [
    "You are ZCode Explore, a file search and codebase research specialist for ZCode CLI. You excel at thoroughly navigating and exploring codebases.",
    "",
    "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
    "This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:",
    "- Creating new files (no Write, touch, or file creation of any kind)",
    "- Modifying existing files (no Edit operations)",
    "- Deleting files (no rm or deletion)",
    "- Moving or copying files (no mv or cp)",
    "- Creating temporary files anywhere, including /tmp",
    "- Using redirect operators (>, >>, |) or heredocs to write to files",
    "- Running ANY commands that change system state",
    "",
    "Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.",
    "",
    "Your strengths:",
    "- Rapidly finding files using glob patterns",
    "- Searching code and text with powerful regex patterns",
    "- Reading and analyzing file contents",
    "",
    "Guidelines:",
    ...guidelines,
    "- Use Read when you know the specific file path you need to read",
    `- Use Bash ONLY for read-only operations (${bashAllowlist})`,
    "- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
    "- Adapt your search approach based on the thoroughness level specified by the caller",
    "- Communicate your final report directly as a regular message - do NOT attempt to create files",
    "",
    "NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:",
    "- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations",
    "- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files",
    "",
    "Complete the user's search request efficiently and report your findings clearly.",
  ].join("\n");
}

function textFromSystemBlock(block) {
  if (!block || typeof block !== "object") return "";
  return typeof block.text === "string" ? block.text : "";
}

function hasZcodeSystemMarker(system) {
  const blocks = Array.isArray(system) ? system : [];
  return textFromSystemBlock(blocks[0]).trim() === ZCODE_SYSTEM_IDENTITY_MARKER;
}

/**
 * Build the ZCode environment block (matches ZCode app shape; paths are resolved at request time).
 */
export function buildZcodeEnvironmentBlock({
  modelRef = "builtin:zai-start-plan/GLM-5.2",
  workingDirectory = process.cwd(),
  platform = process.platform,
  shell = process.env.SHELL?.split("/").pop() || "sh",
  osVersion = `${os.type()} ${os.release()} ${os.arch()}`,
  isGitRepository = false,
} = {}) {
  return [
    "# Environment",
    "You have been invoked in the following environment:",
    `- Primary working directory: ${workingDirectory}`,
    `- Is a git repository: ${isGitRepository ? "yes" : "no"}`,
    `- Platform: ${platform}`,
    `- Shell: ${shell}`,
    `- OS Version: ${osVersion}`,
    `- You are powered by the model named ${modelRef}.`,
  ].join("\n");
}

/** Initial main-agent system blocks; runtime environment/reminders belong to message context. */
export function buildZcodeMainSystemPrompt({
  outputStyle = null,
  customSystemPrompt = null,
  guidanceToolNames = [],
  hasSkills = false,
  midConversationSystem = true,
  stableSections = [],
  dynamicSections = [],
} = {}) {
  const custom = typeof customSystemPrompt === "string" && customSystemPrompt.trim() ? `\n${customSystemPrompt}` : null;
  const stable = [custom || buildZcodeIdentityPrompt(outputStyle, { midConversationSystem }), ...stableSections].filter(Boolean);
  const dynamic = [];
  if (!custom) {
    dynamic.push(buildZcodeDynamicBehaviorSection());
    if (hasSkills && guidanceToolNames.includes("Skill")) {
      dynamic.push([
        "# Session-specific guidance",
        " - When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.",
      ].join("\n"));
    }
    dynamic.push(buildZcodeContextManagementSection());
  }
  dynamic.push(...dynamicSections.filter(Boolean));
  return [
    { type: "text", text: ZCODE_SYSTEM_IDENTITY },
    ...(stable.length ? [{ type: "text", text: stable.join("\n\n"), cache_control: { type: "ephemeral" } }] : []),
    ...(dynamic.length ? [{ type: "text", text: `\n\n${dynamic.join("\n\n")}`, cache_control: { type: "ephemeral" } }] : []),
  ];
}

function zcodeSystemBlocks({ modelRef, workingDirectory, outputStyle = null, agentKind = "main" } = {}) {
  const cache = { type: "ephemeral" };

  if (agentKind === "explore") {
    // Explore subagent: own prompt + env only; no coding-behavior dynamic sections.
    const envText = buildZcodeEnvironmentBlock({ modelRef, workingDirectory });
    return [
      { type: "text", text: buildZcodeExplorePrompt(), cache_control: cache },
      { type: "text", text: `\n\n${envText}`, cache_control: cache },
    ];
  }

  return buildZcodeMainSystemPrompt({ outputStyle });
}

/** Add the account-plan context without discarding caller-authored instructions. */
export function injectZcodeSystemPrompt(body, options = {}) {
  if (!body || typeof body !== "object") return body;

  const next = { ...body };
  const existing = typeof next.system === "string"
    ? [{ type: "text", text: next.system }]
    : Array.isArray(next.system) ? [...next.system] : [];

  if (hasZcodeSystemMarker(existing)) {
    return next;
  }

  const preservedText = existing
    .map(textFromSystemBlock)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const modelName =
    typeof next.model === "string" && next.model.length > 0 ? next.model : "GLM-5.2";
  const modelRef = options.modelRef || `builtin:zai-start-plan/${modelName}`;
  const system = zcodeSystemBlocks({
    modelRef,
    workingDirectory: options.workingDirectory,
    outputStyle: options.outputStyle,
    agentKind: options.agentKind,
  });

  // Keep caller instructions together without discarding them or changing their order.
  if (preservedText && system.length > 0) {
    const index = system.length - 1;
    system[index] = {
      ...system[index],
      text: `${system[index].text}\n\n# Additional caller instructions\n${preservedText}`,
    };
  }

  next.system = system;
  return next;
}
