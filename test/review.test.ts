import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/checks";
import { parseDiff } from "../src/diff";
import type { ModelReviewer } from "../src/model";
import { commentMarker, formatComment, formatReport, postReview, reviewDiff } from "../src/review";
import { parseRules } from "../src/rules";
import { FakeGitHub, fixture } from "./helpers";

const files = parseDiff(fixture("sample.diff"));
const rules = parseRules(fixture("rules.md"));
const pr = { owner: "example-org", repo: "shop-service", number: 7 };

const modelFinding: Finding = {
  rule: "Money is never a float",
  path: "src/billing/invoice.ts",
  line: 17,
  message: "Dividing unitCents by 100 makes the subtotal a float.",
  confidence: 0.9,
  source: "model",
};
const fakeReviewer = (findings: Finding[]): ModelReviewer => ({ review: async () => findings });

test("the threshold separates reported findings from dropped ones", async () => {
  const strict = await reviewDiff({ files, rules, threshold: 0.9 });
  assert.deepEqual(strict.findings.map((f) => f.line), [3, 16, 18]);
  assert.equal(strict.belowThreshold.length, 2);

  const lenient = await reviewDiff({ files, rules, threshold: 0.5 });
  assert.equal(lenient.findings.length, 5);
  assert.equal(lenient.belowThreshold.length, 0);
});

test("without a reviewer only deterministic findings are produced", async () => {
  const result = await reviewDiff({ files, rules, threshold: 0 });
  assert.ok(result.findings.every((f) => f.source === "rule"));
  assert.equal(result.modelError, undefined);
});

test("model findings are merged, filtered by threshold and never duplicate a rule match", async () => {
  const duplicate: Finding = { ...modelFinding, rule: "No console.log in application code", line: 18 };
  const weak: Finding = { ...modelFinding, line: 16, confidence: 0.4 };
  const result = await reviewDiff({
    files,
    rules,
    threshold: 0.8,
    reviewer: fakeReviewer([modelFinding, duplicate, weak]),
  });
  assert.deepEqual(
    result.findings.map((f) => `${f.line}:${f.source}`),
    ["3:rule", "16:rule", "17:model", "18:rule", "22:rule"],
  );
  assert.equal(result.belowThreshold.length, 2);
});

test("a failing model does not lose the deterministic findings", async () => {
  const reviewer: ModelReviewer = {
    review: async () => {
      throw new Error("model endpoint returned HTTP 503");
    },
  };
  const result = await reviewDiff({ files, rules, threshold: 0.8, reviewer });
  assert.equal(result.findings.length, 4);
  assert.equal(result.modelError, "model endpoint returned HTTP 503");
  assert.match(formatReport(result, 0.8), /model review failed and was skipped/);
});

test("comments carry the rule, confidence, a suggestion block and a marker", () => {
  const body = formatComment({ ...modelFinding, suggestion: "  const subtotal = 1;" });
  assert.match(body, /^\*\*Money is never a float\*\* \(model review, confidence 90%\)/);
  assert.match(body, /```suggestion\n {2}const subtotal = 1;\n```/);
  assert.ok(body.endsWith('<!-- ai-pr-reviewer rule="Money is never a float" -->'));

  const tricky = formatComment({ ...modelFinding, suggestion: "```js" });
  assert.match(tricky, /````suggestion\n```js\n````/);
  assert.equal(commentMarker({ ...modelFinding, rule: "a --> b" }), '<!-- ai-pr-reviewer rule="a - b" -->');
});

test("posts one review with an inline comment per finding", async () => {
  const github = new FakeGitHub(fixture("sample.diff"));
  const { findings } = await reviewDiff({ files, rules, threshold: 0.8 });
  const outcome = await postReview(github, pr, "abc123", findings, 20);

  assert.deepEqual(outcome, { posted: 4, duplicates: 0, overLimit: 0 });
  assert.equal(github.reviews.length, 1);
  const review = github.reviews[0]!;
  assert.equal(review.commitId, "abc123");
  assert.deepEqual(review.pr, pr);
  assert.match(review.body, /4 findings/);
  assert.deepEqual(
    review.comments.map((c) => `${c.path}:${c.line}`).sort(),
    ["docs/setup.md:3", "src/billing/invoice.ts:16", "src/billing/invoice.ts:18", "src/billing/invoice.ts:22"],
  );
});

test("a second run does not repeat comments that are already there", async () => {
  const github = new FakeGitHub(fixture("sample.diff"));
  const { findings } = await reviewDiff({ files, rules, threshold: 0.8 });
  await postReview(github, pr, "abc123", findings, 20);
  const again = await postReview(github, pr, "def456", findings, 20);
  assert.deepEqual(again, { posted: 0, duplicates: 4, overLimit: 0 });
  assert.equal(github.reviews.length, 1);
});

test("max-comments keeps the most confident findings", async () => {
  const github = new FakeGitHub(fixture("sample.diff"));
  const { findings } = await reviewDiff({ files, rules, threshold: 0.5 });
  const outcome = await postReview(github, pr, "abc123", findings, 2);
  assert.deepEqual(outcome, { posted: 2, duplicates: 0, overLimit: 3 });
  const review = github.reviews[0]!;
  assert.ok(review.comments.every((c) => c.body.includes("Use the HTTPS API host")));
  assert.match(review.body, /3 more not shown/);
});

test("no findings means no API calls at all", async () => {
  const github = new FakeGitHub("");
  github.listReviewComments = async () => {
    throw new Error("should not be called");
  };
  assert.deepEqual(await postReview(github, pr, "abc123", [], 20), { posted: 0, duplicates: 0, overLimit: 0 });
  assert.equal(github.reviews.length, 0);
});
