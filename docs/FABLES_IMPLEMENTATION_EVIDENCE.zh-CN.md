# Fables 接入验证记录

> 2026-09-27。此文件记录 A～C 阶段的验证及 D 阶段的当前进度；自动执行与恢复、真实小额资金和生产发布尚未通过。

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

- v2 份额策略配置、API 保存、只读越界监控和策略页预览已实现；持久化交易状态机、换币、幂等恢复和账本需要完成并通过故障注入。
- 需要指定真实测试钱包、Fables 池和金额上限，并在明确授权的额度内完成两轮真实小额闭环与核账。
- 通过上述验证后才允许在生产名单中开启具体池，并按部署流程发布、健康检查和清理旧 release。
