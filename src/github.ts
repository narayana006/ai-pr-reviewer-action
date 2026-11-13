/** The few GitHub REST calls the action needs, behind an interface tests can fake. */

import type { FetchLike } from "./model";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ExistingComment {
  path: string;
  line: number | null;
  body: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  /** First line of a multi-line comment. */
  startLine?: number;
  body: string;
}

export interface GitHubClient {
  getPullRequestDiff(pr: PullRequestRef): Promise<string>;
  listReviewComments(pr: PullRequestRef): Promise<ExistingComment[]>;
  createReview(
    pr: PullRequestRef,
    review: { commitId: string; body: string; comments: ReviewComment[] },
  ): Promise<void>;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, action: string, detail: string) {
    super(`GitHub API ${action} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "GitHubApiError";
  }
}

export interface RestClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

export function createRestClient(options: RestClientOptions): GitHubClient {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(
    action: string,
    method: string,
    path: string,
    accept: string,
    body?: unknown,
  ): Promise<string> {
    const headers: Record<string, string> = {
      accept,
      authorization: `Bearer ${options.token}`,
      "user-agent": "ai-pr-reviewer-action",
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await doFetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try {
        detail = String((JSON.parse(text) as { message?: unknown }).message ?? "");
      } catch {
        // Non-JSON error body; the status code is enough.
      }
      throw new GitHubApiError(response.status, action, detail);
    }
    return text;
  }

  const base = (pr: PullRequestRef) =>
    `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;

  return {
    getPullRequestDiff(pr) {
      return call("fetching the pull request diff", "GET", base(pr), "application/vnd.github.diff");
    },

    async listReviewComments(pr) {
      const comments: ExistingComment[] = [];
      const perPage = 100;
      for (let page = 1; page <= 20; page++) {
        const text = await call(
          "listing review comments",
          "GET",
          `${base(pr)}/comments?per_page=${perPage}&page=${page}`,
          "application/vnd.github+json",
        );
        const batch = JSON.parse(text) as { path?: string; line?: number | null; body?: string }[];
        for (const item of batch) {
          comments.push({ path: item.path ?? "", line: item.line ?? null, body: item.body ?? "" });
        }
        if (batch.length < perPage) break;
      }
      return comments;
    },

    async createReview(pr, review) {
      await call("creating the review", "POST", `${base(pr)}/reviews`, "application/vnd.github+json", {
        commit_id: review.commitId,
        event: "COMMENT",
        body: review.body,
        comments: review.comments.map((c) =>
          c.startLine === undefined
            ? { path: c.path, line: c.line, side: "RIGHT", body: c.body }
            : {
                path: c.path,
                start_line: c.startLine,
                start_side: "RIGHT",
                line: c.line,
                side: "RIGHT",
                body: c.body,
              },
        ),
      });
    },
  };
}
