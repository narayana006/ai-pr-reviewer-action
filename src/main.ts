/**
 * Entry point. Runs in two ways:
 *
 *  - as a GitHub Action (inputs arrive as INPUT_* environment variables), where
 *    it fetches the pull request diff and posts one review with inline comments;
 *  - from a terminal (`node dist/index.js --diff changes.diff`), where it only
 *    prints what it found.
 *
 * Comments are posted only when running inside GitHub Actions on a pull
 * request event, with no `diff-file` and with `dry-run` off.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDiff } from "./diff";
import { createRestClient, GitHubApiError, type GitHubClient } from "./github";
import { createHttpReviewer, type ModelReviewer } from "./model";
import { findingLocation, formatReport, postReview, reviewDiff, type ReviewResult } from "./review";
import { parseRules, type Rule } from "./rules";

export interface Settings {
  rulesPath: string;
  threshold: number;
  maxComments: number;
  diffFile: string;
  dryRun: boolean;
  failOnFindings: boolean;
  json: boolean;
  githubToken: string;
  modelEndpoint: string;
  modelApiKey: string;
  modelName: string;
}

type Env = Record<string, string | undefined>;

function parseNumber(name: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}

const isTrue = (value: string) => /^(true|yes|on|1)$/i.test(value.trim());

/** Reads action inputs. GitHub exposes input `foo-bar` as `INPUT_FOO-BAR`. */
export function settingsFromInputs(env: Env): Settings {
  const input = (name: string, fallback = "") =>
    (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;
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
    modelName: input("model-name"),
  };
}

export const USAGE = `Usage: node dist/index.js --diff <file|-> [options]

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

export function settingsFromArgs(argv: string[], env: Env): Settings {
  const settings: Settings = {
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
    modelName: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
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

function loadRules(path: string): Rule[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`rules file not found: ${path}`);
  }
  const rules = parseRules(text);
  if (rules.length === 0) {
    throw new Error(`${path} has no rules (each rule starts with a "## " heading)`);
  }
  return rules;
}

function buildReviewer(settings: Settings): ModelReviewer | undefined {
  if (settings.modelEndpoint === "") return undefined;
  return createHttpReviewer({
    endpoint: settings.modelEndpoint,
    apiKey: settings.modelApiKey || undefined,
    model: settings.modelName || undefined,
  });
}

interface PullRequestEvent {
  pull_request?: { number?: number; head?: { sha?: string } };
  repository?: { name?: string; owner?: { login?: string } };
}

export interface RunDeps {
  env: Env;
  argv: string[];
  log: (line: string) => void;
  /** Overrides for tests; the real ones are built from settings. */
  github?: GitHubClient;
  reviewer?: ModelReviewer;
  readStdin?: () => string;
}

/** Runs one review and returns the process exit code. */
export async function run(deps: RunDeps): Promise<number> {
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
  const rules = loadRules(resolve(workspace, settings.rulesPath));
  const reviewer = deps.reviewer ?? buildReviewer(settings);

  let diffText: string;
  let target: { pr: { owner: string; repo: string; number: number }; sha: string } | null = null;
  let github: GitHubClient | undefined;

  if (settings.diffFile !== "") {
    diffText =
      settings.diffFile === "-"
        ? (deps.readStdin ?? (() => readFileSync(0, "utf8")))()
        : readFileSync(resolve(workspace, settings.diffFile), "utf8");
  } else {
    const event = JSON.parse(
      env.GITHUB_EVENT_PATH ? readFileSync(env.GITHUB_EVENT_PATH, "utf8") : "{}",
    ) as PullRequestEvent;
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
    github =
      deps.github ??
      createRestClient({ token: settings.githubToken, apiUrl: env.GITHUB_API_URL || undefined });
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
  if (result.modelError !== undefined && inActions) {
    log(`::warning::Model review failed and was skipped: ${result.modelError}`);
  }

  let posted = 0;
  if (target && github && !settings.dryRun) {
    try {
      const outcome = await postReview(github, target.pr, target.sha, result.findings, settings.maxComments);
      posted = outcome.posted;
      log(
        `Posted ${outcome.posted} comment(s); ${outcome.duplicates} already posted earlier, ` +
          `${outcome.overLimit} over the max-comments limit.`,
      );
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
        // Typical for pull requests from forks, where the token is read-only.
        log(
          `::warning::Could not post review comments (${err.message}). ` +
            "The workflow needs `pull-requests: write` permission.",
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

function setOutputs(env: Env, findings: number, posted: number): void {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, `findings-count=${findings}\ncomments-posted=${posted}\n`);
}

function writeSummary(env: Env, result: ReviewResult, threshold: number): void {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const rows = result.findings.map(
    (f) => `| \`${findingLocation(f)}\` | ${cell(f.rule)} | ${f.confidence.toFixed(2)} | ${cell(f.message)} |`,
  );
  const summary = [
    "### Rule review",
    "",
    `${result.findings.length} finding(s) at or above confidence ${threshold.toFixed(2)}; ` +
      `${result.belowThreshold.length} below the threshold.`,
    "",
    ...(rows.length > 0 ? ["| Location | Rule | Confidence | Message |", "| --- | --- | --- | --- |", ...rows, ""] : []),
  ];
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join("\n"));
}

if (require.main === module) {
  run({ env: process.env, argv: process.argv.slice(2), log: (line) => console.log(line) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (process.env.GITHUB_ACTIONS === "true") console.log(`::error::${message}`);
      else console.error(`error: ${message}`);
      process.exitCode = 1;
    });
}
