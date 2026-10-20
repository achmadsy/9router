/**
 * LLMprobe-engine probe categories, checks, and status definitions.
 * Follows v0.9.0 - v0.11.0 pipeline engine order.
 */

// Categories mirror the original BazaarLink report: four result sections.
// Engine groups map in — quality/multimodal land under Integrity,
// signature lands under Security.
export const PROBE_CATEGORIES = [
  { id: "identity", label: "Identity", color: "#8B5CF6", badgeVariant: "primary", neutral: true },
  { id: "submodel", label: "Sub-Model ID", color: "#06B6D4", badgeVariant: "default", neutral: true },
  { id: "security", label: "Security Probes", color: "#EF4444", badgeVariant: "error" },
  { id: "integrity", label: "Integrity Checks", color: "#3B82F6", badgeVariant: "info" },
];

export const CATEGORY_MAP = Object.fromEntries(
  PROBE_CATEGORIES.map((cat, idx) => [cat.id, { ...cat, index: idx }])
);

const GROUP_TO_CATEGORY = {
  identity: "identity",
  submodel: "submodel",
  security: "security",
  signature: "security",
  integrity: "integrity",
  quality: "integrity",
  multimodal: "integrity",
};

// Original-page exceptions: channel/infra probes display under Security,
// multimodal runs under Integrity.
const SECURITY_DISPLAY_PROBES = new Set([
  "infra_probe",
  "bedrock_probe",
  "channel_signature",
]);

export function getProbeDisplayGroup(probe) {
  if (SECURITY_DISPLAY_PROBES.has(probe?.id)) return "security";
  return GROUP_TO_CATEGORY[probe?.group] || "integrity";
}

// Back-compat alias for older call sites.
export const getProbeDisplayCategories = (probe) => [getProbeDisplayGroup(probe)];

