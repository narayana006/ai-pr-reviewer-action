# ai-pr-reviewer-action

> GitHub Action for AI pull request review driven by plain-English rules in .ai-review.md, commenting only on high-confidence findings.

**Status:** 🚧 Early stage — design and roadmap published, implementation in progress. Stars, issues and ideas welcome.

## Why

Generic AI reviewers are noisy black boxes. Teams want reviewers that follow their own rules.

## Planned features

- [ ] Rules written in plain English in .ai-review.md
- [ ] Confidence threshold to keep comments high-signal
- [ ] Inline PR comments with suggested fixes
- [ ] Path-based rule scoping
- [ ] Provider-agnostic model configuration

## Intended usage

```
- uses: narayana006/ai-pr-reviewer-action@v1
  with:
    rules: .ai-review.md
```

_The interface above is the target design and may change._

## Roadmap

1. Core implementation of the first feature set
2. Examples and tests
3. CI and first tagged release
4. Docs and integrations

## Contributing

Contributions are welcome. Open an issue to discuss an idea or pick an unchecked item from the feature list.

## License

[MIT](LICENSE)
