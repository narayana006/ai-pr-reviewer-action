/**
 * Optional model reviewer.
 *
 * The action talks to a model through one small interface, `ModelReviewer`.
 * The only implementation shipped here is a plain HTTP client that posts a
 * chat-completions style JSON request to an endpoint the user supplies, so
 * any service that accepts that request shape can be plugged in. Nothing in
 * this file runs unless an endpoint is configured.
 */

import type { Finding } from "./checks";
import { addedLineIndex, type FileDiff } from "./diff";
import { ruleApplies, type Rule } from "./rules";

export interface ReviewRequest {
  rules: Rule[];
  files: FileDiff[];
}

export interface ModelReviewer {
  review(request: ReviewRequest): Promise<Finding[]>;
}

/** The subset of `fetch` this module needs; tests pass a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface HttpReviewerOptions {
  endpoint: string;
  apiKey?: string;
  model?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Upper bound on the diff text sent in one request. */
  maxDiffChars?: number;
}

const SYSTEM_PROMPT = [
  "You are a code reviewer. Review the pull request diff strictly against the numbered rules.",
  "Report only clear violations on added lines (marked with +). Do not report style opinions",
  "or anything the rules do not cover. Each line is prefixed with its line number in the new file.",
  'Reply with JSON only, in this shape: {"findings": [{"rule": "<rule name>", "path": "<file path>",',
  '"line": <new line number>, "message": "<one or two sentences>", "confidence": <0 to 1>,',
  '"suggestion": "<optional full replacement for that line>"}]}.',
  'If nothing violates the rules reply with {"findings": []}.',
].join(" ");

/** Rejects endpoints that would send the key over an unencrypted connection. */
export function validateEndpoint(endpoint: string): URL {
  let url: URL;
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

/** Renders hunks with new-side line numbers, stopping at the size budget. */
export function renderDiffForModel(
  files: FileDiff[],
  maxChars: number,
): { text: string; omittedFiles: string[] } {
  let text = "";
  const omittedFiles: string[] = [];
  for (const file of files) {
    if (file.binary || file.status === "deleted" || file.hunks.length === 0) continue;
    let block = `### ${file.path}\n`;
    for (const hunk of file.hunks) {
      block += `@@ new lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines - 1, 0)} @@\n`;
      for (const line of hunk.lines) {
        if (line.kind === "del") block += `      - ${line.content}\n`;
        else {
          const marker = line.kind === "add" ? "+" : " ";
          block += `${String(line.newLine).padStart(5)} ${marker} ${line.content}\n`;
        }
      }
    }
    if (text.length + block.length > maxChars) omittedFiles.push(file.path);
    else text += `${block}\n`;
  }
  return { text, omittedFiles };
}

function renderRules(rules: Rule[]): string {
  return rules
    .map((rule, i) => {
      const scope = rule.paths.length > 0 ? ` (applies to: ${rule.paths.join(", ")})` : "";
      const except = rule.exclude.length > 0 ? ` (except: ${rule.exclude.join(", ")})` : "";
      const body = rule.description || rule.message || "";
      return `${i + 1}. ${rule.name}${scope}${except}\n${body}`.trim();
    })
    .join("\n\n");
}

/** Pulls the first JSON value out of a reply that may be wrapped in a code fence. */
function extractJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1]! : reply).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("model reply did not contain JSON");
  }
}

/**
 * Validates raw findings from a model reply. Anything that does not name a
 * known rule and an added line of a file that rule covers is dropped: a
 * comment on a line outside the diff cannot be posted, and a finding for an
 * unknown rule is not something the team asked for.
 */
export function parseModelFindings(reply: string, request: ReviewRequest): Finding[] {
  const parsed = extractJson(reply);
  const list: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) throw new Error('model reply has no "findings" array');

  const rulesByName = new Map(request.rules.map((r) => [r.name.toLowerCase(), r]));
  const added = addedLineIndex(request.files);
  const findings: Finding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const rule = typeof raw.rule === "string" ? rulesByName.get(raw.rule.toLowerCase()) : undefined;
    const path = typeof raw.path === "string" ? raw.path : "";
    const line = Number(raw.line);
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    const confidence = Number(raw.confidence);
    if (!rule || !message || !Number.isInteger(line)) continue;
    if (!Number.isFinite(confidence)) continue;
    if (!added.has(`${path}:${line}`) || !ruleApplies(rule, path)) continue;

    const finding: Finding = {
      rule: rule.name,
      path,
      line,
      message,
      confidence: Math.min(1, Math.max(0, confidence)),
      source: "model",
    };
    if (typeof raw.suggestion === "string" && raw.suggestion.trim() !== "") {
      finding.suggestion = raw.suggestion.replace(/\r?\n$/, "");
    }
    findings.push(finding);
  }
  return findings;
}

export function createHttpReviewer(options: HttpReviewerOptions): ModelReviewer {
  const url = validateEndpoint(options.endpoint);
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxDiffChars = options.maxDiffChars ?? 60_000;

  return {
    async review(request) {
      const rules = request.rules.filter((r) => r.description || r.message);
      const { text, omittedFiles } = renderDiffForModel(request.files, maxDiffChars);
      if (rules.length === 0 || text === "") return [];

      const body: Record<string, unknown> = {
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Rules:\n\n${renderRules(rules)}\n\nDiff:\n\n${text}` },
        ],
      };
      if (options.model) body.model = options.model;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

      const response = await doFetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`model endpoint returned HTTP ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error("model endpoint did not return JSON");
      }
      const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
        ?.message?.content;
      // Accept either a chat-completions envelope or the findings object itself.
      const reply = typeof content === "string" ? content : responseText;
      const findings = parseModelFindings(reply, { rules, files: request.files });
      if (omittedFiles.length > 0) {
        console.log(
          `Model review skipped ${omittedFiles.length} file(s) that did not fit in the request: ` +
            omittedFiles.join(", "),
        );
      }
      return findings;
    },
  };
}
