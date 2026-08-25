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
    id: '2026-08-24-retained-profit-withdrawals',
    date: '2026-08-24',
    tag: 'new',
    title: { en: 'Retained LP profit is now withdrawable', zh: 'LP 留存利润现在可以提取' },
    items: [
      {
        en: 'Withdraw all retained profit from a strategy as USDG, WETH or native ETH without touching principal carry or parked fees.',
        zh: '现在可以把策略的全部留存利润结算为 USDG、WETH 或原生 ETH；本金余量和暂存手续费不会被动用。',
      },
      {
        en: 'Each withdrawal and the cumulative total stay visible, while lifetime P/L continues from the same original baseline.',
        zh: '每次提取和累计提取都会保留展示；累计盈亏仍沿用原始本金基线，不会因资金离开策略钱包而被重置。',
      },
    ],
  },
  {
    id: '2026-08-24-durable-lp-recommendations',
    date: '2026-08-24',
    tag: 'fix',
    title: { en: 'LP recommendations stopped chasing hot hours', zh: 'LP 推荐不再追逐短时暴涨' },
    items: [
      {
        en: 'A hot one-hour volume burst can no longer be projected across the next full day. Longer windows, reversal stress and the cost of repeated recenters now decide whether an LP is worth opening.',
        zh: '单个小时的成交暴增不会再直接外推成全天收益；系统会用更长窗口、反转压力和重复重开成本判断是否值得开单。',
      },
      {
        en: 'The page now shows one Best LP Now across fees and rewards—or clearly says that no LP passes the opening gates.',
        zh: '页面会在手续费与排放候选中直接给出一个“当前首选”；如果没有 LP 通过开单门槛，也会明确提示暂时不要开单。',
      },
    ],
  },
  {
    id: '2026-08-23-dual-pnl-units',
    date: '2026-08-23',
    tag: 'new',
    title: { en: 'P/L now has two points of view', zh: '盈亏现在支持两种计量口径' },
    items: [
      {
        en: 'Switch strategy P/L between the original quote-token result and stablecoin value. A position can now show a USDG profit even when its WETH amount declined.',
        zh: '策略盈亏可在原有报价币口径和稳定币价值口径之间一键切换；即使 WETH 数量减少，只要 USDG 价值上涨，也会正确显示为盈利。',
      },
      {
        en: 'The same preference follows you into strategy history and the daily P/L calendar.',
        zh: '同一口径设置会同步应用到历史策略和每日盈亏日历。',
      },
    ],
  },
  {
    id: '2026-08-17-lp-profit-protection',
    date: '2026-08-17',
    tag: 'new',
    title: { en: 'LP profits now stay protected', zh: 'LP 盈利现在会自动留存' },
    items: [
      {
        en: 'Once a strategy has at least 10 USDG of new profit, the next rebalance keeps the excess out of the replacement position instead of putting everything back at risk.',
        zh: '策略新增盈利达到 10 USDG 后，下次再平衡会把超出本金的部分留存，不再把全部资金重新投入风险区间。',
      },
      {
        en: 'A quick boundary hit only widens the next range when the strategy is losing and the previous cycle fees did not cover its costs.',
        zh: '快速触边后，只有策略仍在亏损且上一轮手续费不足以覆盖成本时，下一轮才会扩大区间。',
      },
      {
        en: 'An expanded range is reviewed after six hours and narrows gradually only after two calm in-range hours, profit recovery, and enough fees to cover the previous cycle costs with a safety margin.',
        zh: '扩大后的区间会在 6 小时后进入收窄检查；只有最近 2 小时持续在区间内且波动回落、盈利恢复、手续费也留足上一轮成本的安全余量后，才会逐级收窄。',
      },
    ],
  },
  {
    id: '2026-08-15-lp-recommendations',
    date: '2026-08-15',
    tag: 'new',
    title: { en: 'LP recommendations have their own page', zh: 'LP 推荐现在有独立页面了' },
    items: [
      {
        en: 'See three ranked LP choices at a time. Strict recommendations come first, and watchlist candidates explain exactly why they did not pass the opening threshold.',
        zh: '每次展示 3 个排序后的 LP；正式推荐优先，观察候选会明确说明尚未达到开仓门槛的原因。',
      },
      {
        en: 'Open any choice in Pools with its exact range and model capital already filled in.',
        zh: '可以把任一候选带入池子页，精确区间和模型投入会自动填好。',
      },
    ],
  },
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
