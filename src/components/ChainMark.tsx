import { CHAIN } from '../config/chains'

// Chain identity marks, each the network's own, inlined so the page stays
// self-contained under CSP — the same treatment the venue marks get in
// ProtoBadge. A chain with no art here simply renders nothing: the name beside
// it has always been what actually says which chain this is.

/**
 * BNB Chain's mark, paths verbatim from the icon rainbowkit already ships for
 * chain 56. Its wrapping <g clip-path> and the <defs> behind it are dropped:
 * the clip was a full-canvas rect, and inlining the same `id="a"` at every
 * mark on the page is an id collision for a clip that clipped nothing.
 */
function BnbMark() {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path fill="#F0B90B" fillRule="evenodd" d="M14 0c7.733 0 14 6.267 14 14s-6.267 14-14 14S0 21.733 0 14 6.267 0 14 0Z" clipRule="evenodd" />
      <path fill="#fff" d="m7.694 14 .01 3.702 3.146 1.85v2.168l-4.986-2.924v-5.878L7.694 14Zm0-3.702v2.157l-1.832-1.083V9.214l1.832-1.083 1.841 1.083-1.84 1.084Zm4.47-1.084 1.832-1.083 1.84 1.083-1.84 1.084-1.832-1.084Z" />
      <path fill="#fff" d="M9.018 16.935v-2.168l1.832 1.084v2.157l-1.832-1.073Zm3.146 3.394 1.832 1.084 1.84-1.084v2.157l-1.84 1.084-1.832-1.084V20.33Zm6.3-11.115 1.832-1.083 1.84 1.083v2.158l-1.84 1.083v-2.157l-1.832-1.084Zm1.832 8.488.01-3.702 1.831-1.084v5.879l-4.986 2.924v-2.167l3.145-1.85Z" />
      <path fill="#fff" d="m18.982 16.935-1.832 1.073v-2.157l1.832-1.084v2.168Z" />
      <path fill="#fff" d="m18.982 11.065.01 2.168-3.155 1.85v3.712l-1.831 1.073-1.832-1.073v-3.711l-3.155-1.851v-2.168l1.84-1.083 3.135 1.86 3.155-1.86 1.84 1.083h-.007Zm-9.964-3.7 4.977-2.935 4.987 2.935-1.832 1.083-3.154-1.86-3.146 1.86-1.832-1.083Z" />
    </svg>
  )
}

/** Robinhood's feather, 732 B webp — the chain ships no vector mark */
const RH_ICON = 'data:image/webp;base64,UklGRtQCAABXRUJQVlA4IMgCAADQEACdASpAAEAAPj0cjEQiIaESDAVsIAPEsQBnku0/VfwA2G33OGBfRPtg3hT+gboD9Zv1A4QD9QOAA/YD0b/7t/gPgG/Xn9ePZeuTXJEnuP3XMzY0poz2pa80bNZ9F+wJ/Jf6T/ouAz/YAoBd9xUzweCxL/jv1Of11Ne3AZVQpaat61TVhPtWx6tSNRo0AAD++9njyB//fIH/98gf3x3mTcjLT8h/4PP5ePfNqytBuX3MUH49rT87MtWf/69qa2lYfnU2ALOq/286HnKv5kqxrEk9bj/8G2eYs8eebiIH+kWECTrWSlI/nJxi0cL8a855m7avzPRuBj/AVFaNV/5rsd7G/qWIdxm257KjvcIKlyQkCtIZV23M+aLI6AjvqY4wimSTaXyXO1F78Ig27QeetQ2t01H/2ElcgVx77emZSd44F7bf7EBR/sPftirCuPNCX7QmlJUe0EWL54WVulD4nYv/4NfzesuUBwSmWP/15AfX9UEO5c3hUPVDA+VOBHgHa0WRX1IY+J9vf8JPsZFOq39Y/28k1cCv/LYFRL8dl/SXIkpoCXk2gkcWUF3TyF3aQpj2hcZrmO8iNBY3HE6F6pv5m8GTKNzhUsZIX8Lb70OTk4zWS7fQo53h67kn6P4mD49IFpncruNuPrKqHbo2Gc1CQA0PYN8P9y7ymRbSKMH/IM3jfvnNvx35mnq38RlDneK3flL3R7BexVZEPZJz3P08gt/4efdqM/hpQlaJVY3hHJXZLhbPCm7Q3zuUr3ja7S6t230CtqXY/GPPqZ+tE7vtoIKvpesR05EtKuvy72bWyTX/jt8Nfd7T0gQz8oXwu57VS+CkGLdSfefwW7syZPqxnkl+xy7SwA1ETrgSL6HTm30H02QE7/sp9onFGGgn3cx/TzOahmNheP+8z7iH/LJjf9+8pwWhQA7hf/+t7jvO05AAAAAA'

function RobinhoodMark() {
  return <img src={RH_ICON} alt="" aria-hidden="true" />
}

const CHAIN_MARK: Record<string, () => JSX.Element> = {
  bsc: BnbMark,
  robinhood: RobinhoodMark,
}

/** the mark for a chain key, or nothing where that chain has none */
export function ChainMark({ chain }: { chain: string }) {
  const Mark = CHAIN_MARK[chain]
  return Mark ? (
    <span className="chain-mark">
      <Mark />
    </span>
  ) : null
}

/** the ACTIVE chain's mark — what the header button wears */
export function ActiveChainMark() {
  return <ChainMark chain={CHAIN.key} />
}
