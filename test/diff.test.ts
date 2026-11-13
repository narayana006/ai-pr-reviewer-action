import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLineIndex, addedLines, isCommentableRange, parseDiff } from "../src/diff";
import { fixture } from "./helpers";

test("parses files, statuses and hunk headers from a git diff", () => {
  const files = parseDiff(fixture("sample.diff"));
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.hunks.length]),
    [
      ["src/billing/invoice.ts", "modified", 2],
      ["src/billing/invoice.test.ts", "modified", 1],
      ["docs/setup.md", "added", 1],
    ],
  );
  const second = files[0]!.hunks[1]!;
  assert.equal(second.oldStart, 12);
  assert.equal(second.newStart, 13);
  assert.equal(second.newLines, 13);
  assert.match(second.section, /lineTotal/);
});

test("assigns new-side line numbers to added lines", () => {
  const [invoice] = parseDiff(fixture("sample.diff"));
  const added = addedLines(invoice!).map((l) => [l.newLine, l.content.trim().slice(0, 20)]);
  assert.deepEqual(added, [
    [3, "import { fetchRates "],
    [16, "const rates = await "],
    [17, "const subtotal = ord"],
    [18, 'console.log("subtota'],
    [19, "// TODO handle multi"],
    [20, "// TODO(#482) round "],
    [22, 'const apiKey = "exam'],
  ]);
});

test("tracks old and new numbers separately across deletions", () => {
  const diff = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -10,4 +10,3 @@",
    " keep",
    "-gone one",
    "-gone two",
    "+replacement",
    " tail",
  ].join("\n");
  const [file] = parseDiff(diff);
  assert.deepEqual(
    file!.hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ["context", 10, 10],
      ["del", 11, undefined],
      ["del", 12, undefined],
      ["add", undefined, 11],
      ["context", 13, 12],
    ],
  );
});

test("a deleted line that looks like a file header stays inside its hunk", () => {
  const diff = [
    "diff --git a/notes.sql b/notes.sql",
    "--- a/notes.sql",
    "+++ b/notes.sql",
    "@@ -1,2 +1,2 @@",
    "--- old comment",
    "+++ new comment",
    " select 1;",
  ].join("\n");
  const files = parseDiff(diff);
  assert.equal(files.length, 1);
  assert.deepEqual(
    files[0]!.hunks[0]!.lines.map((l) => [l.kind, l.content]),
    [
      ["del", "-- old comment"],
      ["add", "++ new comment"],
      ["context", "select 1;"],
    ],
  );
});

test("handles renames, deletions, binary files and missing trailing newlines", () => {
  const diff = [
    "diff --git a/old/name.ts b/new/name.ts",
    "similarity index 90%",
    "rename from old/name.ts",
    "rename to new/name.ts",
    "--- a/old/name.ts",
    "+++ b/new/name.ts",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "\\ No newline at end of file",
    "+export const a = 2;",
    "\\ No newline at end of file",
    "diff --git a/removed.ts b/removed.ts",
    "deleted file mode 100644",
    "--- a/removed.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const files = parseDiff(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.status, f.binary]),
    [
      ["new/name.ts", "old/name.ts", "renamed", false],
      ["removed.ts", "removed.ts", "deleted", false],
      ["logo.png", "logo.png", "modified", true],
    ],
  );
  assert.deepEqual([...addedLineIndex(files)], ["new/name.ts:1"]);
});

test("reads quoted paths, paths with spaces and CRLF line endings", () => {
  const diff = [
    'diff --git "a/docs/caf\\303\\251 menu.md" "b/docs/caf\\303\\251 menu.md"',
    '--- "a/docs/caf\\303\\251 menu.md"',
    '+++ "b/docs/caf\\303\\251 menu.md"',
    "@@ -1 +1,2 @@",
    " espresso",
    "+flat white",
    "diff --git a/my notes.txt b/my notes.txt",
    "--- a/my notes.txt",
    "+++ b/my notes.txt",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\r\n");
  const files = parseDiff(diff);
  assert.deepEqual(files.map((f) => f.path), ["docs/café menu.md", "my notes.txt"]);
  assert.equal(files[0]!.hunks[0]!.lines[1]!.content, "flat white");
});

test("returns nothing for empty or non-diff input", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("just some text\nnot a diff\n"), []);
});

test("recognises ranges a multi-line comment can cover", () => {
  const files = parseDiff(fixture("sample.diff"));
  const path = "src/billing/invoice.ts";
  assert.equal(isCommentableRange(files, path, 16, 18), true);
  assert.equal(isCommentableRange(files, path, 14, 17), true, "a context line may start the range");
  assert.equal(isCommentableRange(files, path, 16, 21), false, "the last line must be an added line");
  assert.equal(isCommentableRange(files, path, 3, 17), false, "the range may not span two hunks");
  assert.equal(isCommentableRange(files, path, 17, 17), false);
  assert.equal(isCommentableRange(files, path, 18, 16), false);
  assert.equal(isCommentableRange(files, "src/other.ts", 16, 17), false);
});
