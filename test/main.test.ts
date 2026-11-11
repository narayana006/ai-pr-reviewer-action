import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitHubApiError } from "../src/github";
import { run, settingsFromInputs } from "../src/main";
import { FakeGitHub, fixture, FIXTURES } from "./helpers";

function actionEnv(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-test-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  return {
    output,
    summary,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: FIXTURES,
      GITHUB_EVENT_PATH: join(FIXTURES, "pull_request_event.json"),
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_RULES: "rules.md",
      "INPUT_GITHUB-TOKEN": "fake-token",
      ...extra,
    } as Record<string, string>,
  };
}

function collect() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

test("reads inputs with defaults and validates numbers", () => {
  const defaults = settingsFromInputs({});
  assert.equal(defaults.rulesPath, ".ai-review.md");
  assert.equal(defaults.threshold, 0.8);
  assert.equal(defaults.maxComments, 20);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.modelEndpoint, "");

  const custom = settingsFromInputs({
    "INPUT_CONFIDENCE-THRESHOLD": "0.5",
    "INPUT_MAX-COMMENTS": "3",
    "INPUT_DRY-RUN": "TRUE",
  });
  assert.equal(custom.threshold, 0.5);
  assert.equal(custom.maxComments, 3);
  assert.equal(custom.dryRun, true);
  assert.throws(() => settingsFromInputs({ "INPUT_CONFIDENCE-THRESHOLD": "80%" }), /between 0 and 1/);
});

test("on a pull request event it posts a review through the GitHub client", async () => {
  const { env, output, summary } = actionEnv();
  const github = new FakeGitHub(fixture("sample.diff"));
  const { log, lines } = collect();
  const code = await run({ env, argv: [], log, github });

  assert.equal(code, 0);
  assert.equal(github.reviews.length, 1);
  assert.deepEqual(github.reviews[0]!.pr, { owner: "example-org", repo: "shop-service", number: 7 });
  assert.equal(github.reviews[0]!.commitId, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(github.reviews[0]!.comments.length, 4);
  assert.equal(readFileSync(output, "utf8"), "findings-count=4\ncomments-posted=4\n");
  assert.match(readFileSync(summary, "utf8"), /`docs\/setup\.md:3` \| Use the HTTPS API host \| 1\.00/);
  assert.ok(lines.some((l) => l.startsWith("Posted 4 comment(s)")));
});

test("dry-run and diff-file never post", async () => {
  const dry = actionEnv({ "INPUT_DRY-RUN": "true" });
  const github = new FakeGitHub(fixture("sample.diff"));
  await run({ env: dry.env, argv: [], log: collect().log, github });
  assert.equal(github.reviews.length, 0);
  assert.equal(readFileSync(dry.output, "utf8"), "findings-count=4\ncomments-posted=0\n");

  const fromFile = actionEnv({ "INPUT_DIFF-FILE": "sample.diff" });
  const untouched = new FakeGitHub("");
  untouched.getPullRequestDiff = async () => {
    throw new Error("should not be called");
  };
  const { log, lines } = collect();
  await run({ env: fromFile.env, argv: [], log, github: untouched });
  assert.equal(untouched.reviews.length, 0);
  assert.ok(lines.includes("Dry run: no comments were posted."));
});

test("does nothing on events that are not pull requests", async () => {
  const { env, output } = actionEnv();
  const dir = mkdtempSync(join(tmpdir(), "ai-review-event-"));
  env.GITHUB_EVENT_PATH = join(dir, "event.json");
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ ref: "refs/heads/main" }));
  const github = new FakeGitHub(fixture("sample.diff"));
  const { log, lines } = collect();
  assert.equal(await run({ env, argv: [], log, github }), 0);
  assert.equal(github.reviews.length, 0);
  assert.match(lines.join("\n"), /not triggered by a pull request/);
  assert.equal(readFileSync(output, "utf8"), "findings-count=0\ncomments-posted=0\n");
});

test("fail-on-findings sets the exit code; a read-only token only warns", async () => {
  const { env } = actionEnv({ "INPUT_FAIL-ON-FINDINGS": "true" });
  const github = new FakeGitHub(fixture("sample.diff"));
  github.failCreateWith = new GitHubApiError(403, "creating the review", "Resource not accessible by integration");
  const { log, lines } = collect();
  assert.equal(await run({ env, argv: [], log, github }), 1);
  assert.ok(lines.some((l) => l.startsWith("::warning::Could not post review comments")));
});

test("uses the model reviewer when one is supplied and masks the key", async () => {
  const { env } = actionEnv({ "INPUT_MODEL-API-KEY": "fake-model-key", "INPUT_DRY-RUN": "true" });
  const github = new FakeGitHub(fixture("sample.diff"));
  const { log, lines } = collect();
  await run({
    env,
    argv: [],
    log,
    github,
    reviewer: {
      review: async () => [
        {
          rule: "Money is never a float",
          path: "src/billing/invoice.ts",
          line: 17,
          message: "Float arithmetic on money.",
          confidence: 0.9,
          source: "model",
        },
      ],
    },
  });
  assert.equal(lines[0], "::add-mask::fake-model-key");
  assert.match(lines.join("\n"), /invoice\.ts:17 {2}\[Money is never a float\] {2}confidence 0\.90 {2}\(model\)/);
});

test("command line mode prints findings, supports JSON and stdin, and never posts", async () => {
  const rulesPath = join(FIXTURES, "rules.md");
  const text = collect();
  const code = await run({
    env: {},
    argv: ["--diff", join(FIXTURES, "sample.diff"), "--rules", rulesPath, "--fail-on-findings"],
    log: text.log,
  });
  assert.equal(code, 1);
  assert.match(text.lines.join("\n"), /4 findings at or above confidence 0\.80, 1 below the threshold not shown/);

  const json = collect();
  await run({
    env: {},
    argv: ["--diff", "-", "--rules", rulesPath, "--threshold", "0.5", "--json"],
    log: json.log,
    readStdin: () => fixture("sample.diff"),
  });
  const parsed = JSON.parse(json.lines.join("\n")) as { findings: unknown[]; belowThreshold: number };
  assert.equal(parsed.findings.length, 5);
  assert.equal(parsed.belowThreshold, 0);
});

test("command line mistakes are reported", async () => {
  const { log } = collect();
  await assert.rejects(run({ env: {}, argv: ["--nope"], log }), /unknown option --nope/);
  await assert.rejects(run({ env: {}, argv: ["--rules", "x"], log }), /--diff is required/);
  await assert.rejects(
    run({ env: {}, argv: ["--diff", join(FIXTURES, "sample.diff"), "--rules", "/nonexistent/rules.md"], log }),
    /rules file not found/,
  );
  const help = collect();
  assert.equal(await run({ env: {}, argv: ["--help"], log: help.log }), 0);
  assert.match(help.lines[0]!, /^Usage:/);
});
