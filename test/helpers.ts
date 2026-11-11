import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExistingComment, GitHubClient, PullRequestRef, ReviewComment } from "../src/github";
import type { FetchLike } from "../src/model";

// Compiled tests live in build/test, fixtures stay in the source tree.
export const FIXTURES = join(__dirname, "..", "..", "test", "fixtures");
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** In-memory stand-in for the GitHub API. */
export class FakeGitHub implements GitHubClient {
  reviews: { pr: PullRequestRef; commitId: string; body: string; comments: ReviewComment[] }[] = [];
  existing: ExistingComment[] = [];
  failCreateWith: Error | null = null;

  constructor(readonly diff: string) {}

  async getPullRequestDiff(): Promise<string> {
    return this.diff;
  }
  async listReviewComments(): Promise<ExistingComment[]> {
    return this.existing;
  }
  async createReview(
    pr: PullRequestRef,
    review: { commitId: string; body: string; comments: ReviewComment[] },
  ): Promise<void> {
    if (this.failCreateWith) throw this.failCreateWith;
    this.reviews.push({ pr, ...review });
    for (const c of review.comments) this.existing.push({ ...c });
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that records calls and answers from a queue of canned responses. */
export function fakeFetch(responses: { status?: number; body: string }[]) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    const status = next.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => next.body };
  };
  return { fetch, calls };
}
