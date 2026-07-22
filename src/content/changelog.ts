// The WHAT'S NEW feed. This is the ONE file to edit when shipping something a
// user would notice — the header button reads it directly, and an entry lights
// the red dot while it is younger than two days (see src/lib/news.ts).
//
// House rules:
//   - newest first; `id` is stable and never reused (it is the React key)
//   - `date` is the ship date, ISO YYYY-MM-DD, parsed as UTC
//   - write from the user's side: what changed for them, never how it works.
//     No baselines, no engines, no milliseconds, no bps — "0.09%", not "9 bps"
//   - internal work never appears here: quote-scoring changes, the indexer,
//     refactors, deploys. But a user-visible OUTCOME does belong — "you get a
//     better price now" is fair game; naming the engine that did it is not
//   - don't advertise a fee level. Fees move, and the feed is not the place
//     users should be reading them off
//   - both languages are required, so half a translation can't ship

export type NewsTag = 'new' | 'fix' | 'perf'

/** one string, both locales — the popover picks by the active language */
export type Bilingual = { en: string; zh: string }

export type NewsEntry = {
  id: string
  date: string
  tag: NewsTag
  title: Bilingual
  items: Bilingual[]
}

export const CHANGELOG: NewsEntry[] = [
  {
    id: '2026-07-22-sheriff',
    date: '2026-07-22',
    tag: 'new',
    title: {
      en: 'SHEEP CHOICE now supports Sheriff, GigaDex, Sushi, and RobinSwap',
      zh: 'SHEEP CHOICE 接入 Sheriff、GigaDex、Sushi 和 RobinSwap',
    },
    items: [
      {
        en: 'Liquidity from Sheriff, GigaDex, Sushi, and RobinSwap now joins SHEEP CHOICE routes, giving eligible swaps more paths to a better return.',
        zh: 'Sheriff、GigaDex、Sushi 和 RobinSwap 的流动性现已加入 SHEEP CHOICE 路由，为符合条件的兑换提供更多更优路径。',
      },
    ],
  },
  {
    id: '2026-07-20-state-persistence',
    date: '2026-07-20',
    tag: 'fix',
    title: { en: 'Your settings stay put', zh: '设置不会被刷没了' },
    items: [
      {
        en: 'Refresh the page — your filters, your sorting and any swap still in flight are all where you left them.',
        zh: '刷新页面后，筛选、排序、以及正在进行的兑换都还在原处。',
      },
    ],
  },
  {
    id: '2026-07-20-better-quotes',
    date: '2026-07-20',
    tag: 'fix',
    title: { en: 'Sharper swap quotes', zh: '兑换报价更准' },
    items: [
      {
        en: 'Tokens that tax their own transfers are quoted honestly now, instead of quietly coming out wrong.',
        zh: '带转账税的代币现在会给出诚实的报价，不再悄悄算偏。',
      },
    ],
  },
  {
    id: '2026-07-19-sheep-choice',
    date: '2026-07-19',
    tag: 'new',
    title: { en: 'SHEEP CHOICE — our own swap is live', zh: 'SHEEP CHOICE 上线 —— 我们自己的兑换' },
    items: [
      {
        en: 'The terminal has a swap of its own now, quoting right alongside the other venues.',
        zh: '终端有了自己的兑换，和其他场所并排报价。',
      },
      {
        en: 'It can split one trade across several pools instead of forcing it down a single path — and draws the split leg by leg.',
        zh: '它能把一笔交易拆到多个池子里成交，而不是硬走一条路 —— 怎么拆的，逐段画给你看。',
      },
      {
        en: 'Whichever venue hands you the most is picked for you, and you can always take another yourself.',
        zh: '谁给得多就自动选谁，你也可以自己挑另一条。',
      },
    ],
  },
  {
    id: '2026-07-19-zap-any-token',
    date: '2026-07-19',
    tag: 'new',
    title: { en: 'Add liquidity with any token', zh: '任意代币都能一键建仓' },
    items: [
      {
        en: 'Holding the wrong token? Add liquidity with it anyway — whatever needs swapping is done for you.',
        zh: '手里不是配对的那两种代币也没关系，直接建仓，该换的会替你换好。',
      },
      {
        en: 'Uniswap V2 liquidity sitting in your wallet now shows up under POSITIONS.',
        zh: '钱包里的 Uniswap V2 流动性现在会显示在「仓位」里。',
      },
    ],
  },
  {
    id: '2026-07-18-bridge-v2',
    date: '2026-07-18',
    tag: 'new',
    title: { en: 'Bring funds in from other chains', zh: '从其他链把资金转进来' },
    items: [
      {
        en: 'Three routes are priced side by side and sorted by what actually reaches you — pick the best one.',
        zh: '三条跨链通道同时比价，按实际到手的金额排序，挑最多的那条即可。',
      },
      { en: 'No extra fee on any of them.', zh: '任何一条都不额外收费。' },
      {
        en: 'While it is on the way you get a countdown, and the terminal tells you when the funds land.',
        zh: '资金在路上时有倒计时，到账后终端会告诉你。',
      },
    ],
  },
]
