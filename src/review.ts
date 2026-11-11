/** Ties the pieces together: collect findings, filter, format and post. */

import { runRuleChecks, type Finding } from "./checks";
import type { FileDiff } from "./diff";
import type { GitHubClient, PullRequestRef, ReviewComment } from "./github";
import type { ModelReviewer } from "./model";
import type { Rule } from "./rules";

export interface ReviewResult {
  /** Findings at or above the threshold, ordered by file and line. */
  findings: Finding[];
  /** Findings dropped for being below the threshold. */
  belowThreshold: Finding[];
  /** Set when the model reviewer was configured but failed. */
  modelError?: string;
}

export interface ReviewOptions {
  files: FileDiff[];
  rules: Rule[];
  threshold: number;
  reviewer?: ModelReviewer;
}

const key = (f: Finding) => `${f.path}:${f.line}:${f.rule.toLowerCase()}`;

export async function reviewDiff(options: ReviewOptions): Promise<ReviewResult> {
  const all = runRuleChecks(options.files, options.rules);
  let modelError: string | undefined;

  if (options.reviewer) {
    try {
      const seen = new Set(all.map(key));
      const fromModel = await options.reviewer.review({
        rules: options.rules,
        files: options.files,
      });
      // A deterministic match for the same rule and line wins over the model's.
      for (const finding of fromModel) {
        if (seen.has(key(finding))) continue;
        seen.add(key(finding));
        all.push(finding);
      }
    } catch (err) {
      // A failing model must not hide the deterministic findings.
      modelError = err instanceof Error ? err.message : String(err);
    }
  }

  all.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  const result: ReviewResult = {
    findings: all.filter((f) => f.confidence >= options.threshold),
    belowThreshold: all.filter((f) => f.confidence < options.threshold),
  };
  if (modelError !== undefined) result.modelError = modelError;
  return result;
}

/** Hidden marker used to recognise comments this action already posted. */
export function commentMarker(finding: Finding): string {
  const rule = finding.rule.replace(/--+/g, "-").replace(/[<>]/g, "");
  return `<!-- ai-pr-reviewer rule="${rule}" -->`;
}

export function formatComment(finding: Finding): string {
  const percent = Math.round(finding.confidence * 100);
  const origin = finding.source === "model" ? "model review" : "rule check";
  const parts = [`**${finding.rule}** (${origin}, confidence ${percent}%)`, finding.message];
  if (finding.suggestion !== undefined) {
    // A longer fence keeps suggestions containing ``` from breaking out.
    const fence = finding.suggestion.includes("```") ? "````" : "```";
    parts.push(`${fence}suggestion\n${finding.suggestion}\n${fence}`);
  }
  parts.push(commentMarker(finding));
  return parts.join("\n\n");
}

export interface PostResult {
  posted: number;
  /** Already commented on an earlier run. */
  duplicates: number;
  /** Left out because of the max-comments limit. */
  overLimit: number;
}

export async function postReview(
  client: GitHubClient,
  pr: PullRequestRef,
  commitId: string,
  findings: Finding[],
  maxComments: number,
): Promise<PostResult> {
  const result: PostResult = { posted: 0, duplicates: 0, overLimit: 0 };
  if (findings.length === 0) return result;

  const existing = await client.listReviewComments(pr);
  const already = (f: Finding) =>
    existing.some((c) => c.path === f.path && c.line === f.line && c.body.includes(commentMarker(f)));

  const fresh = findings.filter((f) => !already(f));
  result.duplicates = findings.length - fresh.length;
  // Most confident first, so the limit drops the weakest findings.
  const chosen = [...fresh].sort((a, b) => b.confidence - a.confidence).slice(0, maxComments);
  result.overLimit = fresh.length - chosen.length;
  if (chosen.length === 0) return result;

  const comments: ReviewComment[] = chosen.map((f) => ({
    path: f.path,
    line: f.line,
    body: formatComment(f),
  }));
  const noun = comments.length === 1 ? "finding" : "findings";
  let body = `Automated review against \`.ai-review.md\`: ${comments.length} ${noun}.`;
  if (result.overLimit > 0) {
    body += ` ${result.overLimit} more not shown (comment limit reached).`;
  }
  await client.createReview(pr, { commitId, body, comments });
  result.posted = comments.length;
  return result;
}

/** Plain-text report used by the CLI, dry runs and the action log. */
export function formatReport(result: ReviewResult, threshold: number): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    lines.push(`${f.path}:${f.line}  [${f.rule}]  confidence ${f.confidence.toFixed(2)}  (${f.source})`);
    lines.push(`    ${f.message.split("\n").join("\n    ")}`);
    if (f.suggestion !== undefined) lines.push(`    suggested fix: ${f.suggestion.trim()}`);
  }
  const count = result.findings.length;
  lines.push(
    `${count} finding${count === 1 ? "" : "s"} at or above confidence ${threshold.toFixed(2)}` +
      (result.belowThreshold.length > 0
        ? `, ${result.belowThreshold.length} below the threshold not shown`
        : ""),
  );
  if (result.modelError !== undefined) {
    lines.push(`model review failed and was skipped: ${result.modelError}`);
  }
  return lines.join("\n");
}
