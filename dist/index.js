"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  USAGE: () => USAGE,
  run: () => run,
  settingsFromArgs: () => settingsFromArgs,
  settingsFromInputs: () => settingsFromInputs
});
module.exports = __toCommonJS(main_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// src/diff.ts
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
function cleanPath(raw) {
  let path = raw.trim();
  const tab = path.indexOf("	");
  if (tab !== -1) path = path.slice(0, tab);
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = unquote(path.slice(1, -1));
  }
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}
function unquote(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = text[++i] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = text.slice(i, i + 3);
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (next === "n") bytes.push(10);
    else if (next === "t") bytes.push(9);
    else for (const b of Buffer.from(next, "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}
function pathsFromGitHeader(rest) {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) {
    const a = cleanPath(quoted[1]);
    const b = cleanPath(quoted[2]);
    if (a && b) return [a, b];
  }
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const a = cleanPath(rest.slice(0, mid));
    const b = cleanPath(rest.slice(mid + 1));
    if (a && b && a === b) return [a, b];
  }
  return null;
}
function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const startFile = (oldPath, path) => {
    const next = { path, oldPath, status: "modified", binary: false, hunks: [] };
    files.push(next);
    hunk = null;
    return next;
  };
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const inHunk = hunk !== null && (oldRemaining > 0 || newRemaining > 0);
    if (inHunk && hunk) {
      const marker = line[0];
      if (marker === "+") {
        hunk.lines.push({ kind: "add", content: line.slice(1), newLine: newLine++ });
        newRemaining--;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ kind: "del", content: line.slice(1), oldLine: oldLine++ });
        oldRemaining--;
        continue;
      }
      if (marker === " " || line === "") {
        hunk.lines.push({
          kind: "context",
          content: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++
        });
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (marker === "\\") continue;
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith("diff --git ")) {
      const paths = pathsFromGitHeader(line.slice("diff --git ".length));
      file = startFile(paths?.[0] ?? "", paths?.[1] ?? "");
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("--- ")) {
      if (!file || file.hunks.length > 0) file = startFile("", "");
      const path = cleanPath(line.slice(4));
      if (path === null) file.status = "added";
      else file.oldPath = path;
      continue;
    }
    if (line.startsWith("+++ ") && file) {
      const path = cleanPath(line.slice(4));
      if (path === null) {
        file.status = "deleted";
        file.path = file.oldPath;
      } else {
        file.path = path;
        if (file.status === "added") file.oldPath = path;
      }
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = cleanPath(line.slice("rename from ".length)) ?? file.oldPath;
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = cleanPath(line.slice("rename to ".length)) ?? file.path;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else {
      const header = line.match(HUNK_HEADER);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[3]);
        oldRemaining = header[2] === void 0 ? 1 : Number(header[2]);
        newRemaining = header[4] === void 0 ? 1 : Number(header[4]);
        hunk = {
          oldStart: oldLine,
          oldLines: oldRemaining,
          newStart: newLine,
          newLines: newRemaining,
          section: header[5] ?? "",
          lines: []
        };
        file.hunks.push(hunk);
      }
    }
  }
  return files.filter((f) => f.path !== "");
}
function addedLines(file) {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add"));
}
function addedLineIndex(files) {
  const index = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (file.status === "deleted" || file.binary) continue;
    for (const line of addedLines(file)) index.add(`${file.path}:${line.newLine}`);
  }
  return index;
}
function isCommentableRange(files, path, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) return false;
  const file = files.find((f) => f.path === path && f.status !== "deleted" && !f.binary);
  if (!file) return false;
  return file.hunks.some((hunk) => {
    const newSide = hunk.lines.filter((l) => l.kind !== "del");
    const first = newSide.find((l) => l.newLine === start);
    const last = newSide.find((l) => l.newLine === end);
    return first !== void 0 && last !== void 0 && last.kind === "add";
  });
}

