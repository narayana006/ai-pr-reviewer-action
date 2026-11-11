/**
 * Parsing of `.ai-review.md`.
 *
 * Every level-two heading is one rule. Bullet lines of the form
 * `- key: value` directly under the heading are settings; everything else is
 * the plain-English description of the rule.
 *
 *     ## No console.log in application code
 *     - paths: src/**
 *     - pattern: console\.log\(
 *     - confidence: 0.95
 *
 *     Debug logging must go through the logger so it can be filtered.
 *
 * A rule with a `pattern` is checked deterministically against added lines.
 * A rule without one is only used by the optional model reviewer.
 */

export interface Rule {
  name: string;
  /** Plain-English text of the rule, shown in comments and sent to the model. */
  description: string;
  /** Globs the rule applies to. Empty means every file. */
  paths: string[];
  /** Globs excluded from the rule. */
  exclude: string[];
  /** Compiled `pattern` setting, when present. */
  pattern?: RegExp;
  /** Replacement text for a suggested fix (supports $1 style groups). */
  replace?: string;
  /** Comment text; falls back to the description. */
  message?: string;
  /** Confidence assigned to deterministic matches of this rule (0 to 1). */
  confidence: number;
  /** Line of the heading in the rules file, for error messages. */
  line: number;
}

export class RuleError extends Error {
  constructor(message: string, readonly line: number) {
    super(`.ai-review.md line ${line}: ${message}`);
    this.name = "RuleError";
  }
}

const SETTING = /^\s*[-*]\s+([A-Za-z-]+)\s*:\s*(.*)$/;
const KNOWN_KEYS = new Set([
  "paths",
  "exclude",
  "pattern",
  "ignore-case",
  "replace",
  "message",
  "confidence",
]);

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().replace(/^`(.*)`$/, "$1"))
    .filter((item) => item.length > 0);
}

/** Strips one pair of surrounding backticks, so regexes can be written as code. */
function stripCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface Draft {
  name: string;
  line: number;
  settings: Map<string, { value: string; line: number }>;
  prose: string[];
}

function finish(draft: Draft): Rule {
  const get = (key: string) => draft.settings.get(key);
  const rule: Rule = {
    name: draft.name,
    description: draft.prose.join("\n").trim(),
    paths: splitList(get("paths")?.value ?? ""),
    exclude: splitList(get("exclude")?.value ?? ""),
    confidence: 1,
    line: draft.line,
  };

  const confidence = get("confidence");
  if (confidence) {
    const value = Number(confidence.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RuleError(
        `confidence must be a number between 0 and 1, got "${confidence.value}"`,
        confidence.line,
      );
    }
    rule.confidence = value;
  }

  const pattern = get("pattern");
  if (pattern) {
    const source = stripCode(pattern.value);
    if (source === "") throw new RuleError("pattern is empty", pattern.line);
    const ignoreCase = /^(true|yes|on)$/i.test(get("ignore-case")?.value.trim() ?? "");
    try {
      rule.pattern = new RegExp(source, ignoreCase ? "i" : "");
    } catch (err) {
      throw new RuleError(`invalid pattern: ${(err as Error).message}`, pattern.line);
    }
  }

  const replace = get("replace");
  if (replace) {
    if (!rule.pattern) {
      throw new RuleError("replace needs a pattern in the same rule", replace.line);
    }
    rule.replace = stripCode(replace.value);
  }

  const message = get("message");
  if (message && message.value.trim() !== "") rule.message = message.value.trim();
  return rule;
}

export function parseRules(markdown: string): Rule[] {
  const rules: Rule[] = [];
  let draft: Draft | null = null;
  let fence: string | null = null;

  const lines = markdown.split(/\r?\n/);
  lines.forEach((text, index) => {
    const lineNo = index + 1;
    const fenceMatch = text.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fence === fenceMatch[1]) fence = null;
      draft?.prose.push(text);
      return;
    }
    if (fence !== null) {
      draft?.prose.push(text);
      return;
    }

    const heading = text.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (draft) rules.push(finish(draft));
      draft = { name: heading[1]!, line: lineNo, settings: new Map(), prose: [] };
      return;
    }
    if (/^#\s/.test(text)) {
      // A level-one heading ends the current rule; text under it is preamble.
      if (draft) rules.push(finish(draft));
      draft = null;
      return;
    }
    if (!draft) return;

    const setting = text.match(SETTING);
    if (setting) {
      const key = setting[1]!.toLowerCase();
      if (KNOWN_KEYS.has(key)) {
        if (draft.settings.has(key)) {
          throw new RuleError(`"${key}" is set twice in rule "${draft.name}"`, lineNo);
        }
        draft.settings.set(key, { value: setting[2]!, line: lineNo });
        return;
      }
    }
    draft.prose.push(text);
  });
  if (draft) rules.push(finish(draft));

  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.name)) {
      throw new RuleError(`duplicate rule name "${rule.name}"`, rule.line);
    }
    seen.add(rule.name);
  }
  return rules;
}

/** Converts a glob (`*`, `**`, `?`) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "");
  // "src/" means everything under src; "*.md" means any markdown file.
  if (pattern.endsWith("/")) pattern += "**";
  if (!pattern.includes("/")) pattern = `**/${pattern}`;

  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        if (atSegmentStart && pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // "**/" also matches zero directories
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when the rule's `paths` and `exclude` settings select this file. */
export function ruleApplies(rule: Rule, path: string): boolean {
  const matches = (globs: string[]) => globs.some((g) => globToRegExp(g).test(path));
  if (rule.exclude.length > 0 && matches(rule.exclude)) return false;
  return rule.paths.length === 0 || matches(rule.paths);
}
