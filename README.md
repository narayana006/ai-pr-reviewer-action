# ai-pr-reviewer-action

A GitHub Action that reviews a pull request diff against rules your team writes in `.ai-review.md`, and leaves inline comments only for findings above a confidence threshold.

**Status: first working version (0.1).** Deterministic rule checks, path scoping, the confidence threshold, inline comments with suggested fixes (including multi-line ranges from the model reviewer) and a dry-run/command-line mode all work today and are covered by tests. The model reviewer is implemented as an optional HTTP client and is off unless you configure an endpoint; it has only been tested against a fake endpoint, never against a real model service. Posting comments has been tested against a fake GitHub client, not yet on a live pull request. There is no `v1` tag yet, so pin to `main` or a commit SHA.

## How it works

1. You write rules in `.ai-review.md`. Each rule is a heading, a plain-English description and, optionally, a pattern.
2. On a pull request the action fetches the diff, splits it into hunks, and checks every **added** line against the rules that apply to that file.
3. Rules with a `pattern` are checked deterministically, with no model and no network calls beyond the GitHub API.
4. If (and only if) you configure a model endpoint, the rules and the diff are also sent there, and the model's findings are validated and merged in.
5. Findings below the confidence threshold are dropped. The rest are posted as one review with inline comments.

## Quick start

Add a rules file to your repository:

