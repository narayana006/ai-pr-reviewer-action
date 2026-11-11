import assert from "node:assert/strict";
import { test } from "node:test";
import { runRuleChecks } from "../src/checks";
import { parseDiff } from "../src/diff";
import { parseRules } from "../src/rules";
import { fixture } from "./helpers";

const files = parseDiff(fixture("sample.diff"));
const rules = parseRules(fixture("rules.md"));

test("finds pattern matches on added lines only, within each rule's paths", () => {
  const found = runRuleChecks(files, rules).map((f) => `${f.path}:${f.line} ${f.rule}`);
  assert.deepEqual(found.sort(), [
    "docs/setup.md:3 Use the HTTPS API host",
    "src/billing/invoice.ts:16 Use the HTTPS API host",
    "src/billing/invoice.ts:18 No console.log in application code",
    "src/billing/invoice.ts:19 TODO comments need an issue reference",
    "src/billing/invoice.ts:22 No hard-coded credentials",
  ]);
});

test("excluded paths are skipped", () => {
  const inTest = runRuleChecks(files, rules).filter((f) => f.path.endsWith(".test.ts"));
  assert.deepEqual(inTest, []);
});

test("uses the rule's confidence and message, falling back to the description", () => {
  const findings = runRuleChecks(files, rules);
  const todo = findings.find((f) => f.rule.startsWith("TODO"))!;
  assert.equal(todo.confidence, 0.6);
  assert.equal(todo.message, "Link this TODO to an issue, for example TODO(#123).");
  const creds = findings.find((f) => f.rule === "No hard-coded credentials")!;
  assert.equal(creds.message, "Credentials belong in the secret store, never in source files.");
  assert.equal(creds.source, "rule");
});

test("builds a suggested replacement line from `replace`", () => {
  const https = runRuleChecks(files, rules).filter((f) => f.rule === "Use the HTTPS API host");
  assert.deepEqual(
    https.map((f) => f.suggestion),
    [
      '  const rates = await fetchRates("https://api.example.com/v2/rates");',
      "Point the client at https://api.example.com while developing.",
    ],
  );
});

test("replace supports capture groups and replaces every match on the line", () => {
  const diff = "--- a/a.py\n+++ b/a.py\n@@ -0,0 +1,2 @@\n+assertEquals(a, b); assertEquals(c, d)\n+untouched\n";
  const [rule] = parseRules("## Use assertEqual\n- pattern: `assertEquals\\((\\w+)`\n- replace: `assertEqual($1`\n");
  const findings = runRuleChecks(parseDiff(diff), [rule!]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.suggestion, "assertEqual(a, b); assertEqual(c, d)");
});

test("ignores removed lines, context lines, deleted files and binary files", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,2 @@",
    " console.log('context');",
    "-console.log('removed');",
    " ok();",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-console.log('deleted file');",
    "",
  ].join("\n");
  const [rule] = parseRules("## No console\n- pattern: console\\.log\n");
  assert.deepEqual(runRuleChecks(parseDiff(diff), [rule!]), []);
});