export const DEFAULT_PROBES = [
  // 1. Quality (10)
  { id: "zh_reasoning", label: "Chinese Reasoning", group: "quality", description: "Multi-step logic in Chinese" },
  { id: "code_gen", label: "Code Generation", group: "quality", description: "Syntactic correctness & standard lib idioms" },
  { id: "instruction_follow", label: "Instruction Following", group: "quality", description: "Multi-constraint negative directive adherence" },
  { id: "en_reasoning", label: "English Reasoning", group: "quality", description: "Symbolic & deductive syllogisms" },
  { id: "math_logic", label: "Math & Proofs", group: "quality", description: "Arithmetic and discrete algebra proofs" },
  { id: "hallucination", label: "Hallucination Resistance", group: "quality", description: "Non-existent entity fact-checking" },
  { id: "censorship", label: "Policy Boundary", group: "quality", description: "False-positive refusal on benign queries" },
  { id: "json_output", label: "JSON Schema Adherence", group: "quality", description: "Strict nested JSON formatting" },
  { id: "prompt_injection", label: "Baseline Injection", group: "quality", description: "Basic system override resistance" },
  { id: "prompt_injection_hard", label: "Adversarial Injection", group: "quality", description: "Complex multi-layer jailbreak resistance" },

  // 2. Security (19)
  { id: "infra_probe", label: "Infra Fingerprint", group: "security", description: "Host runtime & backend environment leaks" },
  { id: "bedrock_probe", label: "Cloud Boundary", group: "security", description: "Upstream hyperscaler wrapper fingerprint" },
  { id: "identity_leak", label: "System Identity Leak", group: "security", description: "Raw system prompt extraction" },
  { id: "supply_prefill", label: "Prefill Exploitation", group: "security", description: "Supply-chain assistant prefix injection" },
  { id: "supply_role_play", label: "Roleplay Jailbreak", group: "security", description: "Persona hijacking bypass" },
  { id: "supply_nested_inst", label: "Nested Instructions", group: "security", description: "Inner XML/delimiter escape" },
  { id: "supply_ignore_prev", label: "Directive Override", group: "security", description: "Explicit instruction wipeout attack" },
  { id: "supply_base64", label: "Base64 Bypass", group: "security", description: "Encoded payload execution" },
  { id: "supply_leetspeak", label: "Leetspeak Obfuscation", group: "security", description: "Substituted character bypass" },
  { id: "supply_unicode", label: "Unicode Homoglyph", group: "security", description: "Confusable character injection" },
  { id: "supply_token_smuggle", label: "Token Smuggling", group: "security", description: "BPE fragment recombination" },
  { id: "supply_context_overflow", label: "Context Overflow", group: "security", description: "Buffer exhaustion behavior" },
  { id: "supply_system_echo", label: "System Echo", group: "security", description: "Mirroring internal developer instructions" },
  { id: "supply_prompt_augment", label: "Prompt Augment", group: "security", description: "Hidden preamble injection" },
  { id: "supply_indirect_inj", label: "Indirect Injection", group: "security", description: "Untrusted external payload execution" },
  { id: "supply_tool_hijack", label: "Tool Call Hijack", group: "security", description: "Synthetic function invocation manipulation" },
  { id: "supply_jailbreak_dan", label: "Persona Jailbreak", group: "security", description: "Do Anything Now adversarial frame" },
  { id: "supply_adversarial_sfx", label: "Adversarial Suffix", group: "security", description: "Gradient-optimized suffix attack" },
  { id: "ac2_url_exfil", label: "URL Exfiltration", group: "security", description: "Markdown link parameter exfiltration" },
  { id: "ac2_markdown_exfil", label: "Image Exfiltration", group: "security", description: "Markdown image tracking pixel exfiltration" },
  { id: "ac2_covert_channel", label: "Covert Channel", group: "security", description: "Side-channel delimiter smuggling" },

  // 3. Integrity (10)
  { id: "knowledge_cutoff", label: "Knowledge Cutoff", group: "integrity", description: "Accurate training temporal boundary" },
  { id: "symbol_exact", label: "Symbol Replication", group: "integrity", description: "Exact token-for-token copy faithfulness" },
  { id: "cache_detection", label: "Cache Detection", group: "integrity", description: "Prompt caching latency delta behavior" },
  { id: "token_inflation", label: "Token Inflation", group: "integrity", description: "Hidden token count pad verification" },
  { id: "sse_compliance", label: "SSE Compliance", group: "integrity", description: "Chunk framing & delimiter standard adherence" },
  { id: "thinking_block", label: "Thinking Blocks", group: "integrity", description: "CoT thinking block preservation" },
  { id: "consistency_check", label: "Deterministic Seed", group: "integrity", description: "Seed reproducibility & sampling stability" },
  { id: "context_length", label: "Context Length", group: "integrity", description: "True window boundary vs claimed max" },
  { id: "channel_signature", label: "Channel Signature", group: "integrity", description: "Upstream HTTP header & TLS signature" },
  { id: "response_augmentation", label: "Response Augment", group: "integrity", description: "Detection of proxy injected wrappers" },

  // 4. Identity (26 neutral probes)
  { id: "id_style_1", label: "Style A1", group: "identity", neutral: true, description: "Lexical preference pattern A1" },
  { id: "id_style_2", label: "Style A2", group: "identity", neutral: true, description: "Lexical preference pattern A2" },
  { id: "id_style_3", label: "Style B1", group: "identity", neutral: true, description: "Punctuation & whitespace habit B1" },
  { id: "id_style_4", label: "Style B2", group: "identity", neutral: true, description: "Punctuation & whitespace habit B2" },
  { id: "id_style_5", label: "Style B3", group: "identity", neutral: true, description: "List formatting idiom B3" },
  { id: "id_style_6", label: "Style B4", group: "identity", neutral: true, description: "List formatting idiom B4" },
  { id: "id_style_7", label: "Style B5", group: "identity", neutral: true, description: "Greeting & signoff fingerprint B5" },
  { id: "id_style_8", label: "Style B6", group: "identity", neutral: true, description: "Greeting & signoff fingerprint B6" },
  { id: "id_tok_1", label: "Tokenizer C1", group: "identity", neutral: true, description: "Byte-pair encoding boundary C1" },
  { id: "id_tok_2", label: "Tokenizer C2", group: "identity", neutral: true, description: "Byte-pair encoding boundary C2" },
  { id: "id_tok_3", label: "Tokenizer C3", group: "identity", neutral: true, description: "Byte-pair encoding boundary C3" },
  { id: "id_code_1", label: "Code Idiom D1", group: "identity", neutral: true, description: "Variable naming & comment style D1" },
  { id: "id_code_2", label: "Code Idiom D2", group: "identity", neutral: true, description: "Variable naming & comment style D2" },
  { id: "id_code_3", label: "Code Idiom D3", group: "identity", neutral: true, description: "Variable naming & comment style D3" },
  { id: "id_self_1", label: "Self-Knowledge E1", group: "identity", neutral: true, description: "Native self-concept representation E1" },
  { id: "id_self_2", label: "Self-Knowledge E2", group: "identity", neutral: true, description: "Native self-concept representation E2" },
  { id: "id_self_3", label: "Self-Knowledge E3", group: "identity", neutral: true, description: "Native self-concept representation E3" },
  { id: "id_comp_1", label: "Computation F1", group: "identity", neutral: true, description: "Floating point precision anomaly F1" },
  { id: "id_comp_2", label: "Computation F2", group: "identity", neutral: true, description: "Floating point precision anomaly F2" },
  { id: "id_cutoff_1", label: "Event Cutoff G1", group: "identity", neutral: true, description: "Chronological anchor event G1" },
  { id: "id_cutoff_2", label: "Event Cutoff G2", group: "identity", neutral: true, description: "Chronological anchor event G2" },
  { id: "id_cutoff_3", label: "Event Cutoff G3", group: "identity", neutral: true, description: "Chronological anchor event G3" },
  { id: "id_cutoff_4", label: "Event Cutoff G4", group: "identity", neutral: true, description: "Chronological anchor event G4" },
  { id: "id_cutoff_5", label: "Event Cutoff G5", group: "identity", neutral: true, description: "Chronological anchor event G5" },
  { id: "id_cutoff_6", label: "Event Cutoff G6", group: "identity", neutral: true, description: "Chronological anchor event G6" },
  { id: "id_cutoff_7", label: "Event Cutoff G7", group: "identity", neutral: true, description: "Chronological anchor event G7" },

  // 5. Signature (1)
  { id: "ac5_signature_verify", label: "Signature Verify", group: "signature", description: "Cryptographic provider token validation" },

  // 6. Multimodal (2)
  { id: "multimodal_image", label: "Vision Reasoning", group: "multimodal", description: "Spatial geometry & OCR resolution" },
  { id: "multimodal_pdf", label: "PDF Document", group: "multimodal", description: "Multi-page structured extraction" },

  // 7. Sub-Model (16 neutral probes)
  { id: "sub_cliff_1", label: "Capability Cliff 1", group: "submodel", neutral: true, description: "Mini vs flagship threshold probe 1" },
  { id: "sub_cliff_2", label: "Capability Cliff 2", group: "submodel", neutral: true, description: "Mini vs flagship threshold probe 2" },
  { id: "sub_cliff_3", label: "Capability Cliff 3", group: "submodel", neutral: true, description: "Mini vs flagship threshold probe 3" },
  { id: "sub_cliff_4", label: "Capability Cliff 4", group: "submodel", neutral: true, description: "Mini vs flagship threshold probe 4" },
  { id: "sub_perf_1", label: "Verbosity Rate 1", group: "submodel", neutral: true, description: "Output length distribution 1" },
  { id: "sub_perf_2", label: "Verbosity Rate 2", group: "submodel", neutral: true, description: "Output length distribution 2" },
  { id: "sub_tok_edge", label: "Tokenizer Edge", group: "submodel", neutral: true, description: "Sub-model BPE variation" },
  { id: "sub_pi_fingerprint", label: "Pi Fingerprint", group: "submodel", neutral: true, description: "Mathematical constant tail accuracy" },
  { id: "sub_v3_direct_1", label: "Direct V1", group: "submodel", neutral: true, description: "Sub-version differential check 1" },
  { id: "sub_v3_direct_2", label: "Direct V2", group: "submodel", neutral: true, description: "Sub-version differential check 2" },
  { id: "sub_v3_direct_3", label: "Direct V3", group: "submodel", neutral: true, description: "Sub-version differential check 3" },
  { id: "sub_ikp_1", label: "IKP Fact 1", group: "submodel", neutral: true, description: "Internal knowledge partition probe 1" },
  { id: "sub_ikp_2", label: "IKP Fact 2", group: "submodel", neutral: true, description: "Internal knowledge partition probe 2" },
  { id: "sub_ikp_3", label: "IKP Fact 3", group: "submodel", neutral: true, description: "Internal knowledge partition probe 3" },
  { id: "sub_ikp_4", label: "IKP Fact 4", group: "submodel", neutral: true, description: "Internal knowledge partition probe 4" },
  { id: "sub_ikp_5", label: "IKP Fact 5", group: "submodel", neutral: true, description: "Internal knowledge partition probe 5" },
];

