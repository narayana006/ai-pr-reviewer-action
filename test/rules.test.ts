import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, parseRules, ruleApplies, RuleError } from "../src/rules";
import { fixture } from "./helpers";

test("parses headings, settings and prose from the example rules file", () => {
  const rules = parseRules(fixture("rules.md"));
  assert.deepEqual(
    rules.map((r) => r.name),
    [
      "No console.log in application code",
      "Use the HTTPS API host",
      "No hard-coded credentials",
      "TODO comments need an issue reference",
      "Money is never a float",
    ],
  );
  const [consoleRule, https, creds, , money] = rules;
  assert.deepEqual(consoleRule!.paths, ["src/**"]);
  assert.deepEqual(consoleRule!.exclude, ["src/**/*.test.ts"]);
  assert.equal(consoleRule!.pattern!.source, "console\\.log\\(");
  assert.equal(consoleRule!.confidence, 0.95);
  assert.match(consoleRule!.description, /^Use the shared logger/);

  assert.equal(https!.replace, "https://api.example.com");
  assert.equal(https!.confidence, 1);
  assert.equal(creds!.pattern!.flags, "i");
  assert.equal(money!.pattern, undefined);
  assert.match(money!.description, /minor units/);
});

test("text before the first rule and under level-one headings is ignored", () => {
  const rules = parseRules("Intro text\n- pattern: nope\n\n## Only rule\nBody.\n\n# Appendix\n- pattern: x\n");
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.description, "Body.");
  assert.equal(rules[0]!.pattern, undefined);
});

test("unknown bullet keys and fenced code stay part of the description", () => {
  const rules = parseRules(
    ["## Rule", "- note: keep this bullet", "```", "- pattern: inside a fence", "## not a heading", "```"].join("\n"),
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.pattern, undefined);
  assert.match(rules[0]!.description, /note: keep this bullet/);
  assert.match(rules[0]!.description, /not a heading/);
});

test("reports mistakes with the line they are on", () => {
  const cases: [string, RegExp][] = [
    ["## A\n- pattern: `(unclosed`", /line 2: invalid pattern/],
    ["## A\n- confidence: high", /line 2: confidence must be a number between 0 and 1/],
    ["## A\n- confidence: 1.5", /line 2: confidence/],
    ["## A\n- replace: x", /line 2: replace needs a pattern/],
    ["## A\n- pattern: a\n- pattern: b", /line 3: "pattern" is set twice/],
    ["## A\ntext\n## A\n", /line 3: duplicate rule name "A"/],
  ];
  for (const [markdown, expected] of cases) {
    assert.throws(() => parseRules(markdown), (err: unknown) => {
      assert.ok(err instanceof RuleError);
      assert.match(err.message, expected);
      return true;
    });
  }
});

test("globs match the way path scopes are usually written", () => {
  const cases: [string, string, boolean][] = [
    ["src/**", "src/a.ts", true],
    ["src/**", "src/deep/er/a.ts", true],
    ["src/**", "lib/src/a.ts", false],
    ["src/", "src/a.ts", true],
    ["*.md", "README.md", true],
    ["*.md", "docs/guide/setup.md", true],
    ["docs/*.md", "docs/guide/setup.md", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "src/x/a.test.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a.tsx", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file12.txt", false],
    ["a+b(1).txt", "a+b(1).txt", true],
  ];
  for (const [glob, path, expected] of cases) {
    assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`);
  }
});

test("exclude wins over paths, and no paths means every file", () => {
  const [scoped, open] = parseRules(
    "## Scoped\n- paths: src/**, lib/**\n- exclude: **/*.test.ts\n\n## Open\ntext\n",
  );
  assert.equal(ruleApplies(scoped!, "src/a.ts"), true);
  assert.equal(ruleApplies(scoped!, "lib/b.ts"), true);
  assert.equal(ruleApplies(scoped!, "src/a.test.ts"), false);
  assert.equal(ruleApplies(scoped!, "docs/a.md"), false);
  assert.equal(ruleApplies(open!, "anything/at/all.txt"), true);
});
