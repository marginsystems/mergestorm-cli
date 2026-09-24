import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "./errors.js";
import {
  buildCreatePrsMutation,
  chunkCreatePrs,
  createPrs,
  createPrsOnRepository,
  fetchRepositoryId,
  findOpenPrNumber,
  githubApiFromEnv,
  ghGraphql,
  GraphqlBlockedError,
  isGraphqlEndpointBlocked,
  requireGh,
  runGh,
  type GhResult,
  type GraphqlRequest,
  type GraphqlResponse,
  type GraphqlRunner,
  type NewPr,
} from "./gh.js";

const CLAUDE_CODE_GRAPHQL_BLOCK =
  "HTTP 403: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...)";

type GhCall = { args: string[]; input?: string };

function fakeGh(respond: (args: string[], input: string | undefined, call: number) => GhResult) {
  const calls: GhCall[] = [];
  const gh = (args: string[], input?: string): GhResult => {
    calls.push({ args, input });
    return respond(args, input, calls.length);
  };
  return { gh, calls };
}

function restCreateGh(options: { firstNumber?: number; failOnCall?: number } = {}) {
  let next = options.firstNumber ?? 200;
  return fakeGh((args, _input, call) => {
    if (args[0] !== "api") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (options.failOnCall === call) {
      return {
        ok: false,
        status: 1,
        stderr: "gh: Validation Failed (HTTP 422)",
        stdout: JSON.stringify({
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for acme:feat/l2." }],
        }),
      };
    }
    next += 1;
    return { ok: true, stdout: JSON.stringify({ number: next }) };
  });
}

function throwingGraphql(error: Error): GraphqlRunner {
  return () => {
    throw error;
  };
}

function newPrs(count: number): NewPr[] {
  return Array.from({ length: count }, (_, i) => ({
    base: i === 0 ? "main" : `feat/l${i}`,
    head: `feat/l${i + 1}`,
    title: `layer ${i + 1}`,
    body: `body ${i + 1}`,
  }));
}

function recordingRunner(respond?: (request: GraphqlRequest, call: number) => GraphqlResponse) {
  const requests: GraphqlRequest[] = [];
  let next = 0;
  const runner = (request: GraphqlRequest): GraphqlResponse => {
    requests.push(request);
    if (respond) return respond(request, requests.length);
    const data: Record<string, unknown> = {};
    Object.keys(request.variables).forEach((_, i) => {
      next += 1;
      data[`pr${i}`] = { pullRequest: { number: next } };
    });
    return { data };
  };
  return { runner, requests };
}

test("buildCreatePrsMutation aliases one createPullRequest per PR with typed inputs", () => {
  const req = buildCreatePrsMutation("R_kgDO", newPrs(2));
  assert.equal(
    req.query,
    "mutation MgStackSubmit($in0: CreatePullRequestInput!, $in1: CreatePullRequestInput!) {\n" +
      "  pr0: createPullRequest(input: $in0) { pullRequest { number } }\n" +
      "  pr1: createPullRequest(input: $in1) { pullRequest { number } }\n" +
      "}",
  );
  assert.deepEqual(req.variables, {
    in0: { repositoryId: "R_kgDO", baseRefName: "main", headRefName: "feat/l1", title: "layer 1", body: "body 1" },
    in1: { repositoryId: "R_kgDO", baseRefName: "feat/l1", headRefName: "feat/l2", title: "layer 2", body: "body 2" },
  });
});

test("chunkCreatePrs splits at 5 and never splits a wave of 5 or fewer", () => {
  assert.deepEqual(chunkCreatePrs([1]).map((c) => c.length), [1]);
  assert.deepEqual(chunkCreatePrs([1, 2, 3, 4, 5]).map((c) => c.length), [5]);
  assert.deepEqual(chunkCreatePrs([1, 2, 3, 4, 5, 6]).map((c) => c.length), [5, 1]);
  assert.deepEqual(chunkCreatePrs(Array.from({ length: 12 }, (_, i) => i)).map((c) => c.length), [5, 5, 2]);
});

test("createPrsOnRepository sends one request per chunk and returns numbers in order", () => {
  const five = recordingRunner();
  assert.deepEqual(createPrsOnRepository("R_1", newPrs(5), five.runner), [1, 2, 3, 4, 5]);
  assert.equal(five.requests.length, 1);

  const seven = recordingRunner();
  assert.deepEqual(createPrsOnRepository("R_1", newPrs(7), seven.runner), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    seven.requests.map((r) => Object.keys(r.variables).length),
    [5, 2],
  );
  assert.equal(
    (seven.requests[1]!.variables.in0 as { headRefName: string }).headRefName,
    "feat/l6",
  );
});