// src/github.ts
var GitHubApiError = class extends Error {
  constructor(status, action, detail) {
    super(`GitHub API ${action} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.name = "GitHubApiError";
  }
};
function createRestClient(options) {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  async function call(action, method, path, accept, body) {
    const headers = {
      accept,
      authorization: `Bearer ${options.token}`,
      "user-agent": "ai-pr-reviewer-action",
      "x-github-api-version": "2022-11-28"
    };
    if (body !== void 0) headers["content-type"] = "application/json";
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        detail = String(JSON.parse(text).message ?? "");
      } catch {
      }
      throw new GitHubApiError(response.status, action, detail);
    }
    return text;
  }
  const base = (pr) => `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
  return {
    getPullRequestDiff(pr) {
      return call("fetching the pull request diff", "GET", base(pr), "application/vnd.github.diff");
    },
    async listReviewComments(pr) {
      const comments = [];
      const perPage = 100;
      for (let page = 1; page <= 20; page++) {
        const text = await call(
          "listing review comments",
          "GET",
          `${base(pr)}/comments?per_page=${perPage}&page=${page}`,
          "application/vnd.github+json"
        );
        const batch = JSON.parse(text);
        for (const item of batch) {
          comments.push({ path: item.path ?? "", line: item.line ?? null, body: item.body ?? "" });
        }
        if (batch.length < perPage) break;
      }
      return comments;
    },
    async createReview(pr, review) {
      await call("creating the review", "POST", `${base(pr)}/reviews`, "application/vnd.github+json", {
        commit_id: review.commitId,
        event: "COMMENT",
        body: review.body,
        comments: review.comments.map(
          (c) => c.startLine === void 0 ? { path: c.path, line: c.line, side: "RIGHT", body: c.body } : {
            path: c.path,
            start_line: c.startLine,
            start_side: "RIGHT",
            line: c.line,
            side: "RIGHT",
            body: c.body
          }
        )
      });
    }
  };
}

// src/rules.ts
var RuleError = class extends Error {
  constructor(message, line) {
    super(`.ai-review.md line ${line}: ${message}`);
    this.line = line;
    this.name = "RuleError";
  }
};
var SETTING = /^\s*[-*]\s+([A-Za-z-]+)\s*:\s*(.*)$/;
var KNOWN_KEYS = /* @__PURE__ */ new Set([
  "paths",
  "exclude",
  "pattern",
  "ignore-case",
  "replace",
  "message",
  "confidence"
]);
function splitList(value) {
  return value.split(",").map((item) => item.trim().replace(/^`(.*)`$/, "$1")).filter((item) => item.length > 0);
}
function stripCode(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function finish(draft) {
  const get = (key2) => draft.settings.get(key2);
  const rule = {
    name: draft.name,
    description: draft.prose.join("\n").trim(),
    paths: splitList(get("paths")?.value ?? ""),
    exclude: splitList(get("exclude")?.value ?? ""),
    confidence: 1,
    line: draft.line
  };
  const confidence = get("confidence");
  if (confidence) {
    const value = Number(confidence.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RuleError(
        `confidence must be a number between 0 and 1, got "${confidence.value}"`,
        confidence.line
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
      throw new RuleError(`invalid pattern: ${err.message}`, pattern.line);
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
function parseRules(markdown) {
  const rules = [];
  let draft = null;
  let fence = null;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((text, index) => {
    const lineNo = index + 1;
    const fenceMatch = text.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
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
      draft = { name: heading[1], line: lineNo, settings: /* @__PURE__ */ new Map(), prose: [] };
      return;
    }
    if (/^#\s/.test(text)) {
      if (draft) rules.push(finish(draft));
      draft = null;
      return;
    }
    if (!draft) return;
    const setting = text.match(SETTING);
    if (setting) {
      const key2 = setting[1].toLowerCase();
      if (KNOWN_KEYS.has(key2)) {
        if (draft.settings.has(key2)) {
          throw new RuleError(`"${key2}" is set twice in rule "${draft.name}"`, lineNo);
        }
        draft.settings.set(key2, { value: setting[2], line: lineNo });
        return;
      }
    }
    draft.prose.push(text);
  });
  if (draft) rules.push(finish(draft));
  const seen = /* @__PURE__ */ new Set();
  for (const rule of rules) {
    if (seen.has(rule.name)) {
      throw new RuleError(`duplicate rule name "${rule.name}"`, rule.line);
    }
    seen.add(rule.name);
  }
  return rules;
}
function globToRegExp(glob) {
  let pattern = glob.trim().replace(/^\.\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        if (atSegmentStart && pattern[i + 2] === "/") {
          out += "(?:.*/)?";
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
function ruleApplies(rule, path) {
  const matches = (globs) => globs.some((g) => globToRegExp(g).test(path));
  if (rule.exclude.length > 0 && matches(rule.exclude)) return false;
  return rule.paths.length === 0 || matches(rule.paths);
}

// src/model.ts
var SYSTEM_PROMPT = [
  "You are a code reviewer. Review the pull request diff strictly against the numbered rules.",
  "Report only clear violations on added lines (marked with +). Do not report style opinions",
  "or anything the rules do not cover. Each line is prefixed with its line number in the new file.",
  'Reply with JSON only, in this shape: {"findings": [{"rule": "<rule name>", "path": "<file path>",',
  '"line": <new line number>, "message": "<one or two sentences>", "confidence": <0 to 1>,',
  '"suggestion": "<optional full replacement for that line>"}]}.',
  'When a violation spans several lines, add "start_line": <first new line number> and make "line"',
  "the last added line of the violation; both must be in the same hunk, and a suggestion then",
  "replaces every line from start_line to line.",
  'If nothing violates the rules reply with {"findings": []}.'
].join(" ");
function validateEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`model-endpoint is not a valid URL: ${endpoint}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("model-endpoint must use https (http is allowed only for localhost)");
  }
  return url;
}
function renderDiffForModel(files, maxChars) {
  let text = "";
  const omittedFiles = [];
  for (const file of files) {
    if (file.binary || file.status === "deleted" || file.hunks.length === 0) continue;
    let block = `### ${file.path}
`;
    for (const hunk of file.hunks) {
      block += `@@ new lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines - 1, 0)} @@
`;
      for (const line of hunk.lines) {
        if (line.kind === "del") block += `      - ${line.content}
`;
        else {
          const marker = line.kind === "add" ? "+" : " ";
          block += `${String(line.newLine).padStart(5)} ${marker} ${line.content}
`;
        }
      }
    }
    if (text.length + block.length > maxChars) omittedFiles.push(file.path);
    else text += `${block}
`;
  }
  return { text, omittedFiles };
}
function renderRules(rules) {
  return rules.map((rule, i) => {
    const scope = rule.paths.length > 0 ? ` (applies to: ${rule.paths.join(", ")})` : "";
    const except = rule.exclude.length > 0 ? ` (except: ${rule.exclude.join(", ")})` : "";
    const body = rule.description || rule.message || "";
    return `${i + 1}. ${rule.name}${scope}${except}
${body}`.trim();
  }).join("\n\n");
}
function extractJson(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : reply).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("model reply did not contain JSON");
  }
}
function parseModelFindings(reply, request) {
  const parsed = extractJson(reply);
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) throw new Error('model reply has no "findings" array');
  const rulesByName = new Map(request.rules.map((r) => [r.name.toLowerCase(), r]));
  const added = addedLineIndex(request.files);
  const findings = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item;
    const rule = typeof raw.rule === "string" ? rulesByName.get(raw.rule.toLowerCase()) : void 0;
    const path = typeof raw.path === "string" ? raw.path : "";
    const line = Number(raw.line);
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    const confidence = Number(raw.confidence);
    if (!rule || !message || !Number.isInteger(line)) continue;
    if (!Number.isFinite(confidence)) continue;
    if (!added.has(`${path}:${line}`) || !ruleApplies(rule, path)) continue;
    const finding = {
      rule: rule.name,
      path,
      line,
      message,
      confidence: Math.min(1, Math.max(0, confidence)),
      source: "model"
    };
    if (typeof raw.suggestion === "string" && raw.suggestion.trim() !== "") {
      finding.suggestion = raw.suggestion.replace(/\r?\n$/, "");
    }
    const rawStart = raw.start_line ?? raw.startLine;
    if (rawStart !== void 0 && rawStart !== null && Number(rawStart) !== line) {
      const start = Number(rawStart);
      if (isCommentableRange(request.files, path, start, line)) {
        finding.startLine = start;
      } else {
        delete finding.suggestion;
      }
    }
    findings.push(finding);
  }
  return findings;
}
function createHttpReviewer(options) {
  const url = validateEndpoint(options.endpoint);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 6e4;
  const maxDiffChars = options.maxDiffChars ?? 6e4;
  return {
    async review(request) {
      const rules = request.rules.filter((r) => r.description || r.message);
      const { text, omittedFiles } = renderDiffForModel(request.files, maxDiffChars);
      if (rules.length === 0 || text === "") return [];
      const body = {
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Rules:

${renderRules(rules)}

Diff:

${text}` }
        ]
      };
      if (options.model) body.model = options.model;
      const headers = { "content-type": "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await doFetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`model endpoint returned HTTP ${response.status}`);
      }
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error("model endpoint did not return JSON");
      }
      const content = payload.choices?.[0]?.message?.content;
      const reply = typeof content === "string" ? content : responseText;
      const findings = parseModelFindings(reply, { rules, files: request.files });
      if (omittedFiles.length > 0) {
        console.log(
          `Model review skipped ${omittedFiles.length} file(s) that did not fit in the request: ` + omittedFiles.join(", ")
        );
      }
      return findings;
    }
  };
}