export const STATUS_META = {
  pending: {
    icon: "radio_button_unchecked",
    label: "Pending",
    bgClass: "bg-surface-2",
    borderClass: "border-border-subtle",
    textClass: "text-text-muted",
  },
  running: {
    icon: "progress_activity",
    label: "Running",
    bgClass: "bg-brand-500/10",
    borderClass: "border-brand-500",
    textClass: "text-brand-500",
  },
  passed: {
    icon: "check_circle",
    label: "Passed",
    bgClass: "bg-emerald-500/15",
    borderClass: "border-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    icon: "cancel",
    label: "Failed",
    bgClass: "bg-red-500/15",
    borderClass: "border-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
  neutral: {
    icon: "lens",
    label: "Neutral Evidence",
    bgClass: "bg-purple-500/15",
    borderClass: "border-purple-500",
    textClass: "text-purple-600 dark:text-purple-400",
  },
  error: {
    icon: "error",
    label: "Error",
    bgClass: "bg-amber-500/15",
    borderClass: "border-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  skipped: {
    icon: "do_not_disturb_on",
    label: "Skipped",
    bgClass: "bg-surface-3",
    borderClass: "border-border",
    textClass: "text-text-muted",
  },
};

export const VERDICT_MAP = {
  clean_match: {
    label: "Verified Authentic",
    badgeVariant: "success",
    description: "Endpoint behavior, styling, and tokenizer match the claimed model.",
  },
  clean_match_submodel_mismatch: {
    label: "Sub-model Variant Mismatch",
    badgeVariant: "warning",
    description: "Matches the correct model family but differs in parameter size or sub-release.",
  },
  spoof_suspected: {
    label: "Spoofing Suspected",
    badgeVariant: "error",
    description: "Model signatures show significant divergence from genuine endpoints.",
  },
  spoof_confirmed: {
    label: "Spoofing Detected",
    badgeVariant: "error",
    description: "Identity and capability cliff tests confirm this is a disguised alternate model.",
  },
  plain_mismatch: {
    label: "Identity Mismatch",
    badgeVariant: "error",
    description: "Model family does not correspond to claimed identity.",
  },
  abstain: {
    label: "Inconclusive",
    badgeVariant: "default",
    description: "Insufficient signal to confirm or refute identity with high confidence.",
  },
};
