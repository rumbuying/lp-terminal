# Fables 接入验证记录

> 2026-09-27。此文件记录 A～C 阶段的验证及 D 阶段的当前进度；只读功能已发布，完整自动循环、真实小额资金和生产自动签名发布尚未通过。

## 2026-09-27 用户仓位与生产只读发布

- 用户给出的 Fables ETH/PONS 仓位 URL 对应 Robinhood Chain 钱包 `0x2Bb53df69EFA1b967660F2780DDcF6f76F90ae78`，池 `0xb59001413cb070e28433826f927b7265a0813213ba21f454d86896cee3cce674`，hook `0x594e8e6281eDf2d363a0293a50004Cf868E7a080`，ticks `83760–84000`。从本地 `.env` 的私钥仅在进程内导出地址，与链上份额所有者匹配；未输出、上传或提交私钥。该文件权限已收紧为 `0600`。
- 最新状态读取确认 `shares=110349231675337940795`、仓位处于区间内、未暂停，退出方法为 `withdrawAndClaim`。一次只读报价显示本金约 `0.015250955237506242 ETH + 20.580357279857011884 PONS`，待领约 `0.000040042463959378 ETH + 0.095585999652718577 PONS`，钱包另有约 `0.229262973745725401 ETH` 供 gas；这些数值随区块变化，不能用于签名时的金额约束。生产服务器上 ETH/PONS 的 Kyber 只读换币报价返回有效路由；执行器对 PONS/WETH 两个方向均选到可执行的 Uniswap v3 500 ppm 路由，可由现有原生 ETH 直连交易构造器使用，仍需 fork 和实盘验收。
- 新提供的 `FABLES_FORK_UPSTREAM_RPC` 可读最新状态，但固定在当前块后，hook 的 `eth_getProof` 在落后约 100 块时返回 `-32000`；距当前 100,000 块的多账户/存储证明预检失败。生产 executor 和 indexer 配置的 RPC 同样无法提供距当前 1,000 块的历史证明。因而这些 RPC 仍不能支撑持续挖块的 Anvil fork 完整循环，D 的完整验收与 E 的真实自动签名保持关闭。
- 生产 `newlp.coinfetcher.xyz` 已发布网页及两链 indexer（release `20260927T121419Z`），以及两链 executor（release `20260927T122800Z`）。执行器发布前确认 Robinhood/BSC 无运行中或待恢复旧作业，数据库 `quick_check=ok`，并作在线数据库备份。发布后两个 executor 的 `ok/vaultReady/signerReady/apiAuthReady` 均为 true，均未暂停；Robinhood 钱包列表已有上述仓位所有者地址。两个 indexer 和五项公网健康检查通过。
- Robinhood Fables 事件索引已从创世回填至最新块，生产 API 对上述钱包返回 `ready=true`、3 个候选，并包含目标 `rangeId=539370627915511154826653668589983232122555185378305681796357519476144749006`。网页可从索引发现并再读链上状态；执行器具备 Fables 只读策略接口。`FABLES_AUTO_POOL_IDS` 仍为空，未创建 Fables 自动策略，未向主网发送 Fables 资金交易。
- 两次发布均先完成健康检查再运行 `deploy/prune-releases.sh` 的 dry-run 和 `--apply`；三个 release 根目录最终各留最新 3 个版本。三个活动软链、五个服务、`df -h /` 与 `df -i /` 已复核。

## 合约与读取

- Robinhood Chain ID：`4663`。从 Fables registry `0x159a113e012593d9b3cc63ad45e30f0467e13ef3` 读取到 38 个活跃池、13 个 hook；`npm run check:fables` 对 PoolId、hook runtime hash、lens/registry runtime hash 逐项核验。
- 上线前复核（2026-09-27）：`npm run check:fables` 在区块 `73742656` 再次通过，仍为 38 个活跃池、13 个已审阅 hook。旧 hook 的 fork 示例仓位在区块 `73743106` 仍有 `233417904528922145` 份额，已离开区间；当前退出报价本金为 `0` ETH + `114499999999` 个 USDG 原始单位，待领费用为零。此示例只用于本地 fork，真实小额验收仍须使用获授权的测试钱包。
- `src/config/fables.ts` 固定已审阅的 PoolId 和代码哈希。未知或变化的合约只读路径报错，交易构造路径还需经过独立的 `FABLES_AUTO_POOL_IDS` 允许名单。生产允许名单目前为空。
- Sourcify 匹配源码确认仓位是 hook ERC-6909 份额。旧 hook 调用 `withdraw` 后需再调用 `claimFees`；新 hook 可调用 `withdrawAndClaim`。不能把 shares 当成 v4 PositionManager NFT 的 liquidity。
- 索引器从 `Deposited`、`Withdrawn`、`FeesClaimed`、`Transfer` 事件提取候选 ID，并用 hook/lens 的当前链上读数验证。全历史临时库扫描 122,345 条事件后，对示例钱包找到 44 个候选，其中 2 个有余额、42 个已空、0 个读取错误。事件索引不是可签名的仓位事实。
- 仓位页的手动导入按钱包保存在浏览器中，策略页现在读取同一记录；事件索引暂不可用时，用户仍可从已核实的手动导入区间创建策略。读数会重新经过链上池、hook、份额及区间校验。

## 主网 fork 写入验证

使用 Anvil v1.8.1、最新 Robinhood Chain 状态，在本地 fork 上以仓位所有者身份模拟交易；未向主网发送交易。公共 Robinhood RPC 的区块响应缺少 Anvil 需要的部分标准 header 字段，仓库内只读代理 `scripts/fables-fork-rpc-proxy.mjs` 补齐这些字段。该代理限制转发方法，不接受主网发送交易。