// src/checks.ts
function runRuleChecks(files, rules) {
  const findings = [];
  const patternRules = rules.filter((rule) => rule.pattern !== void 0);
  for (const file of files) {
    if (file.binary || file.status === "deleted") continue;
    const applicable = patternRules.filter((rule) => ruleApplies(rule, file.path));
    if (applicable.length === 0) continue;
    for (const line of addedLines(file)) {
      for (const rule of applicable) {
        const pattern = rule.pattern;
        if (!pattern.test(line.content)) continue;
        const finding = {
          rule: rule.name,
          path: file.path,
          line: line.newLine,
          message: rule.message ?? (rule.description || `Matches the rule "${rule.name}".`),
          confidence: rule.confidence,
          source: "rule"
        };
        if (rule.replace !== void 0) {
          const everyMatch = new RegExp(pattern.source, `${pattern.flags}g`);
          const fixed = line.content.replace(everyMatch, rule.replace);
          if (fixed !== line.content) finding.suggestion = fixed;
        }
        findings.push(finding);
      }
    }
  }
  return findings;
}

// src/review.ts
var key = (f) => `${f.path}:${f.line}:${f.rule.toLowerCase()}`;
async function reviewDiff(options) {
  const all = runRuleChecks(options.files, options.rules);
  let modelError;
  if (options.reviewer) {
    try {
      const seen = new Set(all.map(key));
      const fromModel = await options.reviewer.review({
        rules: options.rules,
        files: options.files
      });
      for (const finding of fromModel) {
        if (seen.has(key(finding))) continue;
        seen.add(key(finding));
        all.push(finding);
      }
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
    }
  }
  all.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  const result = {
    findings: all.filter((f) => f.confidence >= options.threshold),
    belowThreshold: all.filter((f) => f.confidence < options.threshold)
  };
  if (modelError !== void 0) result.modelError = modelError;
  return result;
}
function commentMarker(finding) {
  const rule = finding.rule.replace(/--+/g, "-").replace(/[<>]/g, "");
  return `<!-- ai-pr-reviewer rule="${rule}" -->`;
}
function formatComment(finding) {
  const percent = Math.round(finding.confidence * 100);
  const origin = finding.source === "model" ? "model review" : "rule check";
  const parts = [`**${finding.rule}** (${origin}, confidence ${percent}%)`, finding.message];
  if (finding.suggestion !== void 0) {
    const fence = finding.suggestion.includes("```") ? "````" : "```";
    parts.push(`${fence}suggestion
${finding.suggestion}
${fence}`);
  }
  parts.push(commentMarker(finding));
  return parts.join("\n\n");
}
async function postReview(client, pr, commitId, findings, maxComments) {
  const result = { posted: 0, duplicates: 0, overLimit: 0 };
  if (findings.length === 0) return result;
  const existing = await client.listReviewComments(pr);
  const already = (f) => existing.some((c) => c.path === f.path && c.line === f.line && c.body.includes(commentMarker(f)));
  const fresh = findings.filter((f) => !already(f));
  result.duplicates = findings.length - fresh.length;
  const chosen = [...fresh].sort((a, b) => b.confidence - a.confidence).slice(0, maxComments);
  result.overLimit = fresh.length - chosen.length;
  if (chosen.length === 0) return result;
  const comments = chosen.map((f) => {
    const comment = { path: f.path, line: f.line, body: formatComment(f) };
    if (f.startLine !== void 0) comment.startLine = f.startLine;
    return comment;
  });
  const noun = comments.length === 1 ? "finding" : "findings";
  let body = `Automated review against \`.ai-review.md\`: ${comments.length} ${noun}.`;
  if (result.overLimit > 0) {
    body += ` ${result.overLimit} more not shown (comment limit reached).`;
  }
  await client.createReview(pr, { commitId, body, comments });
  result.posted = comments.length;
  return result;
}
function findingLocation(f) {
  return f.startLine === void 0 ? `${f.path}:${f.line}` : `${f.path}:${f.startLine}-${f.line}`;
}
function formatReport(result, threshold) {
  const lines = [];
  for (const f of result.findings) {
    lines.push(`${findingLocation(f)}  [${f.rule}]  confidence ${f.confidence.toFixed(2)}  (${f.source})`);
    lines.push(`    ${f.message.split("\n").join("\n    ")}`);
    if (f.suggestion !== void 0) {
      lines.push(`    suggested fix: ${f.suggestion.trim().split("\n").join("\n                   ")}`);
    }
  }
  const count = result.findings.length;
  lines.push(
    `${count} finding${count === 1 ? "" : "s"} at or above confidence ${threshold.toFixed(2)}` + (result.belowThreshold.length > 0 ? `, ${result.belowThreshold.length} below the threshold not shown` : "")
  );
  if (result.modelError !== void 0) {
    lines.push(`model review failed and was skipped: ${result.modelError}`);
  }
  return lines.join("\n");
}

