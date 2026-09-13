import os from "node:os";

/** Substring used to detect ZCode identity blocks (idempotent injection). */
export const ZCODE_SYSTEM_IDENTITY_MARKER = "You are ZCode, an interactive coding agent";

export const ZCODE_SYSTEM_IDENTITY = ZCODE_SYSTEM_IDENTITY_MARKER;

/**
 * Native identity section (u9o). `outputStyle` truthy switches the opening line to the
 * Output Style variant; default is the interactive-agent line. Exact content, leading newline
 * from the inner join preserved.
 */
export function buildZcodeIdentityPrompt(outputStyle = null) {
  const identityLine = outputStyle
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.";
  return [
    [
      "",
      identityLine,
      "",
      "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.",
    ].join("\n"),
    "",
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` — it's clickable.",
  ].join("\n");
}

/** Default identity (no output style) — kept as the constant the marker/detection uses. */
export const ZCODE_SYSTEM_HARNESS = buildZcodeIdentityPrompt();

/**
 * Native Dynamic Behavior section (wTr, from Xlt). Always emitted after Environment in the
 * dynamic system message. Exact content.
 */
export function buildZcodeDynamicBehaviorSection() {
  const beforeDefault = [
    "# Communicating with the user",
    "",
    "Your text output is what the user reads; they usually can't see your thinking or the raw tool results. Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction.",
    "",
    "Text you write between tool calls may not be shown to the user. Everything the user needs from this turn — answers, summaries, findings, conclusions, deliverables — must be in the final text message of your turn, with no tool calls after it. Keep text between tool calls to brief status notes. If something important appeared only mid-turn or in your thinking, restate it in that final message.",
    "",
    'Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find" — the thing the user would ask for if they said "just give me the TLDR." Supporting detail and reasoning come after, for readers who want them.',
    "",
    "Being readable and being concise are different things, and readable matters more. If the user has to reread your summary or ask you to explain, any time saved by brevity is gone. The way to keep output short is to be selective about what you include (drop details that don't change what the reader would do next), not to compress the writing into fragments, abbreviations, arrow chains like `A → B → fails`, or jargon. What you do include, write in complete sentences with the technical terms spelled out. Don't make the reader cross-reference labels or numbering you invented earlier; say what you mean in place.",
    "",
    "Match the response to the question: a simple question gets a direct answer in prose, not headers and sections. Use tables only for short enumerable facts, with explanations in the surrounding prose rather than the cells. Calibrate to the user — a bit tighter for an expert, more explanatory for someone newer.",
  ].join("\n");
  const defaultLine =
    "Write code that reads like the surrounding code: match its comment density, naming, and idiom.";
  const afterDefault =
    "Only write a code comment to state a constraint the code itself can't show — never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the PR merges.";
  const hardToReverse =
    "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.";
  return [beforeDefault, "", defaultLine, afterDefault, "", hardToReverse].join("\n");
}

/**
 * Native Context Management section (STr, from xTr). Always emitted after Output Style in the
 * dynamic system message. Exact content.
 */
export function buildZcodeContextManagementSection() {
  const defaultBlock = [
    "# Context management",
    "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.",
  ].join("\n");
  const additional = [
    "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey",
    "",
    "You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not.",
    "",
    "Exception: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one.",
    "",
    "Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.",
    "",
    "Before running a command that changes system state — restarts, deletes, config edits — check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.",
  ].join("\n");
  return [defaultBlock, "", additional].join("\n");
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

const CLAUDE_CODE_SYSTEM_MARKERS = [
  "You are Claude Code",
  "Anthropic's official CLI for Claude",
];

function textFromSystemBlock(block) {
  if (!block || typeof block !== "object") return "";
  return typeof block.text === "string" ? block.text : "";
}

function isClaudeCodeSystemBlock(block) {
  const text = textFromSystemBlock(block);
  return CLAUDE_CODE_SYSTEM_MARKERS.some((marker) => text.includes(marker));
}

function hasZcodeSystemMarker(system) {
  const blocks = Array.isArray(system) ? system : [];
  return blocks.some((block) => textFromSystemBlock(block).includes(ZCODE_SYSTEM_IDENTITY_MARKER));
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

  // Main agent (native assembleSystemMessages): msg1 = CLI Prefix, msg2 = Identity,
  // msg3 = "\n\n" + dynamic sections joined by "\n\n" (order: DynamicBehavior, Env, OutputStyle?, ContextManagement).
  const dynamic = [
    buildZcodeDynamicBehaviorSection(),
    buildZcodeEnvironmentBlock({ modelRef, workingDirectory }),
  ];
  const outputStyleSection = buildZcodeOutputStyleSection(outputStyle);
  if (outputStyleSection) dynamic.push(outputStyleSection);
  dynamic.push(buildZcodeContextManagementSection());

  return [
    { type: "text", text: ZCODE_SYSTEM_IDENTITY, cache_control: cache },
    { type: "text", text: buildZcodeIdentityPrompt(outputStyle), cache_control: cache },
    { type: "text", text: `\n\n${dynamic.join("\n\n")}`, cache_control: cache },
  ];
}

/**
 * Replace Claude Code default system prompt with ZCode blocks for Coding Plan upstream.
 * Preserves caller-provided system text (non-Claude-Code blocks).
 */
export function injectZcodeSystemPrompt(body, options = {}) {
  if (!body || typeof body !== "object") return body;

  const next = { ...body };
  const existing = Array.isArray(next.system) ? [...next.system] : [];

  if (hasZcodeSystemMarker(existing)) {
    return next;
  }

  const preserved = existing.filter((block) => !isClaudeCodeSystemBlock(block));
  const modelName =
    typeof next.model === "string" && next.model.length > 0 ? next.model : "GLM-5.2";
  const modelRef = options.modelRef || `builtin:zai-start-plan/${modelName}`;

  next.system = [
    ...zcodeSystemBlocks({
      modelRef,
      workingDirectory: options.workingDirectory,
      outputStyle: options.outputStyle,
      agentKind: options.agentKind,
    }),
    ...preserved,
  ];

  return next;
}