```sh
export FABLES_FORK_UPSTREAM_RPC="$ROBINHOOD_ARCHIVE_RPC"
node scripts/fables-archive-rpc-check.mjs
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
- 执行边界复核：预检要求钱包原生币余额覆盖整轮保守 gas 预留；退出后若待领费用已为零，即使领取功能此时暂停也直接核对并继续，避免零费用循环卡在领取阶段。这不能替代完整 fork 与真实资金验收。
- 价格在签名前回到旧区间时，预检作业现在以 `cancelled` 终结并原子恢复策略监控及越界计时；有任何交易记录的作业不得走取消路径。原有预检失败仍进入暂停或恢复。数据库行为测试覆盖取消后无交易、监控恢复、作业不可再推进。
- 只读执行预览现在显示当前池价下新区间的两币目标价值占比，以及滑点、换币价格冲击、领取费率、计划有效期、gas 预留和每日换币上限；资产占比只作参考，真实换币与存入仍在退出到账后重算。现价占比使用链上原始币量与池价计算，未引入未来手续费预测。
- 本地 fork 已证明：一次旧 hook 的退出交易成功，哈希先落库后即使等待确认超时仍可在重启后从同一哈希恢复到下一阶段；另一次约 200 USDG 的样本验证了转入份额后的退出报价。但公共 Robinhood RPC 的历史账户状态在 fork 固定块后不可稳定读取，后续一次签名交易在本地 Anvil 保持 pending，挖块请求超时。另试验了公开的 BlockReq 近期历史 RPC：固定块 `eth_getCode` 可读，但固定块 `eth_getProof` 被拒绝，同样不能用于 Anvil 挖块。按 [Robinhood Chain 连接文档](https://docs.robinhood.com/chain/connecting/) 需使用支持固定块 `eth_getProof` 的 archive RPC 完成验证；不能把当前不完整的 fork 记录视为交易闭环成功。
- 追加验证：最新块 fork 能启动并返回区块高，但对其固定块 `0x464f084` 的 `eth_getProof` 返回 `-32000 historical state ... is not available`。完整循环脚本停在初始仓位读取，尚未发送交易；已停止本地 Anvil 和只读代理。此结果再次确认需要可固定块读取证明的 archive RPC。
- 新增只读预检 `scripts/fables-archive-rpc-check.mjs`，在启动 Anvil 前要求链 ID 4663，并验证距当前 100,000 块的固定块 `eth_getProof`。输出仅包含块高与检查结果，不打印带凭据的 endpoint。代理和预检应使用同一个 `FABLES_FORK_UPSTREAM_RPC`。
- 2026-09-27 另测公开端点：Alchemy 文档的 `docs-demo` 示例在 `eth_chainId` 返回 HTTP 403；SolidRPC 免密公开路由在历史 `eth_getProof` 返回 `-32014`。两者均未通过预检，不能替代经实测支持历史证明的 archive 凭据端点。
- 同日另测 PublicNode、dRPC 与 bloXroute Robinhood 公开路由：前两者的历史证明分别返回 HTTP 403、400；bloXroute 对单次 hook 账户证明曾通过，但同一固定历史块随后对零地址、hook 与 registry 返回 `-32000`。Anvil fork 虽能启动，完整执行脚本在首次仓位 `balanceOf` 即因历史账户状态不可用失败，未发送任何测试交易。预检现要求在同一历史块重复核验多个账户及 hook 存储证明；单次成功不足以判定 archive 稳定可用。测试代理与 Anvil 已停止。
- fork 脚本在配置 archive upstream 时，通过本地只读代理搜索示例仓位，日志扫描的最高块不超过 Anvil 的 fork 基准块，避免示例发现意外退回公共 RPC 或读取 fork 之后的事件。
- 完整 executor 循环脚本现可通过 `FABLES_TEST_HOOK`、`FABLES_TEST_POOL_ID` 指定旧版或新版已核验的 USDG 池；按链上现价将转给一次性 fork 签名钱包的本金及待领费用限制在 200 USDG，并在转移后再次核对。恢复脚本从持久化作业读取池 ID。新版 hook 的完整执行循环仍需 archive fork 实际跑通，不能由脚本配置能力代替验收结果。
- `npm test`：上次全量运行 1028 项，982 通过、46 跳过、0 失败；最新 `CHAIN=robinhood npm run test:strategy`：167 项通过；`npm run typecheck` 和使用本地测试费率接收地址的 Robinhood 构建通过。Fables 作业、回执恢复、同笔交易重播、手续费与份额解析、存入支出上限的专项测试也通过。跨 UTC 日预留正确归日；已确认换币记录不可覆盖，缺失的预留不会静默确认。恢复扫描会补齐已落库回执但尚未记账的 gas；资产或回执核对不一致时需人工恢复。新增五个资金变动阶段的广播后中断/回执恢复测试；完整 fork 与链上故障注入仍未验收。
- 钱包签名登录在登录文案中承诺只读；Fables 策略保存、作业恢复与已签名交易重播均要求管理员令牌。HTTP 集成测试验证钱包会话对这三个写接口返回 403，管理员令牌可进入对应接口。
- 需要指定真实测试钱包、Fables 池和金额上限，并在明确授权的额度内完成两轮真实小额闭环与核账。
- 通过上述验证后才允许在生产名单中开启具体池，并按部署流程发布、健康检查和清理旧 release。
