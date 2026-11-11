# Review rules for the example shop service

Each `##` heading is one rule. The bullet settings are optional; the paragraph
is the rule in plain English.

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

## No hard-coded credentials
- pattern: `(password|secret|api_?key)\s*[:=]\s*["'][^"']{6,}["']`
- ignore-case: true
- confidence: 0.85

Credentials belong in the secret store, never in source files.

## TODO comments need an issue reference
- pattern: `TODO(?!\(#\d+\))`
- confidence: 0.6
- message: Link this TODO to an issue, for example TODO(#123).

## Money is never a float
- paths: src/billing/**

Amounts of money must be integers in minor units (cents). Flag arithmetic that
stores or computes prices as floating point numbers. This rule has no pattern,
so it is only checked when a model endpoint is configured.