test("createPrsOnRepository surfaces a rejected request without reporting PRs as opened", () => {
  const { runner } = recordingRunner(() => ({
    data: null,
    errors: [{ message: "Head sha can't be blank" }],
  }));
  assert.throws(
    () => createPrsOnRepository("R_1", newPrs(2), runner),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /feat\/l1 → main, feat\/l2 → feat\/l1/);
      assert.match(err.message, /Head sha can't be blank/);
      assert.doesNotMatch(err.message, /GitHub did open/);
      return true;
    },
  );
});

test("createPrsOnRepository names PRs GitHub did open when a later mutation or chunk fails", () => {
  const partial = recordingRunner(() => ({
    data: { pr0: { pullRequest: { number: 7 } }, pr1: null },
    errors: [{ message: "A pull request already exists for feat/l2." }],
  }));
  assert.throws(
    () => createPrsOnRepository("R_1", newPrs(2), partial.runner),
    /already exists for feat\/l2\.\nGitHub did open #7 \(feat\/l1\);/,
  );

  const secondChunk = recordingRunner((request, call) => {
    if (call === 2) return { data: null, errors: [{ message: "boom" }] };
    const data: Record<string, unknown> = {};
    Object.keys(request.variables).forEach((_, i) => {
      data[`pr${i}`] = { pullRequest: { number: 10 + i } };
    });
    return { data };
  });
  assert.throws(
    () => createPrsOnRepository("R_1", newPrs(6), secondChunk.runner),
    /boom\nGitHub did open #10 \(feat\/l1\), #11 .*#14 \(feat\/l5\);/,
  );
});

test("fetchRepositoryId reads repository.id and fails on GraphQL errors", () => {
  const ok = recordingRunner(() => ({ data: { repository: { id: "R_kgDO" } } }));
  assert.equal(fetchRepositoryId("acme", "widgets", ok.runner), "R_kgDO");
  assert.deepEqual(ok.requests[0]!.variables, { owner: "acme", name: "widgets" });

  const missing = recordingRunner(() => ({
    data: { repository: null },
    errors: [{ message: "Could not resolve to a Repository" }],
  }));
  assert.throws(
    () => fetchRepositoryId("acme", "nope", missing.runner),
    /Could not look up GitHub repository acme\/nope: Could not resolve/,
  );
});

test("isGraphqlEndpointBlocked matches the proxy 403 and GraphQL-unavailable messages only", () => {
  assert.equal(isGraphqlEndpointBlocked(CLAUDE_CODE_GRAPHQL_BLOCK), true);
  assert.equal(isGraphqlEndpointBlocked("gh: Forbidden (HTTP 403)"), false);
  assert.equal(isGraphqlEndpointBlocked("GraphQL endpoint returned HTTP 403"), true);
  assert.equal(isGraphqlEndpointBlocked("the GraphQL endpoint is blocked by policy"), true);
  assert.equal(isGraphqlEndpointBlocked("GraphQL API is unavailable"), true);
  assert.equal(isGraphqlEndpointBlocked("gh: Bad credentials (HTTP 401)"), false);
  assert.equal(isGraphqlEndpointBlocked("A pull request already exists for acme:feat/l2."), false);
  assert.equal(isGraphqlEndpointBlocked("Head sha can't be blank"), false);
  assert.equal(isGraphqlEndpointBlocked("gh: Bad Gateway (HTTP 502)"), false);
});

test("ghGraphql classifies blocked endpoint failures separately from ordinary failures", () => {
  const blocked = () => ({ status: 1, stderr: "GraphQL endpoint returned HTTP 403", stdout: "" });
  assert.throws(
    () => ghGraphql({ query: "query {}", variables: {} }, "/tmp", blocked),
    (err: unknown) => err instanceof GraphqlBlockedError,
  );

  for (const stderr of ["gh: Forbidden (HTTP 403)", "gh: Bad credentials (HTTP 401)", "gh: Bad Gateway (HTTP 502)"]) {
    const failed = () => ({ status: 1, stderr, stdout: "" });
    assert.throws(
      () => ghGraphql({ query: "query {}", variables: {} }, "/tmp", failed),
      (err: unknown) => err instanceof CommandError && !(err instanceof GraphqlBlockedError),
    );
  }
});

test("githubApiFromEnv forces REST only for MERGESTORM_GITHUB_API=rest", () => {
  assert.equal(githubApiFromEnv({}), "graphql");
  assert.equal(githubApiFromEnv({ MERGESTORM_GITHUB_API: "rest" }), "rest");
  assert.equal(githubApiFromEnv({ MERGESTORM_GITHUB_API: " REST " }), "rest");
  assert.equal(githubApiFromEnv({ MERGESTORM_GITHUB_API: "graphql" }), "graphql");
  assert.equal(githubApiFromEnv({ MERGESTORM_GITHUB_API: "" }), "graphql");
});

