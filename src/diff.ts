/**
 * Unified diff parsing.
 *
 * Turns the text of a `git diff` (or the diff GitHub returns for a pull
 * request) into files and hunks with real line numbers, so findings can be
 * anchored to a line that exists on the new side of the diff.
 */

export type LineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: LineKind;
  /** Line text without the leading "+", "-" or " " marker. */
  content: string;
  /** Line number in the old file (absent for added lines). */
  oldLine?: number;
  /** Line number in the new file (absent for deleted lines). */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second "@@", usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface FileDiff {
  /** Path on the new side; for deleted files, the old path. */
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Removes git's quoting and the "a/" or "b/" prefix from a diff path. */
function cleanPath(raw: string): string | null {
  let path = raw.trim();
  // Timestamps from plain `diff -u` follow a tab.
  const tab = path.indexOf("\t");
  if (tab !== -1) path = path.slice(0, tab);
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = unquote(path.slice(1, -1));
  }
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

/** Decodes the C-style escapes git uses for unusual file names. */
function unquote(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
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

/** Splits the two paths of a `diff --git a/x b/y` header. */
function pathsFromGitHeader(rest: string): [string, string] | null {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) {
    const a = cleanPath(quoted[1]!);
    const b = cleanPath(quoted[2]!);
    if (a && b) return [a, b];
  }
  // Unquoted paths containing spaces: when the file was not renamed the
  // header is "a/<path> b/<path>", so the midpoint separates the two.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const a = cleanPath(rest.slice(0, mid));
    const b = cleanPath(rest.slice(mid + 1));
    if (a && b && a === b) return [a, b];
  }
  return null;
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const startFile = (oldPath: string, path: string): FileDiff => {
    const next: FileDiff = { path, oldPath, status: "modified", binary: false, hunks: [] };
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
        // Some tools strip the trailing space from empty context lines.
        hunk.lines.push({
          kind: "context",
          content: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (marker === "\\") continue; // "\ No newline at end of file"
      // Anything else means the hunk was shorter than its header said.
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
      // A bare "---"/"+++" pair (no "diff --git" line) starts a new file.
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
        oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
        newRemaining = header[4] === undefined ? 1 : Number(header[4]);
        hunk = {
          oldStart: oldLine,
          oldLines: oldRemaining,
          newStart: newLine,
          newLines: newRemaining,
          section: header[5] ?? "",
          lines: [],
        };
        file.hunks.push(hunk);
      }
    }
  }
  return files.filter((f) => f.path !== "");
}

/** The lines a review comment may be anchored to: additions, by file. */
export function addedLines(file: FileDiff): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add"));
}

/** Set of "path:line" keys for every added line in the diff. */
export function addedLineIndex(files: FileDiff[]): Set<string> {
  const index = new Set<string>();
  for (const file of files) {
    if (file.status === "deleted" || file.binary) continue;
    for (const line of addedLines(file)) index.add(`${file.path}:${line.newLine}`);
  }
  return index;
}
