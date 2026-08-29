// Which chain the terminal is showing — the user's choice, carried in the URL
// and remembered per-browser.
//
// A switch is a page LOAD, not a re-render. Every address, ABI target, fee
// ladder and transport in the app is a module constant derived from one answer
// read at startup (config/chains/index.ts), so nothing downstream has to be
// reactive and nothing can end up half-switched. rpcPref.ts holds the same
// contract for the same reason. That is also why the selector is a link rather
// than a handler — see the note at the bottom of this file.
//
// The URL leads storage, so a link names its own chain: send someone
// `?chain=bsc#positions` and they land where you did, whatever their browser
// remembers.
//
// This module knows nothing about which chains exist. It moves a string between
// the address bar, storage and a link; config/chains decides whether that string
// means anything. Keeping it ignorant is what lets the config module import it
// without a cycle.

const CHAIN_PARAM = 'chain'
const KEY = 'up33.chain.v1'

const browser = (): boolean => typeof window !== 'undefined'

/** the chain a query string names, or '' — pure, so the URL rules stay testable */
export function chainKeyIn(search: string): string {
  try {
    return (new URLSearchParams(search).get(CHAIN_PARAM) ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * The same-origin link pointed at another chain. The path, every other param
 * and the hash survive, so switching keeps you on the page and tab you were
 * reading.
 *
 * `set`, never append — switching twice must not stack two `chain=` params,
 * where `URLSearchParams.get` would then answer with the stale first one.
 */
export function chainHref(key: string, from: string): string {
  try {
    const u = new URL(from)
    u.searchParams.set(CHAIN_PARAM, key)
    return u.toString()
  } catch {
    // `from` was not an absolute URL. The selector only ever renders in a
    // browser, where location.href always is one, so this is the shape of a
    // caller mistake — answer with a link that still names the chain rather
    // than throwing inside a render.
    return `?${CHAIN_PARAM}=${encodeURIComponent(key)}`
  }
}

/**
 * The same link, rehosted on another deployment's origin.
 *
 * For a chain this deployment cannot serve: both origins run this same app, so
 * the path, the other params and the hash all still mean what they meant, and
 * the reader lands on the tab they were on — with a catalog behind it.
 */
export function chainHrefOn(origin: string, key: string, from: string): string {
  try {
    const target = new URL(origin)
    const u = new URL(from)
    u.protocol = target.protocol
    // Assign hostname and port separately. Setting `host` to a value without a
    // port does not reliably clear the source URL's explicit development port
    // after a protocol change (`http://127.0.0.1:5173` used to become the
    // invalid `https://lp-terminal.xyz:5173`).
    u.hostname = target.hostname
    u.port = target.port
    u.searchParams.set(CHAIN_PARAM, key)
    return u.toString()
  } catch {
    // Either argument can be the malformed one. A link that still names the
    // chain on the right origin beats throwing inside a render.
    return `${origin.replace(/\/+$/, '')}/?${CHAIN_PARAM}=${encodeURIComponent(key)}`
  }
}

/** the chain this page's own URL names, or '' */
export function urlChainKey(): string {
  return browser() ? chainKeyIn(window.location.search) : ''
}

/** the chain this browser last had a choice about, or '' */
export function storedChainKey(): string {
  if (!browser()) return ''
  try {
    return (localStorage.getItem(KEY) ?? '').trim()
  } catch {
    return ''
  }
}

/** remember a chain for the next bare visit. Call with a RESOLVED key — never
 *  with the raw query value, or a typo in a link outlives the link. */
export function rememberChain(key: string): void {
  if (!browser()) return
  try {
    localStorage.setItem(KEY, key)
  } catch {
    /* storage unavailable — the URL still carries the choice */
  }
}

/**
 * Make the address bar name the chain, so any link copied out of it does too.
 *
 * Only ever called for a chain someone CHOSE (main.tsx). Writing a defaulted
 * chain here would fabricate a choice the user never made: the next load reads
 * `?chain=` back as a link and remembers it.
 */
export function showChainInUrl(key: string): void {
  if (!browser()) return
  const href = chainHref(key, window.location.href)
  if (href !== window.location.href) history.replaceState(history.state, '', href)
}

// There is no switch() here on purpose. The selector renders `chainHref` as a
// plain <a href> (components/ChainControl.tsx), which navigates, gives Back its
// obvious meaning, and lets a middle-click open the other chain in a second tab
// — two chains side by side being the thing a switcher is for. Persistence rides
// the next page load: the href names the chain, and main.tsx remembers it.
