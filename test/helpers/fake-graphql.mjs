// A fake `octokit.graphql` for the review fetcher's three queries: the PR
// list (`pullRequests`), batches of aliased `pullRequest(number:)` lookups,
// and the per-PR follow-up for more than 50 reviews.
//
// `prs`: newest-updated first, each { number, title, updatedAt, author,
// reviews: [{ id, author, state, body, submittedAt, url }] }.
// `onCall(query, vars)` runs first (count, tick a clock, or throw).

const conn = (list, after, size) => {
  const start = after ? Number(after) : 0;
  const nodes = list.slice(start, start + size);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: String(end) } };
};

export function fakeGraphQL(prs, { onCall } = {}) {
  const calls = [];
  const graphql = async (query, vars = {}) => {
    calls.push({ query, vars });
    await onCall?.(query, vars);
    const idField = query.includes("fullDatabaseId") ? "fullDatabaseId" : "databaseId";
    const review = (r) => ({ [idField]: String(r.id), url: r.url, state: r.state, body: r.body, submittedAt: r.submittedAt, author: r.author });
    const reviewsOf = (pr, after, size) => {
      const c = conn(pr.reviews, after, size);
      return { ...c, nodes: c.nodes.map(review) };
    };
    if (query.includes("pullRequests(")) {
      const size = Number(query.match(/pullRequests\(first: (\d+)/)[1]);
      const page = conn(prs, vars.after, size);
      return {
        repository: {
          pullRequests: {
            pageInfo: page.pageInfo,
            nodes: page.nodes.map((p) => ({ number: p.number, title: p.title, updatedAt: p.updatedAt, author: p.author })),
          },
        },
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      };
    }
    if (vars.number !== undefined) {
      const pr = prs.find((p) => p.number === vars.number);
      return { repository: { pullRequest: { reviews: reviewsOf(pr, vars.after, 100) } } };
    }
    const size = Number(query.match(/reviews\(first: (\d+)/)[1]);
    const repository = {};
    for (const [, alias, number] of query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) {
      const pr = prs.find((p) => p.number === Number(number));
      repository[alias] = pr ? { number: pr.number, reviews: reviewsOf(pr, null, size) } : null;
    }
    return { repository };
  };
  return { graphql, calls };
}

export const isBatch = (call) => /p0: pullRequest\(number:/.test(call.query);
export const isList = (call) => call.query.includes("pullRequests(");