test("findOpenPrNumber over REST lists open PRs by owner:head and reads the first number", () => {
  const hit = fakeGh(() => ({ ok: true, stdout: JSON.stringify([{ number: 42 }]) }));
  assert.equal(findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "rest", gh: hit.gh }), 42);
  assert.deepEqual(hit.calls, [
    {
      args: [
        "api",
        "-X",
        "GET",
        "repos/acme/widgets/pulls",
        "-f",
        "head=acme:feat/a",
        "-f",
        "state=open",
        "-f",
        "per_page=1",
      ],
      input: undefined,
    },
  ]);

  const none = fakeGh(() => ({ ok: true, stdout: "[]" }));
  assert.equal(findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "rest", gh: none.gh }), null);

  const failed = fakeGh(() => ({ ok: false, status: 1, stderr: "gh: Not Found (HTTP 404)" }));
  assert.throws(
    () => findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "rest", gh: failed.gh }),
    /^CommandError: Failed to list PRs for feat\/a: gh: Not Found \(HTTP 404\)$/,
  );
});

test("findOpenPrNumber defaults to gh pr list and falls back to REST when GraphQL is blocked", () => {
  const graphqlOk = fakeGh(() => ({ ok: true, stdout: JSON.stringify([{ number: 5 }]) }));
  assert.equal(
    findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "graphql", gh: graphqlOk.gh }),
    5,
  );
  assert.deepEqual(graphqlOk.calls.map((c) => c.args.slice(0, 2)), [["pr", "list"]]);

  const blocked = fakeGh((args) =>
    args[0] === "pr"
      ? { ok: false, status: 1, stderr: CLAUDE_CODE_GRAPHQL_BLOCK }
      : { ok: true, stdout: JSON.stringify([{ number: 7 }]) },
  );
  assert.equal(
    findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "graphql", gh: blocked.gh }),
    7,
  );
  assert.deepEqual(blocked.calls.map((c) => c.args[0]), ["pr", "api"]);
});

test("findOpenPrNumber does not fall back to REST on an ordinary gh pr list failure", () => {
  const unauthorized = fakeGh(() => ({ ok: false, status: 1, stderr: "gh: Bad credentials (HTTP 401)" }));
  assert.throws(
    () => findOpenPrNumber("acme", "widgets", "feat/a", "/tmp", { api: "graphql", gh: unauthorized.gh }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.ok(!(err instanceof GraphqlBlockedError));
      assert.equal(err.message, "Failed to list PRs for feat/a: gh: Bad credentials (HTTP 401)");
      return true;
    },
  );
  assert.equal(unauthorized.calls.length, 1);
});

test("createPrs over REST posts one PR per call with the GraphQL payload fields, in order", () => {
  const { gh, calls } = restCreateGh();
  const prs = newPrs(3);
  assert.deepEqual(
    createPrs({ owner: "acme", repo: "rest-only", prs, api: "rest", gh, graphql: throwingGraphql(new Error("graphql must not run")) }),
    [201, 202, 203],
  );
  assert.deepEqual(
    calls.map((c) => c.args),
    Array.from({ length: 3 }, () => ["api", "-X", "POST", "repos/acme/rest-only/pulls", "--input", "-"]),
  );
  assert.deepEqual(
    calls.map((c) => JSON.parse(c.input!)),
    prs.map((pr) => ({ title: pr.title, head: pr.head, base: pr.base, body: pr.body })),
  );
});

test("createPrs over REST reports the failing PR and the PRs GitHub already opened", () => {
  const { gh } = restCreateGh({ failOnCall: 2 });
  assert.throws(
    () => createPrs({ owner: "acme", repo: "rest-fail", prs: newPrs(3), api: "rest", gh }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.equal(
        err.message,
        "Failed to open PRs feat/l2 → feat/l1: A pull request already exists for acme:feat/l2.\n" +
          "GitHub did open #201 (feat/l1); retry `mg stack submit` to reuse them.",
      );
      return true;
    },
  );

  const first = restCreateGh({ failOnCall: 1 });
  assert.throws(
    () => createPrs({ owner: "acme", repo: "rest-fail", prs: newPrs(2), api: "rest", gh: first.gh }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /^Failed to open PRs feat\/l1 → main: A pull request already exists/);
      assert.doesNotMatch(err.message, /GitHub did open/);
      return true;
    },
  );
});

