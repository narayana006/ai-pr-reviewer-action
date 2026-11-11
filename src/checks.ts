/** Deterministic rule checks: each rule's `pattern` against added lines. */

import { addedLines, type FileDiff } from "./diff";
import { ruleApplies, type Rule } from "./rules";

export interface Finding {
  rule: string;
  path: string;
  /** Line number on the new side of the diff. */
  line: number;
  message: string;
  /** 0 to 1. */
  confidence: number;
  /** Full replacement text for the line, when a fix can be suggested. */
  suggestion?: string;
  source: "rule" | "model";
}

export function runRuleChecks(files: FileDiff[], rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  const patternRules = rules.filter((rule) => rule.pattern !== undefined);

  for (const file of files) {
    if (file.binary || file.status === "deleted") continue;
    const applicable = patternRules.filter((rule) => ruleApplies(rule, file.path));
    if (applicable.length === 0) continue;

    for (const line of addedLines(file)) {
      for (const rule of applicable) {
        const pattern = rule.pattern!;
        if (!pattern.test(line.content)) continue;
        const finding: Finding = {
          rule: rule.name,
          path: file.path,
          line: line.newLine!,
          message: rule.message ?? (rule.description || `Matches the rule "${rule.name}".`),
          confidence: rule.confidence,
          source: "rule",
        };
        if (rule.replace !== undefined) {
          const everyMatch = new RegExp(pattern.source, `${pattern.flags}g`);
          const fixed = line.content.replace(everyMatch, rule.replace);
          if (fixed !== line.content) finding.suggestion = fixed;
        }
        findings.push(finding);
      }
    }
  }
  return findings;
}
