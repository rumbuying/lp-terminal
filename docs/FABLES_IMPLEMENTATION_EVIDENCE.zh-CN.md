# Fables 接入验证记录

> 2026-09-27。此文件记录 A～C 阶段的验证及 D 阶段的当前进度；完整自动循环、真实小额资金和生产发布尚未通过。

## 合约与读取

- Robinhood Chain ID：`4663`。从 Fables registry `0x159a113e012593d9b3cc63ad45e30f0467e13ef3` 读取到 38 个活跃池、13 个 hook；`npm run check:fables` 对 PoolId、hook runtime hash、lens/registry runtime hash 逐项核验。
- `src/config/fables.ts` 固定已审阅的 PoolId 和代码哈希。未知或变化的合约只读路径报错，交易构造路径还需经过独立的 `FABLES_AUTO_POOL_IDS` 允许名单。生产允许名单目前为空。
- Sourcify 匹配源码确认仓位是 hook ERC-6909 份额。旧 hook 调用 `withdraw` 后需再调用 `claimFees`；新 hook 可调用 `withdrawAndClaim`。不能把 shares 当成 v4 PositionManager NFT 的 liquidity。
- 索引器从 `Deposited`、`Withdrawn`、`FeesClaimed`、`Transfer` 事件提取候选 ID，并用 hook/lens 的当前链上读数验证。全历史临时库扫描 122,345 条事件后，对示例钱包找到 44 个候选，其中 2 个有余额、42 个已空、0 个读取错误。事件索引不是可签名的仓位事实。

## 主网 fork 写入验证

使用 Anvil v1.8.1、最新 Robinhood Chain 状态，在本地 fork 上以仓位所有者身份模拟交易；未向主网发送交易。公共 Robinhood RPC 的区块响应缺少 Anvil 需要的部分标准 header 字段，仓库内只读代理 `scripts/fables-fork-rpc-proxy.mjs` 补齐这些字段。该代理限制转发方法，不接受主网发送交易。

```sh
node scripts/fables-fork-rpc-proxy.mjs
docker run --rm --name fables-fork -p 127.0.0.1:8545:8545 --entrypoint anvil ghcr.io/foundry-rs/foundry:latest --fork-url http://host.docker.internal:8546 --host 0.0.0.0 --port 8545 --chain-id 4663 --hardfork cancun --auto-impersonate --silent
FABLES_FORK_RPC=http://127.0.0.1:8545 npx tsx scripts/fables-fork-smoke.ts
```

2026-09-27 成功运行：fork 基准块 `73280351`，结束块 `73280360`。

| 场景 | 结果 |
| --- | --- |
| 旧版原生币池 | 部分退出后份额减半，全额退出后该所有者份额为零，单独领取后应收费用均为零；其他持有人份额不变 |
| 旧版原生币零费用区间 | 新建零费用区间，获得 `104501315726991` 份额，随后全额退出 |
| 新版合并退出池 | 部分退出后份额减半，全额 `withdrawAndClaim` 后份额与应收费用均为零 |
| 新版池暂停 | fork 内修改暂停状态，退出报价拒绝自动路径；`withdrawAndClaim` 回退，普通 `withdraw` 仍可用；随后回滚快照 |

本测试还核验了 PoolKey/PoolId/rangeId、一致的份额单位、收款钱包余额、滑点保护和 gas 预留。交易哈希由 fork 生成，没有主网意义。测试从最新链上事件动态选有余额的所有者；公共 RPC 不保证长期历史状态可读，因此不要把上述块高用作永久重放点。

## 未完成的发布门

- v2 份额策略配置、API 保存、只读越界监控和策略页预览已实现。D 阶段新增独立 Fables 作业表、交易哈希及已签名原始交易先落库、确认回执恢复、人工重播同一笔原始交易、手续费与本金账本、换币规划、原生 ETH 的 WETH 路由、持久化的旧区间到新区间状态机。签名前再次核对 pending nonce、池币种及仓位是否仍越界；退出后按实际钱包到账和 gas 核对最低到账。当前仅完成局部 fork 恢复演练，完整循环仍需通过。
- 本地 fork 已证明：一次旧 hook 的退出交易成功，哈希先落库后即使等待确认超时仍可在重启后从同一哈希恢复到下一阶段；另一次约 200 USDG 的样本验证了转入份额后的退出报价。但公共 Robinhood RPC 的历史账户状态在 fork 固定块后不可稳定读取，后续一次签名交易在本地 Anvil 保持 pending，挖块请求超时。另试验了公开的 BlockReq 近期历史 RPC：固定块 `eth_getCode` 可读，但固定块 `eth_getProof` 被拒绝，同样不能用于 Anvil 挖块。按 [Robinhood Chain 连接文档](https://docs.robinhood.com/chain/connecting/) 需使用支持固定块 `eth_getProof` 的 archive RPC 完成验证；不能把当前不完整的 fork 记录视为交易闭环成功。
- `npm test`：1028 项，982 通过、46 跳过、0 失败；`CHAIN=robinhood npm run test:strategy`：160 项通过；`npm run typecheck` 和使用本地测试费率接收地址的 Robinhood 构建通过。Fables 作业、回执恢复、同笔交易重播、手续费与份额解析、存入支出上限的专项测试也通过。最新 D 改动后的完整 fork 与链上故障注入仍未验收。
- 需要指定真实测试钱包、Fables 池和金额上限，并在明确授权的额度内完成两轮真实小额闭环与核账。
- 通过上述验证后才允许在生产名单中开启具体池，并按部署流程发布、健康检查和清理旧 release。