```markdown
# Review rules

## No console.log in application code
- paths: src/**
- exclude: src/**/*.test.ts
- pattern: `console\.log\(`
- confidence: 0.95

Use the shared logger instead of console.log so output can be filtered by level.

## Use the HTTPS API host
- pattern: `http://api\.example\.com`
- replace: `https://api.example.com`
- message: Call the API over HTTPS; the plain HTTP host is being retired.
```

And a workflow:

```yaml
name: Review
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: narayana006/ai-pr-reviewer-action@main
        with:
          rules: .ai-review.md
          confidence-threshold: "0.8"
```

The checkout step is needed because the rules file is read from the workspace.

## Try it locally

The same code runs from a terminal and only prints what it finds. You need Node.js 20 or newer; there is nothing to install because the bundled `dist/index.js` has no dependencies.

```bash
git clone https://github.com/narayana006/ai-pr-reviewer-action
cd ai-pr-reviewer-action
node dist/index.js --diff examples/sample.diff --rules examples/.ai-review.md
```

Output:

```text
docs/setup.md:3  [Use the HTTPS API host]  confidence 1.00  (rule)
    Call the API over HTTPS; the plain HTTP host is being retired.
    suggested fix: Point the client at https://api.example.com while developing.
src/billing/invoice.ts:16  [Use the HTTPS API host]  confidence 1.00  (rule)
    Call the API over HTTPS; the plain HTTP host is being retired.
    suggested fix: const rates = await fetchRates("https://api.example.com/v2/rates");
src/billing/invoice.ts:18  [No console.log in application code]  confidence 0.95  (rule)
    Use the shared logger instead of console.log so output can be filtered by level.
src/billing/invoice.ts:22  [No hard-coded credentials]  confidence 0.85  (rule)
    Credentials belong in the secret store, never in source files.
4 findings at or above confidence 0.80, 1 below the threshold not shown
```

The dropped finding is a `TODO` rule with confidence 0.6; add `--threshold 0.5` to see it. The `console.log` added to `invoice.test.ts` is not reported because that rule excludes test files. To review your own work: `git diff main... | node dist/index.js --diff - --rules .ai-review.md`.

Other options: `--json` for machine-readable output, `--fail-on-findings` for a non-zero exit status, `--help` for the full list.

## Writing rules

Every `## ` heading starts a rule. Bullets of the form `- key: value` under the heading are settings; all other text is the description. Text before the first rule, and anything under a `# ` heading, is ignored, so you can add notes for humans.

| Setting | Meaning |
| --- | --- |
| `paths` | Comma-separated globs the rule applies to. Default: every file. |
| `exclude` | Comma-separated globs to skip. Wins over `paths`. |
| `pattern` | JavaScript regular expression tested against each added line. Backticks around it are optional. |
| `ignore-case` | `true` to match the pattern case-insensitively. |
| `replace` | Replacement for the matched text (`$1` groups work). Produces a GitHub suggestion the author can apply with one click. Needs `pattern`. |
| `message` | Comment text. Default: the rule's description. |
| `confidence` | 0 to 1, assigned to pattern matches of this rule. Default: 1. |

Globs support `*`, `**` and `?`. A glob without a slash (`*.md`) matches in any directory; a glob ending in a slash (`src/`) matches everything below it.

A rule with no `pattern` is plain English only. It is skipped by the deterministic checks and used only by the model reviewer. Mistakes in the file (an invalid regular expression, a confidence outside 0 to 1, a duplicate rule name) fail the run with the line number.

See [examples/.ai-review.md](examples/.ai-review.md) for a complete file.

## Inputs and outputs

| Input | Default | Description |
| --- | --- | --- |
| `rules` | `.ai-review.md` | Path to the rules file. |
| `confidence-threshold` | `0.8` | Findings below this are not reported. |
| `max-comments` | `20` | Cap on inline comments per run; the most confident findings are kept. |
| `github-token` | `${{ github.token }}` | Used to read the diff and post the review. |
| `dry-run` | `false` | Log findings and post nothing. |
| `fail-on-findings` | `false` | Fail the step when any finding meets the threshold. |
| `diff-file` | | Review a diff file from the workspace instead of the pull request. Nothing is posted. |
| `model-endpoint` | | Optional URL of a model endpoint. Empty means no model is called. |
| `model-api-key` | | Bearer token for the endpoint. |
| `model-name` | | Model name sent in the request. |

Outputs: `findings-count` and `comments-posted`. A table of findings is also written to the job summary.

Comments are posted only when the action runs inside GitHub Actions on a `pull_request` event with `dry-run` off and no `diff-file`. Each comment carries a hidden marker, so re-running on the same pull request does not repeat a comment that is already on that line.

## Optional model reviewer

The model reviewer is off by default. To turn it on, point the action at any HTTP endpoint that accepts an OpenAI-compatible chat completions request, and keep the key in a repository secret:

```yaml
      - uses: narayana006/ai-pr-reviewer-action@main
        with:
          model-endpoint: https://models.example.com/v1/chat/completions
          model-api-key: ${{ secrets.REVIEW_MODEL_API_KEY }}
          model-name: your-model-name
```

What happens when it is on:

- The request is a `POST` with `{"model", "temperature": 0, "messages": [system, user]}`; the user message contains your rules and the diff with line numbers. **Your diff leaves GitHub and goes to that endpoint.**
- The reply must contain JSON of the form `{"findings": [{"rule", "path", "line", "message", "confidence", "suggestion"}]}`, either as the message content of a chat completions response or as the response body itself.
- A finding is kept only if it names one of your rules, points at an added line in the diff, and the rule's `paths` cover that file. Everything else is discarded.
- If the endpoint fails or returns something unusable, a warning is logged and the deterministic findings are still reported.
- The endpoint must be `https` (plain `http` is accepted for `localhost` only).

### Multi-line findings

A model finding may cover several lines. It adds `"start_line"` (the first line) and sets `"line"` to the last line. Both lines must be in the same hunk of the diff, and the last one must be an added line. Such a finding is posted as one comment over the whole range, and its suggestion replaces every line in the range. The text report shows it as `path:16-17`. If the range is not valid (for example it spans two hunks), the finding is kept on its last line and the suggestion is dropped, because a fix written for several lines would break the file if applied to one. Pattern rules always report one line.

## Features

- [x] Rules written in plain English in `.ai-review.md` (with optional patterns for deterministic checks)
- [x] Confidence threshold to keep comments high-signal
- [x] Inline PR comments with suggested fixes (built from a rule's `replace`, or supplied by the model)
- [x] Path-based rule scoping (`paths` and `exclude` globs)
- [x] Provider-agnostic model configuration (one HTTP endpoint, off by default)
- [ ] Verified against a live pull request and a real model endpoint
- [ ] Tagged `v1` release
- [x] Multi-line findings and suggestions (from the model reviewer; pattern rules stay single-line)
- [ ] Splitting large diffs across several model requests

## Limitations

- Plain-English rules without a `pattern` do nothing unless a model endpoint is configured.
- Patterns are matched one added line at a time. They cannot see context, removed lines or constructs that span lines. Only the model reviewer can report a finding that spans several lines.
- The model path has been exercised only with fakes. Reply quality, token limits and cost with a real service are untested. The diff sent to the model is capped at about 60,000 characters; files that do not fit are skipped and listed in the log.
- Diff content is untrusted input to the model. Findings are validated against your rules and the diff, but a model can still be wrong or be steered by text in the diff.
- GitHub refuses to return very large pull request diffs (roughly more than 300 files); the action fails with GitHub's error in that case.
- Pull requests from forks get a read-only token, so comments cannot be posted; the action logs a warning and still reports findings in the log and job summary.
- On `pull_request` events the rules file comes from the pull request's own checkout, so a pull request can change the rules it is reviewed against.

## Development

```bash
npm ci
npm run typecheck
npm test          # compiles to build/ and runs the tests with node --test
npm run build     # bundles src/ into dist/index.js
```

Development needs Node.js 22 or newer. `dist/index.js` is committed because GitHub runs actions straight from the repository; CI rebuilds it and fails if the committed copy is out of date. Tests use recorded diffs and a fake GitHub client, and never call GitHub or a model service.

## Contributing

Issues and pull requests are welcome. Good first contributions: a rule that behaved unexpectedly (include the rule and a small diff), diff formats the parser gets wrong, or reports from trying a model endpoint. Please run `npm test` and `npm run build` before opening a pull request.

Built and maintained by [Narayana Vemburaj](https://github.com/narayana006).

## License

[MIT](LICENSE)