// src/main.ts
function parseNumber(name, value, min, max) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}
var isTrue = (value) => /^(true|yes|on|1)$/i.test(value.trim());
function settingsFromInputs(env) {
  const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;
  return {
    rulesPath: input("rules", ".ai-review.md"),
    threshold: parseNumber("confidence-threshold", input("confidence-threshold", "0.8"), 0, 1),
    maxComments: Math.floor(parseNumber("max-comments", input("max-comments", "20"), 1, 100)),
    diffFile: input("diff-file"),
    dryRun: isTrue(input("dry-run", "false")),
    failOnFindings: isTrue(input("fail-on-findings", "false")),
    json: false,
    githubToken: input("github-token"),
    modelEndpoint: input("model-endpoint"),
    modelApiKey: input("model-api-key"),
    modelName: input("model-name")
  };
}
var USAGE = `Usage: node dist/index.js --diff <file|-> [options]

Reviews a unified diff against the rules in .ai-review.md and prints the
findings. Nothing is posted anywhere in this mode.

Options:
  --diff <file>             unified diff to review, "-" for standard input
  --rules <file>            rules file (default: .ai-review.md)
  --threshold <0..1>        minimum confidence to report (default: 0.8)
  --json                    print findings as JSON
  --fail-on-findings        exit with status 1 when there are findings
  --model-endpoint <url>    also ask a model at this HTTP endpoint
  --model-name <name>       model name sent in the request
  --help                    show this help

The model API key, if the endpoint needs one, is read from the
AI_REVIEW_MODEL_API_KEY environment variable.`;
function settingsFromArgs(argv, env) {
  const settings = {
    rulesPath: ".ai-review.md",
    threshold: 0.8,
    maxComments: 20,
    diffFile: "",
    dryRun: true,
    failOnFindings: false,
    json: false,
    githubToken: "",
    modelEndpoint: "",
    modelApiKey: env.AI_REVIEW_MODEL_API_KEY ?? "",
    modelName: ""
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === void 0) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--diff") settings.diffFile = value();
    else if (arg === "--rules") settings.rulesPath = value();
    else if (arg === "--threshold") settings.threshold = parseNumber("--threshold", value(), 0, 1);
    else if (arg === "--json") settings.json = true;
    else if (arg === "--fail-on-findings") settings.failOnFindings = true;
    else if (arg === "--model-endpoint") settings.modelEndpoint = value();
    else if (arg === "--model-name") settings.modelName = value();
    else throw new Error(`unknown option ${arg}`);
  }
  if (settings.diffFile === "") throw new Error("--diff is required");
  return settings;
}
function loadRules(path) {
  let text;
  try {
    text = (0, import_node_fs.readFileSync)(path, "utf8");
  } catch {
    throw new Error(`rules file not found: ${path}`);
  }
  const rules = parseRules(text);
  if (rules.length === 0) {
    throw new Error(`${path} has no rules (each rule starts with a "## " heading)`);
  }
  return rules;
}
function buildReviewer(settings) {
  if (settings.modelEndpoint === "") return void 0;
  return createHttpReviewer({
    endpoint: settings.modelEndpoint,
    apiKey: settings.modelApiKey || void 0,
    model: settings.modelName || void 0
  });
}
async function run(deps) {
  const { env, argv, log } = deps;
  const inActions = env.GITHUB_ACTIONS === "true";
  const cli = argv.length > 0 || !inActions;
  if (cli && (argv.length === 0 || argv.includes("--help") || argv.includes("-h"))) {
    log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const settings = cli ? settingsFromArgs(argv, env) : settingsFromInputs(env);
  if (settings.modelApiKey !== "" && inActions) log(`::add-mask::${settings.modelApiKey}`);
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const rules = loadRules((0, import_node_path.resolve)(workspace, settings.rulesPath));
  const reviewer = deps.reviewer ?? buildReviewer(settings);
  let diffText;
  let target = null;
  let github;
  if (settings.diffFile !== "") {
    diffText = settings.diffFile === "-" ? (deps.readStdin ?? (() => (0, import_node_fs.readFileSync)(0, "utf8")))() : (0, import_node_fs.readFileSync)((0, import_node_path.resolve)(workspace, settings.diffFile), "utf8");
  } else {
    const event = JSON.parse(
      env.GITHUB_EVENT_PATH ? (0, import_node_fs.readFileSync)(env.GITHUB_EVENT_PATH, "utf8") : "{}"
    );
    const number = event.pull_request?.number;
    const sha = event.pull_request?.head?.sha;
    const owner = event.repository?.owner?.login;
    const repo = event.repository?.name;
    if (!number || !sha || !owner || !repo) {
      log("This run was not triggered by a pull request event; nothing to review.");
      setOutputs(env, 0, 0);
      return 0;
    }
    if (settings.githubToken === "" && !deps.github) {
      throw new Error("github-token is empty; it is needed to read the pull request diff");
    }
    github = deps.github ?? createRestClient({ token: settings.githubToken, apiUrl: env.GITHUB_API_URL || void 0 });
    target = { pr: { owner, repo, number }, sha };
    diffText = await github.getPullRequestDiff(target.pr);
  }
  const files = parseDiff(diffText);
  const result = await reviewDiff({ files, rules, threshold: settings.threshold, reviewer });
  if (settings.json) {
    log(JSON.stringify({ findings: result.findings, belowThreshold: result.belowThreshold.length }, null, 2));
  } else {
    log(formatReport(result, settings.threshold));
  }
  if (result.modelError !== void 0 && inActions) {
    log(`::warning::Model review failed and was skipped: ${result.modelError}`);
  }
  let posted = 0;
  if (target && github && !settings.dryRun) {
    try {
      const outcome = await postReview(github, target.pr, target.sha, result.findings, settings.maxComments);
      posted = outcome.posted;
      log(
        `Posted ${outcome.posted} comment(s); ${outcome.duplicates} already posted earlier, ${outcome.overLimit} over the max-comments limit.`
      );
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
        log(
          `::warning::Could not post review comments (${err.message}). The workflow needs \`pull-requests: write\` permission.`
        );
      } else {
        throw err;
      }
    }
  } else if (!cli) {
    log("Dry run: no comments were posted.");
  }
  if (!cli) {
    setOutputs(env, result.findings.length, posted);
    writeSummary(env, result, settings.threshold);
  }
  return settings.failOnFindings && result.findings.length > 0 ? 1 : 0;
}
function setOutputs(env, findings, posted) {
  if (!env.GITHUB_OUTPUT) return;
  (0, import_node_fs.appendFileSync)(env.GITHUB_OUTPUT, `findings-count=${findings}
comments-posted=${posted}
`);
}
function writeSummary(env, result, threshold) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const cell = (text) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const rows = result.findings.map(
    (f) => `| \`${findingLocation(f)}\` | ${cell(f.rule)} | ${f.confidence.toFixed(2)} | ${cell(f.message)} |`
  );
  const summary = [
    "### Rule review",
    "",
    `${result.findings.length} finding(s) at or above confidence ${threshold.toFixed(2)}; ${result.belowThreshold.length} below the threshold.`,
    "",
    ...rows.length > 0 ? ["| Location | Rule | Confidence | Message |", "| --- | --- | --- | --- |", ...rows, ""] : []
  ];
  (0, import_node_fs.appendFileSync)(env.GITHUB_STEP_SUMMARY, summary.join("\n"));
}
if (require.main === module) {
  run({ env: process.env, argv: process.argv.slice(2), log: (line) => console.log(line) }).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::error::${message}`);
    else console.error(`error: ${message}`);
    process.exitCode = 1;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  USAGE,
  run,
  settingsFromArgs,
  settingsFromInputs
});