test("createPrs over REST reports missing numbers and non-JSON failures", () => {
  const missingNumber = fakeGh(() => ({ ok: true, stdout: "{}" }));
  assert.throws(
    () => createPrs({ owner: "acme", repo: "rest-invalid", prs: newPrs(1), api: "rest", gh: missingNumber.gh }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.message, "Failed to open PRs feat/l1 → main: GitHub returned no pull request number");
      return true;
    },
  );

  const malformedFailure = fakeGh(() => ({
    ok: false,
    status: 1,
    stderr: "gh: request failed",
    stdout: "not json",
  }));
  assert.throws(
    () => createPrs({ owner: "acme", repo: "rest-invalid", prs: newPrs(1), api: "rest", gh: malformedFailure.gh }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.message, "Failed to open PRs feat/l1 → main: gh: request failed");
      return true;
    },
  );
});

test("createPrs falls back to REST when the GraphQL endpoint is blocked", () => {
  const { gh, calls } = restCreateGh();
  const numbers = createPrs({
    owner: "acme",
    repo: "blocked",
    prs: newPrs(2),
    api: "graphql",
    gh,
    graphql: throwingGraphql(new GraphqlBlockedError(`gh api graphql failed: ${CLAUDE_CODE_GRAPHQL_BLOCK}`)),
  });
  assert.deepEqual(numbers, [201, 202]);
  assert.equal(calls.length, 2);
});

test("createPrs keeps GraphQL-opened PRs and finishes the rest over REST when blocked mid-submit", () => {
  let call = 0;
  const graphql: GraphqlRunner = (request) => {
    call += 1;
    if (call === 1) return { data: { repository: { id: "R_mid" } } };
    if (call === 2) {
      const data: Record<string, unknown> = {};
      Object.keys(request.variables).forEach((_, i) => {
        data[`pr${i}`] = { pullRequest: { number: 10 + i } };
      });
      return { data };
    }
    throw new GraphqlBlockedError(`gh api graphql failed: ${CLAUDE_CODE_GRAPHQL_BLOCK}`);
  };
  const { gh, calls } = restCreateGh({ firstNumber: 20 });
  const prs = newPrs(7);
  assert.deepEqual(
    createPrs({ owner: "acme", repo: "blocked-mid", prs, api: "graphql", graphql, gh }),
    [10, 11, 12, 13, 14, 21, 22],
  );
  assert.deepEqual(calls.map((c) => JSON.parse(c.input!).head), ["feat/l6", "feat/l7"]);
});

test("createPrs does not fall back to REST on an ordinary GraphQL error", () => {
  const rejected = restCreateGh();
  let call = 0;
  const graphql: GraphqlRunner = () => {
    call += 1;
    if (call === 1) return { data: { repository: { id: "R_err" } } };
    return { data: null, errors: [{ message: "A pull request already exists for acme:feat/l1." }] };
  };
  assert.throws(
    () =>
      createPrs({ owner: "acme", repo: "graphql-error", prs: newPrs(1), api: "graphql", graphql, gh: rejected.gh }),
    /Failed to open PRs feat\/l1 → main: A pull request already exists/,
  );
  assert.equal(rejected.calls.length, 0);

  const transport = restCreateGh();
  assert.throws(
    () =>
      createPrs({
        owner: "acme",
        repo: "graphql-transport",
        prs: newPrs(1),
        api: "graphql",
        graphql: throwingGraphql(new CommandError("gh api graphql failed: gh: Bad credentials (HTTP 401)")),
        gh: transport.gh,
      }),
    /Bad credentials/,
  );
  assert.equal(transport.calls.length, 0);
});

test("runGh returns structured failure for unknown subcommand", () => {
  const res = runGh(["this-subcommand-does-not-exist-xyz"]);
  // gh may be missing in CI; either ENOENT-style or non-zero is fine
  if (res.ok) {
    assert.fail("expected unknown gh subcommand to fail");
  }
  assert.ok(typeof res.stderr === "string");
});

test("runGh forwards stdin and preserves stdout on failure", () => {
  const res = runGh(["api", "--input", "-"], "/tmp", "payload", (_command, args, options) => {
    assert.deepEqual(args, ["api", "--input", "-"]);
    assert.equal(options.cwd, "/tmp");
    assert.equal(options.input, "payload");
    return { status: 1, stderr: "request failed", stdout: '{"message":"details"}' };
  });
  assert.deepEqual(res, {
    ok: false,
    status: 1,
    stderr: "request failed",
    stdout: '{"message":"details"}',
  });
});

test("requireGh throws CommandError when gh is unusable", () => {
  // Smoke: if gh works in this environment, requireGh should not throw.
  // If gh is missing, it must throw CommandError (not a raw Error).
  try {
    requireGh();
  } catch (err) {
    assert.ok(err instanceof CommandError);
    assert.match(err.message, /gh/i);
  }
});
