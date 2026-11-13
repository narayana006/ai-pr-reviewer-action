import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestClient, GitHubApiError } from "../src/github";
import { fakeFetch } from "./helpers";

const pr = { owner: "example-org", repo: "shop-service", number: 7 };

test("requests the pull request in diff format", async () => {
  const { fetch, calls } = fakeFetch([{ body: "diff --git a/a b/a\n" }]);
  const client = createRestClient({ token: "t0ken", fetch });
  assert.equal(await client.getPullRequestDiff(pr), "diff --git a/a b/a\n");
  assert.equal(calls[0]!.url, "https://api.github.com/repos/example-org/shop-service/pulls/7");
  assert.equal(calls[0]!.headers.accept, "application/vnd.github.diff");
  assert.equal(calls[0]!.headers.authorization, "Bearer t0ken");
});

test("pages through existing review comments", async () => {
  const page = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ path: "a.ts", line: i + 1, body: `c${i}` })));
  const { fetch, calls } = fakeFetch([{ body: page(100) }, { body: page(3) }]);
  const client = createRestClient({ token: "t", apiUrl: "https://github.example.com/api/v3/", fetch });
  const comments = await client.listReviewComments(pr);
  assert.equal(comments.length, 103);
  assert.deepEqual(comments[102], { path: "a.ts", line: 3, body: "c2" });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://github.example.com/api/v3/repos/example-org/shop-service/pulls/7/comments?per_page=100&page=1",
      "https://github.example.com/api/v3/repos/example-org/shop-service/pulls/7/comments?per_page=100&page=2",
    ],
  );
});

test("creates a COMMENT review with right-side line comments", async () => {
  const { fetch, calls } = fakeFetch([{ body: "{}" }]);
  const client = createRestClient({ token: "t", fetch });
  await client.createReview(pr, {
    commitId: "abc123",
    body: "summary",
    comments: [{ path: "src/a.ts", line: 12, body: "note" }],
  });
  assert.equal(calls[0]!.method, "POST");
  assert.ok(calls[0]!.url.endsWith("/pulls/7/reviews"));
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    commit_id: "abc123",
    event: "COMMENT",
    body: "summary",
    comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", body: "note" }],
  });
});

test("turns API failures into errors with the status and GitHub's message", async () => {
  const { fetch } = fakeFetch([{ status: 403, body: '{"message":"Resource not accessible by integration"}' }]);
  const client = createRestClient({ token: "t", fetch });
  await assert.rejects(client.createReview(pr, { commitId: "c", body: "", comments: [] }), (err: unknown) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.status, 403);
    assert.match(err.message, /creating the review failed with HTTP 403: Resource not accessible/);
    return true;
  });
});

test("sends start_line and start_side for multi-line comments", async () => {
  const { fetch, calls } = fakeFetch([{ body: "{}" }]);
  const client = createRestClient({ token: "t", fetch });
  await client.createReview(pr, {
    commitId: "abc123",
    body: "summary",
    comments: [{ path: "src/a.ts", startLine: 10, line: 12, body: "note" }],
  });
  assert.deepEqual((JSON.parse(calls[0]!.body!) as { comments: unknown[] }).comments, [
    { path: "src/a.ts", start_line: 10, start_side: "RIGHT", line: 12, side: "RIGHT", body: "note" },
  ]);
});
