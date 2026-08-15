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

export type NewsTag = "new" | "fix" | "perf";

/** one string, both locales — the popover picks by the active language */
export type Bilingual = { en: string; zh: string };

export type NewsEntry = {
  id: string;
  date: string;
  tag: NewsTag;
  title: Bilingual;
  items: Bilingual[];
};

export const CHANGELOG: NewsEntry[] = [
  {
    id: "2026-08-14-wide-slippage-confirm",
    date: "2026-08-14",
    tag: "new",
    title: {
      en: "Slippage above 10% now takes a second press",
      zh: "滑点高于 10% 时要按两次才会执行",
    },
    items: [
      {
        en: "When the slippage on a swap or a zap is above 10%, the button asks once more before anything reaches your wallet to sign. It names the percentage you are about to accept, and on a swap it also tells you the smallest amount that trade could still settle for.",
        zh: "兑换或 ZAP 的滑点高于 10% 时，在把交易递给钱包签名之前，按钮会再问一次。它会写明你即将接受的滑点；兑换还会告诉你这笔交易最少可能只成交到多少。",
      },
      {
        en: "The confirmation is tied to the number you saw. If the price moves and the tolerance changes while you are reading it, or you change the trade, the button goes back to asking — a yes given at one number carries over to that number alone.",
        zh: "这次确认只对你当时看到的那个数字有效。如果在你阅读的这段时间里价格变动、容差跟着变了，或者你改了这笔交易，按钮会重新询问——在某个数字上点下的确认，只对那个数字有效。",
      },
    ],
  },
  {
    id: "2026-08-14-route-map-readable",
    date: "2026-08-14",
    tag: "fix",
    title: {
      en: "The route picture is readable on a route that goes everywhere",
      zh: "路径图在很复杂的路线上也读得下去了",
    },
    items: [
      {
        en: "A trade that reaches its output through many tokens now names the few that carry it — each one big enough to be a landmark — and gathers the rest into one waypoint that says how many it stands for. Seven token chips used to print down the middle of the picture, over the flows they were meant to be labelling.",
        zh: "一笔交易要经过很多种代币才能换到目标币时，现在只标出其中份额大到足以当路标的几种，其余的合并成一个中转点，并写明它代表多少种。以前会有七个代币标签压在图的正中间，盖住它们本该标注的那些流。",
      },
      {
        en: "Every path the trade takes is now drawn on its own, as thin as its share. Small paths used to be gathered into one summary band; a path carrying three tenths of a percent is a hairline you can point at, and the hover card tells you which pool it is.",
        zh: "交易走的每一条路径现在都单独画出来，份额多小就画多细。以前小额路径会被合并成一条汇总带；现在承载千分之三的那条就是一根细线，把鼠标放上去就知道它是哪个池子。",
      },
      {
        en: "The picture is always the same height. It used to grow and shrink with how many paths the route had, so a price refresh could resize the panel under your hand.",
        zh: "这张图的高度固定了。以前它会随路径条数变高变矮，报价一刷新，面板就在你手底下改变大小。",
      },
      {
        en: "Two labels can no longer print through each other. Where there is room for one name, the larger flow keeps it; the fee line is the first thing given up, and any flow that loses its name still carries it in the hover card.",
        zh: "两个标签不会再互相压在一起。位置只够写一个名字时，份额更大的那条留下名字；先让出的是费率那一行；名字被让出的那条流，悬停卡片里仍然写着它。",
      },
      {
        en: "A venue's name is written out wherever the picture has room for it. A name used to be cut short to clear the next stage of the route even when nothing stood there at the height the label sat, so PANCAKE V3 arrived as PANCAK… with clear space beside it.",
        zh: "只要图里有位置，场所的名字就完整写出来。以前名字会为了给路线的下一段让路而被截断，哪怕在标签所在的高度上那里空无一物，于是 PANCAKE V3 就成了 PANCAK…，旁边还空着一大片。",
      },
      {
        en: "A path that has to climb across the picture keeps its curve. A steep one used to flatten into a sharp corner where it left one token and another where it arrived.",
        zh: "需要在图里大幅爬升的路径保留了弧度。以前陡的路径会被压平，在出发和到达的两端各留下一个尖角。",
      },
      {
        en: "Token chips are sized to the name they carry, and PancakeSwap's two versions now sit in the same colour family so the two busiest venues on a BNB Chain route read as relatives.",
        zh: "代币标签的宽度按里面的文字来定。PancakeSwap 的两个版本也改用同一色系——在 BNB 链的路线上，这两个最忙的场所看起来就是一家的。",
      },
    ],
  },
  {
    id: "2026-08-14-swap-submission-guards",
    date: "2026-08-14",
    tag: "fix",
    title: {
      en: "A swap stays with the account that started it",
      zh: "兑换会一直跟着发起它的那个账户",
    },
    items: [
      {
        en: "Switching accounts in your wallet part-way through a swap — during an approval, or while the final price is being fetched — now stops the swap and tells you why. It could previously carry on, leaving the newly selected account paying for tokens delivered to the previous one.",
        zh: "兑换进行到一半时（正在授权，或正在取最终报价）在钱包里切换账户，现在会停下来并说明原因。以前它可能继续走完，结果是新账户付钱、代币发到上一个账户。",
      },
      {
        en: "When a transaction has been sent and the connection drops before it confirms, the activity log says it was sent and is still unconfirmed, and keeps the link to follow it. It used to be marked failed, which reads as an invitation to send the same trade twice.",
        zh: "交易已经发出、但在确认之前连接断开时，活动记录会写明「已发出、仍未确认」，并保留可以追踪的链接。以前这里会标成失败，看起来像是在提示你把同一笔交易再发一次。",
      },
      {
        en: "A swap the chain turns down now refreshes the price and lifts the automatic tolerance before you try again, the same way a swap stopped before signing already did. Pressing SWAP a second time used to hand back the exact numbers that had just failed.",
        zh: "被链上拒绝的兑换，现在会先刷新报价、抬高自动容忍度，再让你重试——和签名前就被拦下的那种情况一致。以前再按一次 SWAP，拿到的还是刚刚失败的那组数字。",
      },
    ],
  },
  {
    id: "2026-08-14-swap-panel-steady",
    date: "2026-08-14",
    tag: "fix",
    title: {
      en: "The swap panel opens ready and stops jumping",
      zh: "兑换面板一打开就能用，也不再跳动了",
    },
    items: [
      {
        en: "The form now opens with a pair already in both boxes, so you can start typing the moment the page appears instead of waiting on a list.",
        zh: "打开时两个框里已经有币了，页面一出现就能直接输入金额，不用再等列表加载。",
      },
      {
        en: "Prices refresh on a timer, and while a new one is on its way the panel keeps its shape. The route picture and the details rows used to vanish and come back every few seconds, sliding the SWAP button 273px up and down under your finger.",
        zh: "报价会定时刷新，新报价还在路上时，面板会保持原来的高度。以前路径图和明细每隔几秒就会消失再出现，把 SWAP 按钮在你手指底下上下挪动 273 像素。",
      },
      {
        en: "While the best route is still being searched, that card now says so instead of showing a blinking cursor.",
        zh: "还在搜索最优路径时，那张卡片会直接说明它在做什么，而不是只闪一个光标。",
      },
      {
        en: "Cost and the optimality proof are stated once, in DETAILS. The route cards keep what they are for: how much each venue pays out, and how far behind the best it is.",
        zh: "成本和最优性证明只在「明细」里说一次。路径卡片专心做它该做的事：每个场所能给你多少，以及比最优差多少。",
      },
    ],
  },
  {
    id: "2026-08-13-route-map-flows",
    date: "2026-08-13",
    tag: "new",
    title: {
      en: "The route picture now flows",
      zh: "路径图现在会流动了",
    },
    items: [
      {
        en: "Each path curves from where it starts to where it lands, and is as thick as the share of your trade it carries — so a split that comes back together reads as one shape instead of as separate stripes.",
        zh: "每条路径从出发的地方弯到落脚的地方，粗细就是它承担的那部分交易——分出去又汇回来的走法，现在看起来是一个整体，而不是几条各走各的横条。",
      },
      {
        en: "A token your trade passes through is drawn as a bar sized by how much actually goes through it. A token only part of the trade touches is now visibly short, instead of looking like the road everything took.",
        zh: "中途经过的代币画成一根竖条，高度就是真正流经它的量。只有一部分交易经过的代币现在明显更短，而不是看着像所有钱都走了那条路。",
      },
      {
        en: "Hover any flow to light it up and read its venue, fee, share and pool; hover a token to light everything passing through it.",
        zh: "把鼠标停在任意一条路径上，它会亮起来并显示场所、费率、占比和池子地址；停在代币上，则会点亮所有经过它的路径。",
      },
    ],
  },
  {
    id: "2026-08-13-long-token-names",
    date: "2026-08-13",
    tag: "fix",
    title: {
      en: "A long token name stays in its column",
      zh: "长代币名不再撑开列宽",
    },
    items: [
      {
        en: "One market whose token carries a very long name used to widen the name column until TVL, volume and APR were pushed off the right of the screen — for every row, not just that one. Long names are now shortened with a … and the numbers stay where they are.",
        zh: "只要有一个市场的代币名字特别长，名称列就会一直变宽，把 TVL、成交量、APR 挤出屏幕右边——而且是所有行都受影响，不只是那一行。现在过长的名字会用 … 收尾，右边的数字留在原地。",
      },
      {
        en: "Chinese, Japanese and Korean names are measured by the room they actually take on screen, so they are shortened at the same visible width as an English one.",
        zh: "中日韩的名字按它们在屏幕上实际占的宽度来算，所以和英文名收在同样的可见宽度。",
      },
      {
        en: "Hover a shortened name to read it in full, and the card behind a pair still shows both names and their addresses.",
        zh: "把鼠标停在被收短的名字上就能看到完整的，点开配对后面的卡片仍然能看到两个名字和它们的地址。",
      },
    ],
  },
  {
    id: "2026-08-08-lp-amounts-follow-range",
    date: "2026-08-08",
    tag: "fix",
    title: {
      en: "Providing liquidity: the amounts keep up with the range",
      zh: "提供流动性：数量会自己跟上区间",
    },
    items: [
      {
        en: "Move a range and the deposit keeps the size you gave it — only the split between the two tokens changes. Widening a range used to quietly ask for several times the money.",
        zh: "挪动区间时，这笔钱的大小保持不变——变的只是两个代币之间的比例。以前把区间拉宽，它会悄悄要走好几倍的钱。",
      },
      {
        en: "Carrying a range across the current price no longer leaves the deposit sitting on the token that range cannot take. That looked fine on screen and then failed when you pressed mint.",
        zh: "把区间挪到当前价格的另一侧时，这笔钱不会再留在这个区间收不了的那个币上。以前那个状态在屏幕上看着正常，点「铸造仓位」时才失败。",
      },
      {
        en: "MAX fills the largest position both of your balances can actually fund, so what it puts in the boxes is something you can mint.",
        zh: "MAX 现在填的是两边余额真正撑得起的最大仓位，填进去的数字是能铸出来的。",
      },
      {
        en: "When a range change pushes one side past your balance, the line saying so is now the way out of it: tap it and both amounts come down to fit.",
        zh: "如果换了区间之后有一边超出余额，那句提示本身就是解法：点一下，两个数量一起缩到刚好。",
      },
    ],
  },
  {
    id: "2026-08-08-phone-trade-sheet",
    date: "2026-08-08",
    tag: "new",
    title: {
      en: "A phone-sized trade panel, and a quieter range picker",
      zh: "手机上的交易面板，和更安静的区间选择",
    },
    items: [
      {
        en: "On a phone, picking a market opens trading and liquidity in a panel over the list. The market list keeps the screen behind it, and the search and filters step aside while you are in there.",
        zh: "在手机上点开一个市场，兑换和提供流动性会在列表上方打开。列表留在它后面，搜索和筛选会在此期间让开位置。",
      },
      {
        en: "The market you picked is parked at the top of what is left visible, with the rest of the list under it to compare against.",
        zh: "你点的那一行会停在剩余可见区域的顶部，下面接着列表的其他行，方便对照。",
      },
      {
        en: "Choosing a range is one control now: the six widths sit together as a single group, and one-sided, custom width and raw ticks fold behind one button that names whichever is in use.",
        zh: "选区间现在是一个控件：六种宽度合成一组，单边、自定义幅度和 tick 收进一个按钮里，按钮上写着当前正在用的那种。",
      },
      {
        en: "The two prices under the range chart can be typed into. Tap one and enter the bound you want instead of dragging to it.",
        zh: "区间图下面的两个价格可以直接输入。点一下，把想要的边界打进去，不必拖到那里。",
      },
    ],
  },
  {
    id: "2026-08-05-robinhood-v4-markets",
    date: "2026-08-05",
    tag: "new",
    title: {
      en: "Robinhood: Uniswap v4 markets, and the launches behind them",
      zh: "Robinhood：Uniswap v4 市场，以及它们背后的新币",
    },
    items: [
      {
        en: "POOLS is now a market list with the trade panel beside it — pick a market on the left and trade it on the right, keeping the row you were comparing against in view.",
        zh: "「池子」页现在是一张市场表，交易面板就在旁边——左边选市场，右边直接交易，你正在对比的那一行始终留在视野里。",
      },
      {
        en: "Uniswap v4 markets on Robinhood Chain are open: browse them, search by pair, symbol, address or pool id, and trade or provide liquidity.",
        zh: "Robinhood 链上的 Uniswap v4 市场已开放：可浏览、按交易对 / 符号 / 地址 / 池 ID 搜索，并进行交易或提供流动性。",
      },
      {
        en: "A token launched on pools.trade carries a mark the chain itself proves, so a copy wearing the same name and the same picture is told apart at a glance. Narrow the list to those markets, or to one launch generation.",
        zh: "在 pools.trade 上发行的代币会带一个由链本身证明的标识，同名同图的仿冒品一眼可辨。你可以把列表筛到这些市场，也可以再筛到某一代发售。",
      },
      {
        en: "Tokens show the picture their own contract publishes; where there is none, lettering stands in.",
        zh: "代币显示的是它自己合约里公布的图片；没有图片时以字母标识代替。",
      },
    ],
  },
  {
    id: "2026-08-04-bsc-swap-routing",
    date: "2026-08-04",
    tag: "new",
    title: {
      en: "BSC swaps now route across Uniswap and PancakeSwap",
      zh: "BSC 兑换现已聚合 Uniswap 与 PancakeSwap",
    },
    items: [
      {
        en: "SHEEP CHOICE can now build and execute BSC routes across Uniswap v2/v3 and PancakeSwap v2/v3, with native BNB and ERC-20 inputs.",
        zh: "SHEEP CHOICE 现在可在 BSC 上聚合并执行 Uniswap v2/v3 与 PancakeSwap v2/v3 路由，支持原生 BNB 和 ERC-20 输入。",
      },
      {
        en: "The BSC SWAP page now chooses an available token pair when its preferred token is outside the first catalog page, instead of staying on the token-list loading message.",
        zh: "当首选代币不在目录首页时，BSC「兑换」页现在会自动选择可用交易对，不再一直停留在“加载代币列表”。",
      },
    ],
  },
  {
    id: "2026-08-03-pancake-v2-v3-catalogs",
    date: "2026-08-03",
    tag: "new",
    title: {
      en: "PancakeSwap v2 and v3 are open in POOLS",
      zh: "PancakeSwap v2 / v3 全量池已接入",
    },
    items: [
      {
        en: "BSC POOLS can now browse, search and filter the complete PancakeSwap v2 and v3 catalogs, including wallets that have never held a position in the pool.",
        zh: "BSC「池子」页现在可浏览、搜索和筛选完整的 PancakeSwap v2 / v3 目录；即使钱包从未持有该池仓位也能找到它。",
      },
      {
        en: "PAIR and single-token ZAP funding now use Pancake’s native liquidity contracts for v2 add/remove and fee-tiered v3 minting.",
        zh: "双币投入和单币 ZAP 现在会使用 Pancake 原生流动性合约，支持 v2 增加/移除流动性及按费率档位 mint v3 仓位。",
      },
    ],
  },
  {
    id: "2026-08-03-v4-directory-resilience",
    date: "2026-08-03",
    tag: "perf",
    title: {
      en: "V4 pool browsing is more resilient",
      zh: "V4 池目录更稳定",
    },
    items: [
      {
        en: "The complete BSC Uniswap v4 directory now loads from the terminal’s pool index, keeps discovering new pools on-chain, and has a metered fallback when that index is unavailable or incompatible.",
        zh: "BSC Uniswap v4 全量目录现在由终端的池索引提供，并会在链上持续发现新池；索引不可用或版本/链不兼容时可自动切换计量备用目录。",
      },
    ],
  },
  {
    id: "2026-08-02-bsc-uniswap-v4",
    date: "2026-08-02",
    tag: "new",
    title: {
      en: "Uniswap v4 liquidity is live on BSC",
      zh: "BSC 上的 Uniswap v4 流动性已上线",
    },
    items: [
      {
        en: "Your Uniswap v4 positions now appear in POSITIONS, where you can collect fees, add or remove liquidity, and withdraw.",
        zh: "你的 Uniswap v4 仓位现在会显示在「仓位」页，可直接领取手续费、增加或减少流动性，以及撤出仓位。",
      },
      {
        en: "ZAP can fund an existing v4 position or mint a new one from a single token — including native BNB pools.",
        zh: "ZAP 现在可用单一代币为现有 v4 仓位补充流动性，或新建仓位——包括原生 BNB 池。",
      },
      {
        en: "BSC POOLS now connects to the full v4 index in The Graph, with an active BNB/WBNB/USDT landing page, pair/symbol/address/pool-id search and cursor loading — even a wallet with no v4 position can pick a compatible pool and mint with ZAP.",
        zh: "BSC「池子」页现在接入 The Graph 的完整 v4 索引，首页优先展示活跃及 BNB/WBNB/USDT 池，支持交易对、符号、地址、池 ID 搜索和游标加载——即使钱包从未持有 v4 仓位，也能选择兼容池并用 ZAP 新建仓位。",
      },
    ],
  },
  {
    id: "2026-08-02-swap-refresh",
    date: "2026-08-02",
    tag: "new",
    title: {
      en: "The SWAP page, sharpened",
      zh: "SWAP 页面焕新",
    },
    items: [
      {
        en: "the LIMIT mode has retired — the swap page now does one thing well. Range orders you already placed keep filling and stay tracked on POSITIONS.",
        zh: "限价模式已下线，兑换页现在专注做好一件事。已挂出的区间订单继续成交，仍可在仓位页跟踪。",
      },
      {
        en: "the page reads faster: the action button fills solid the moment it is ready to press, and section rules complete their frames.",
        zh: "页面读起来更快：按钮在可按下的那一刻整条点亮，分节框线画满整行。",
      },
    ],
  },
  {
    id: "2026-08-02-usd-marks",
    date: "2026-08-02",
    tag: "fix",
    title: {
      en: "USD values load on every network",
      zh: "美元标价在任何网络环境都能显示",
    },
    items: [
      {
        en: "token USD values now load through the site itself instead of third-party hosts, so the ≈$ marks on SWAP and the pool stats appear everywhere — including networks where those hosts are unreachable.",
        zh: "代币美元价现在经由站点自身加载，SWAP 页的 ≈$ 标价和池子统计在任何网络环境都能显示——包括此前第三方数据源不可达的网络。",
      },
    ],
  },
  {
    id: "2026-08-02-quote-freeze",
    date: "2026-08-02",
    tag: "fix",
    title: {
      en: "Every quote honors the pause",
      zh: "所有报价遵守同一套暂停规则",
    },
    items: [
      {
        en: "quotes refresh three times on their own, then pause until you press ↻. The direct-venue rows used to keep ticking past the pause and quietly took over pricing; now the whole board freezes together, and the refresh button brings every quote back at once.",
        zh: "报价自动刷新三次后暂停，等你按 ↻ 再取新价。此前直连场馆的行情会越过暂停继续跳动，还悄悄接管了定价；现在整个报价面板一起冻结，刷新按钮一次唤回全部报价。",
      },
    ],
  },
  {
    id: "2026-08-02-route-fold",
    date: "2026-08-02",
    tag: "perf",
    title: {
      en: "Big trades read clean on the route map",
      zh: "大额交易的路由图现在一目了然",
    },
    items: [
      {
        en: 'the router now sweeps up every last sliver of liquidity on large trades, which can mean twenty-plus tiny legs. The route map draws the load-bearing legs as before and folds the slivers into one quiet "+N POOLS" band per path — every percent stays on the picture, and the picture stays readable.',
        zh: '路由器现在会为大额交易扫尽每一丝流动性，可能产生二十多条小额分腿。路由图照常绘制主力分腿，并把小额分腿按路径折叠成一条安静的"+N 池合并"色带——每一个百分点都留在图上，图本身保持易读。',
      },
    ],
  },
  {
    id: "2026-08-01-proven-badge",
    date: "2026-08-01",
    tag: "new",
    title: {
      en: "Quotes can now prove themselves",
      zh: "报价现在能自证最优",
    },
    items: [
      {
        en: "a green ◆ PROVEN badge on a SHEEP CHOICE quote means every other way of routing your trade through these pools was checked — the best of them beats this quote by a hair at most. Hover the badge for the exact claim.",
        zh: "SHEEP CHOICE 报价带上绿色 ◆ 已证明 徽章时：这些池子上所有其他路由走法都检查过了，其中最好的也最多比这个报价多换出一丁点。悬停徽章可见具体数字。",
      },
    ],
  },
  {
    id: "2026-07-22-sheriff",
    date: "2026-07-22",
    tag: "new",
    title: {
      en: "SHEEP CHOICE now supports Sheriff, GigaDex, Sushi, and RobinSwap",
      zh: "SHEEP CHOICE 接入 Sheriff、GigaDex、Sushi 和 RobinSwap",
    },
    items: [
      {
        en: "Liquidity from Sheriff, GigaDex, Sushi, and RobinSwap now joins SHEEP CHOICE routes, giving eligible swaps more paths to a better return.",
        zh: "Sheriff、GigaDex、Sushi 和 RobinSwap 的流动性现已加入 SHEEP CHOICE 路由，为符合条件的兑换提供更多更优路径。",
      },
    ],
  },
  {
    id: "2026-07-20-state-persistence",
    date: "2026-07-20",
    tag: "fix",
    title: { en: "Your settings stay put", zh: "设置不会被刷没了" },
    items: [
      {
        en: "Refresh the page — your filters, your sorting and any swap still in flight are all where you left them.",
        zh: "刷新页面后，筛选、排序、以及正在进行的兑换都还在原处。",
      },
    ],
  },
  {
    id: "2026-07-20-better-quotes",
    date: "2026-07-20",
    tag: "fix",
    title: { en: "Sharper swap quotes", zh: "兑换报价更准" },
    items: [
      {
        en: "Tokens that tax their own transfers are quoted honestly now, instead of quietly coming out wrong.",
        zh: "带转账税的代币现在会给出诚实的报价，不再悄悄算偏。",
      },
    ],
  },
  {
    id: "2026-07-19-sheep-choice",
    date: "2026-07-19",
    tag: "new",
    title: {
      en: "SHEEP CHOICE — our own swap is live",
      zh: "SHEEP CHOICE 上线 —— 我们自己的兑换",
    },
    items: [
      {
        en: "The terminal has a swap of its own now, quoting right alongside the other venues.",
        zh: "终端有了自己的兑换，和其他场所并排报价。",
      },
      {
        en: "It can split one trade across several pools instead of forcing it down a single path — and draws the split leg by leg.",
        zh: "它能把一笔交易拆到多个池子里成交，而不是硬走一条路 —— 怎么拆的，逐段画给你看。",
      },
      {
        en: "Whichever venue hands you the most is picked for you, and you can always take another yourself.",
        zh: "谁给得多就自动选谁，你也可以自己挑另一条。",
      },
    ],
  },
  {
    id: "2026-07-19-zap-any-token",
    date: "2026-07-19",
    tag: "new",
    title: { en: "Add liquidity with any token", zh: "任意代币都能一键建仓" },
    items: [
      {
        en: "Holding the wrong token? Add liquidity with it anyway — whatever needs swapping is done for you.",
        zh: "手里不是配对的那两种代币也没关系，直接建仓，该换的会替你换好。",
      },
      {
        en: "Uniswap V2 liquidity sitting in your wallet now shows up under POSITIONS.",
        zh: "钱包里的 Uniswap V2 流动性现在会显示在「仓位」里。",
      },
    ],
  },
  {
    id: "2026-07-18-bridge-v2",
    date: "2026-07-18",
    tag: "new",
    title: {
      en: "Bring funds in from other chains",
      zh: "从其他链把资金转进来",
    },
    items: [
      {
        en: "Three routes are priced side by side and sorted by what actually reaches you — pick the best one.",
        zh: "三条跨链通道同时比价，按实际到手的金额排序，挑最多的那条即可。",
      },
      { en: "No extra fee on any of them.", zh: "任何一条都不额外收费。" },
      {
        en: "While it is on the way you get a countdown, and the terminal tells you when the funds land.",
        zh: "资金在路上时有倒计时，到账后终端会告诉你。",
      },
    ],
  },
];
