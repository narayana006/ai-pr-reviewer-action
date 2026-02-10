# ai-pr-reviewer-action

GitHub Action for AI pull request review driven by plain-English rules in .ai-review.md, commenting only on high-confidence findings.

> **Project status: planning. There is no working code in this repository yet.**
> This README describes what the project will do. Nothing below can be installed or run today.
> Features are ticked off in the checklist as they are built.

## What it is

A GitHub Action.

**The problem it solves:** Generic AI reviewers are noisy black boxes. Teams want reviewers that follow their own rules.

## Who it is for

Teams who want automated pull request review that follows their own written rules.

## How it will work

1. You write your review rules in plain English in a file named .ai-review.md.
2. The action runs on each pull request and checks the diff against those rules.
3. It leaves inline comments only for findings above a confidence threshold you set.

## Planned features

Unticked items are not built yet.

- [ ] Rules written in plain English in .ai-review.md
- [ ] Confidence threshold to keep comments high-signal
- [ ] Inline PR comments with suggested fixes
- [ ] Path-based rule scoping
- [ ] Provider-agnostic model configuration

## Planned usage

This is the intended interface, shown so you can judge the design. **It does not work yet**, and names may change before the first release.

```yaml
- uses: narayana006/ai-pr-reviewer-action@v1
  with:
    rules: .ai-review.md
```

## Contributing

Feedback on the design is the most useful contribution right now. Open an issue to suggest a feature, question an approach or describe your use case. Code contributions are welcome once the first version lands.

## License

[MIT](LICENSE)
