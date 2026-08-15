/**
 * The Graph gateway, reached same-origin so the API key stays server-side.
 *
 * Unlike DexScreener or Kyber, this upstream is AUTHENTICATED and metered — the
 * free tier is 100k queries a month — so there is no browser-direct mode to
 * fall back to. The key would have to be in the bundle for one to exist, and a
 * key in the bundle is a key anyone can spend. So the path is always relative:
 * `/thegraph` in dev (vite proxy) and in production (nginx), each attaching the
 * Authorization header on the server side. Serving `dist/` from a plain static
 * server means these calls 404, and every caller degrades rather than failing.
 *
 * What that metering implies for callers: this answers WHICH — which token ids,
 * which pools — and callers cache those answers aggressively, while the chain
 * answers executable state. A subgraph read on every UI refresh would cost
 * ~172k queries a month for a single always-open view.
 */
const BASE = '/thegraph'

/** a specific deployment, addressed by its IPFS hash (`Qm…`) */
export function deploymentUrl(ipfsHash: string): string {
  return `${BASE}/api/deployments/id/${ipfsHash}`
}

/** a published subgraph, addressed by its subgraph id */
export function subgraphUrl(id: string): string {
  return `${BASE}/api/subgraphs/id/${id}`
}

export class GraphError extends Error {}

/**
 * One GraphQL query. Throws on transport failure, on a GraphQL `errors` array,
 * and on a missing `data` — so a caller that catches gets the same "no answer"
 * it would get from an unreachable gateway, rather than a half-filled object.
 *
 * Note entity ids in a subgraph are LOWERCASE. A checksummed address in a
 * `where` filter matches nothing and returns an empty list, which reads exactly
 * like "this wallet holds none".
 */
export async function graphQuery<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs = 12_000,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new GraphError(`thegraph ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] }
  if (body.errors?.length) {
    throw new GraphError(body.errors.map((e) => e.message ?? '?').join('; ').slice(0, 200))
  }
  if (!body.data) throw new GraphError('thegraph returned no data')
  return body.data
}
