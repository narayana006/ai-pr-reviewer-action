import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "../src/diff";
import { createHttpReviewer, parseModelFindings, renderDiffForModel, validateEndpoint } from "../src/model";
import { parseRules } from "../src/rules";
import { fakeFetch, fixture } from "./helpers";

const files = parseDiff(fixture("sample.diff"));
const rules = parseRules(fixture("rules.md"));
const envelope = (content: string) => JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });

const floatFinding = {
  rule: "Money is never a float",
  path: "src/billing/invoice.ts",
  line: 17,
  message: "unitCents is divided by 100, which turns the subtotal into a float.",
  confidence: 0.9,
  suggestion: "  const subtotal = order.lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0);\n",
};

test("sends rules and a numbered diff to the configured endpoint", async () => {
  const { fetch, calls } = fakeFetch([{ body: envelope(JSON.stringify({ findings: [floatFinding] })) }]);
  const reviewer = createHttpReviewer({
    endpoint: "https://models.example.com/v1/chat/completions",
    apiKey: "test-key",
    model: "example-model",
    fetch,
  });
  const findings = await reviewer.review({ rules, files });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://models.example.com/v1/chat/completions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer test-key");
  const body = JSON.parse(call.body!) as { model: string; messages: { role: string; content: string }[] };
  assert.equal(body.model, "example-model");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  const prompt = body.messages[1]!.content;
  assert.match(prompt, /5\. Money is never a float \(applies to: src\/billing\/\*\*\)/);
  assert.match(prompt, /### src\/billing\/invoice\.ts/);
  assert.match(prompt, / {3}17 \+ {3}const subtotal = order\.lines/);

  assert.deepEqual(findings, [
    { ...floatFinding, suggestion: floatFinding.suggestion.trimEnd(), source: "model" },
  ]);
});

test("omits the authorization header and model when they are not configured", async () => {
  const { fetch, calls } = fakeFetch([{ body: '{"findings": []}' }]);
  const reviewer = createHttpReviewer({ endpoint: "http://localhost:8080/review", fetch });
  assert.deepEqual(await reviewer.review({ rules, files }), []);
  assert.equal(calls[0]!.headers.authorization, undefined);
  assert.equal("model" in JSON.parse(calls[0]!.body!), false);
});

test("drops findings that are not anchored to a known rule and an added line", () => {
  const reply = JSON.stringify({
    findings: [
      floatFinding,
      { ...floatFinding, rule: "Made-up rule" },
      { ...floatFinding, line: 14 }, // context line, not added
      { ...floatFinding, path: "src/other.ts" },
      { ...floatFinding, path: "docs/setup.md", line: 3 }, // rule is scoped to src/billing
      { ...floatFinding, line: 18, confidence: "very" },
      { ...floatFinding, line: 18, message: "" },
      "not an object",
    ],
  });
  const findings = parseModelFindings(reply, { rules, files });
  assert.deepEqual(findings.map((f) => f.line), [17]);
});

test("accepts fenced JSON, bare arrays and clamps confidence", () => {
  const fenced = "Here you go:\n```json\n" + JSON.stringify([{ ...floatFinding, confidence: 7 }]) + "\n```";
  const findings = parseModelFindings(fenced, { rules, files });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.confidence, 1);
  assert.equal(findings[0]!.rule, "Money is never a float");
});

test("fails clearly on HTTP errors and unusable replies", async () => {
  const endpoint = "https://models.example.com/review";
  const bad = fakeFetch([{ status: 500, body: "upstream exploded" }]);
  await assert.rejects(
    createHttpReviewer({ endpoint, fetch: bad.fetch }).review({ rules, files }),
    /model endpoint returned HTTP 500/,
  );
  const prose = fakeFetch([{ body: envelope("I could not find anything worth mentioning.") }]);
  await assert.rejects(
    createHttpReviewer({ endpoint, fetch: prose.fetch }).review({ rules, files }),
    /did not contain JSON/,
  );
  const html = fakeFetch([{ body: "<html>gateway</html>" }]);
  await assert.rejects(
    createHttpReviewer({ endpoint, fetch: html.fetch }).review({ rules, files }),
    /did not return JSON/,
  );
});

test("makes no request when there is nothing to review", async () => {
  const { fetch, calls } = fakeFetch([]);
  const reviewer = createHttpReviewer({ endpoint: "https://models.example.com/review", fetch });
  assert.deepEqual(await reviewer.review({ rules, files: [] }), []);
  assert.equal(calls.length, 0);
});

test("refuses endpoints that would send the key in clear text", () => {
  assert.throws(() => validateEndpoint("http://models.example.com/v1"), /must use https/);
  assert.throws(() => validateEndpoint("not a url"), /not a valid URL/);
  assert.equal(validateEndpoint("http://127.0.0.1:9000/v1").port, "9000");
  assert.equal(validateEndpoint("https://models.example.com/v1").hostname, "models.example.com");
});

test("leaves out files that do not fit in the size budget", () => {
  const { text, omittedFiles } = renderDiffForModel(files, 900);
  assert.deepEqual(omittedFiles, ["src/billing/invoice.ts"]);
  assert.doesNotMatch(text, /### src\/billing\/invoice\.ts/);
  assert.match(text, /### docs\/setup\.md/);
  assert.ok(text.length <= 900);
  assert.deepEqual(renderDiffForModel(files, 60_000).omittedFiles, []);
});

test("keeps multi-line findings whose range fits in one hunk", () => {
  const multi = {
    ...floatFinding,
    start_line: 16,
    line: 17,
    suggestion: "  const rates = await fetchRates(RATES_URL);\n  const subtotalCents = sumCents(order.lines);",
  };
  const [finding] = parseModelFindings(JSON.stringify({ findings: [multi] }), { rules, files });
  assert.equal(finding!.startLine, 16);
  assert.equal(finding!.line, 17);
  assert.equal(finding!.suggestion, multi.suggestion);

  // start_line equal to line is an ordinary single-line finding.
  const [single] = parseModelFindings(JSON.stringify([{ ...floatFinding, start_line: 17 }]), { rules, files });
  assert.equal(single!.startLine, undefined);
  assert.ok(single!.suggestion);
});

test("falls back to one line and drops the suggestion when the range is unusable", () => {
  const reply = JSON.stringify([
    { ...floatFinding, start_line: 3 }, // crosses into another hunk
    { ...floatFinding, start_line: 20 }, // after the end line
  ]);
  const findings = parseModelFindings(reply, { rules, files });
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.line, 17);
    assert.equal(f.startLine, undefined);
    assert.equal(f.suggestion, undefined);
  }
});

test("tells the model how to report multi-line findings", async () => {
  const { fetch, calls } = fakeFetch([{ body: '{"findings": []}' }]);
  await createHttpReviewer({ endpoint: "https://models.example.com/review", fetch }).review({ rules, files });
  const system = (JSON.parse(calls[0]!.body!) as { messages: { content: string }[] }).messages[0]!.content;
  assert.match(system, /"start_line"/);
});
