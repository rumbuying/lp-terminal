# LP Terminal 新服务器生产部署方案

> 最后核对：2026-08-31（Asia/Shanghai）
> 生产域名：<https://newlp.coinfetcher.xyz>
> 生产主机：`43.134.42.2`（Ubuntu 24.04，SSH 用户 `ubuntu`）
> 支持链：Robinhood Mainnet（`4663`）与 BSC Mainnet（`56`）

本文是新服务器的生产部署与运维基线。旧服务器已经不可访问，本机是在空服务器上重建的双链环境；以后迁移、发布和故障恢复均以本文及 `deploy/` 下的配置为准。

## 1. 安全边界

- SSH 私钥文件当前名为 `LP.pem`，位于仓库外；绝不能提交、上传到 Web 目录或写入日志。
- 私有 RPC、The Graph Key、管理员 Token、Master Key 和钱包 vault 都只存于服务器受限文件中。
- 前端生产包必须使用 `RPC=''` 构建，不能把私有 RPC 或供应商 Key 烘焙进静态 JavaScript。
- 两条链各有独立的 indexer 数据库、executor 数据目录、API Token、Master Key、RPC 文件和 vault。
- executor 只监听 loopback；公网只能经 Nginx 的 HTTPS 同源路径访问。
- 同一个钱包在同一条链上只能由一个生产 executor 负责签名。本地不得同时启动真实 executor。

文档只记录敏感文件路径，不记录内容。不要把带 Bearer Token 的命令放进 shell history、截图、工单或聊天。

## 2. 生产拓扑

```text
Internet
  │
  ▼
Nginx :80/:443  newlp.coinfetcher.xyz
  ├─ /、/assets/*                         → /var/www/lp-terminal/current
  ├─ /_chain/robinhood/api/*             → 127.0.0.1:8787
  ├─ /_chain/bsc/api/*                   → 127.0.0.1:8788
  ├─ /_chain/robinhood/executor/*        → 127.0.0.1:8790
  ├─ /_chain/bsc/executor/*              → 127.0.0.1:8791
  ├─ /_chain/robinhood/rpc               → Robinhood 公共 RPC
  ├─ /_chain/bsc/rpc                     → BSC 公共 RPC
  ├─ /kyber/*、/dexscreener/*、/goldsky/* → 对应公共服务
  └─ /thegraph/*                         → The Graph（Key 由 root-only include 注入）
```

旧的无链前缀 `/api/*`、`/executor/*` 和 `/rpc` 只作为 Robinhood 兼容入口。新代码与运维检查应优先使用 `/_chain/<chain>/...`。未知链命名空间由 Nginx 返回 `404`，防止串链。

| 实例 | systemd unit | 监听地址 | 数据位置 |
|---|---|---|---|
| Robinhood indexer | `lp-terminal-indexer@robinhood` | `127.0.0.1:8787` | `/opt/lp-terminal-indexer/data/index.robinhood-4663.db` |
| BSC indexer | `lp-terminal-indexer@bsc` | `127.0.0.1:8788` | `/opt/lp-terminal-indexer/data/index.bsc-56.db` |
| Robinhood executor | `lp-terminal-executor@robinhood` | `127.0.0.1:8790` | `/opt/lp-terminal-executor/data/` |
| BSC executor | `lp-terminal-executor@bsc` | `127.0.0.1:8791` | `/opt/lp-terminal-executor/data/bsc/` |

BSC 当前设置 `INDEXER_DISABLE_V2=1`，索引器只承担已配置的 CL/V4 能力；不要在未评估 RPC 和目录成本前擅自开启 V2。

## 3. 目录与权限

| 内容 | 生产路径 |
|---|---|
| 前端当前版本 | `/var/www/lp-terminal/current` |
| 前端不可变 releases | `/var/www/lp-terminal/releases/<UTC timestamp>` |
| indexer 当前版本 | `/opt/lp-terminal-indexer/app` |
| indexer 不可变 releases | `/opt/lp-terminal-indexer/releases/<UTC timestamp>` |
| indexer 持久数据 | `/opt/lp-terminal-indexer/data/` |
| executor 当前版本 | `/opt/lp-terminal-executor/app` |
| executor 不可变 releases | `/opt/lp-terminal-executor/releases/<UTC timestamp>` |
| Robinhood executor DB/vault | `/opt/lp-terminal-executor/data/state.db`、`data/vaults/` |
| BSC executor DB/vault | `/opt/lp-terminal-executor/data/bsc/state.db`、`data/bsc/vaults/` |
| indexer 环境文件 | `/etc/lp-terminal-indexer/robinhood.env`、`bsc.env` |
| executor 环境文件 | `/etc/lp-terminal-executor/robinhood.env`、`bsc.env` |
| Nginx 配置 | `/etc/nginx/sites-enabled/newlp.coinfetcher.xyz.conf` |
| The Graph Nginx secret include | `/etc/nginx/secrets/lp-thegraph.conf` |

生产运行用户为 `lpindexer` 和 `lpexecutor`。executor 的 `data/`、链目录与 `vaults/` 必须为 `0700`；环境文件和 secret 文件必须为 `0600`。当前 Node.js 为 `/opt/node-v22/bin/node`（v22.13.1），systemd 模板显式把 `/opt/node-v22/bin` 放入 `PATH`。

`current`/`app` 必须是指向 release 根目录的软链。release 必须自包含；不能让被保留版本的顶层 `node_modules` 软链依赖即将删除的旧 release。

## 4. 环境与 Secret

### 4.1 Indexer

两条链的环境文件至少包含：

```dotenv
# /etc/lp-terminal-indexer/robinhood.env
CHAIN=robinhood
INDEXER_PORT=8787
INDEXER_DB=/opt/lp-terminal-indexer/data/index.robinhood-4663.db
INDEXER_RPC_PRIMARY=<private RPC URL>
INDEXER_RPC_FALLBACK=<fallback RPC URL>

# /etc/lp-terminal-indexer/bsc.env
CHAIN=bsc
INDEXER_PORT=8788
INDEXER_DB=/opt/lp-terminal-indexer/data/index.bsc-56.db
INDEXER_DISABLE_V2=1
INDEXER_RPC_PRIMARY=<private RPC URL>
INDEXER_RPC_FALLBACK=<fallback RPC URL>
THEGRAPH_API_KEY=<server-only key>
```

BSC 还安装 `deploy/lp-terminal-indexer-bsc-lag.conf` 作为 systemd drop-in，用于明确允许已审核 Pancake V3 快照的最大滞后；只能在重新测量快照差距后调整。

### 4.2 Executor

共同字段和当前链隔离如下：

```dotenv
# Robinhood
CHAIN=robinhood
LP_EXECUTOR_CHAIN_ID=4663
LP_EXECUTOR_HOST=127.0.0.1
LP_EXECUTOR_PORT=8790
LP_EXECUTOR_DATA_DIR=/opt/lp-terminal-executor/data
LP_EXECUTOR_INDEXER_BASE=http://127.0.0.1:8787
LP_EXECUTOR_ALLOWED_ORIGIN=https://newlp.coinfetcher.xyz
LP_EXECUTOR_MASTER_KEY_FILE=/etc/lp-terminal-executor/master.key
LP_EXECUTOR_API_TOKEN_FILE=/etc/lp-terminal-executor/api.token
LP_EXECUTOR_RPC_FILE=/etc/lp-terminal-executor/rpc.url

# BSC 使用对应值
CHAIN=bsc
LP_EXECUTOR_CHAIN_ID=56
LP_EXECUTOR_PORT=8791
LP_EXECUTOR_DATA_DIR=/opt/lp-terminal-executor/data/bsc
LP_EXECUTOR_INDEXER_BASE=http://127.0.0.1:8788
LP_EXECUTOR_MASTER_KEY_FILE=/etc/lp-terminal-executor/bsc/master.key
LP_EXECUTOR_API_TOKEN_FILE=/etc/lp-terminal-executor/bsc/api.token
LP_EXECUTOR_RPC_FILE=/etc/lp-terminal-executor/bsc/rpc.url
```

Master Key、API Token 和 RPC 文件必须至少包含 32 字节并保持 `0600`。Master Key 与已有 vault 是一个不可分割的恢复集合：丢失或替换 Master Key 后，已有钱包无法解密。环境文件本身也为 root 所有、`0600`。

## 5. 基础安装

新建空服务器时，顺序如下：

1. 安装 Nginx、Certbot、构建/传输工具和 Node.js 22.13+。
2. 创建无登录运行用户 `lpindexer`、`lpexecutor`。
3. 创建第 3 节的 release、data 和 `/etc` 目录，并设置属主与权限。
4. 从部署代码树 `lp-terminal-upstream` 安装配置到以下目标：
   - `deploy/lp-terminal-indexer@.service` → `/etc/systemd/system/lp-terminal-indexer@.service`
   - `deploy/lp-terminal-executor@.service` → `/etc/systemd/system/lp-terminal-executor@.service`
   - `deploy/lp-terminal-service-hardening.conf` → 两个模板各自的 `.service.d/hardening.conf`
   - `deploy/lp-terminal-indexer-bsc-lag.conf` → `/etc/systemd/system/lp-terminal-indexer@bsc.service.d/lag.conf`
   - `deploy/newlp.coinfetcher.xyz.nginx.conf` → `/etc/nginx/sites-available/newlp.coinfetcher.xyz.conf`，再链接到 `sites-enabled`
5. 写入每条链独立的环境文件和 secret 文件。
6. 执行 `sudo systemctl daemon-reload`，启用四个实例。
7. 用 Certbot 为 `newlp.coinfetcher.xyz` 签发证书，执行 `sudo nginx -t` 后 reload。

只对公网开放 SSH、HTTP 和 HTTPS。`8787`、`8788`、`8790`、`8791` 必须保持 loopback，不开放安全组或防火墙端口。

## 6. 前端构建与发布

> **脚本化（2026-09-02）**：常规发布用 `deploy/release.sh`（`npm run release` / `release:web` / `release:indexer` /
> `release:status`）。脚本按本文 §6/§7 的顺序执行：typecheck + 全量测试 → 生产 env 构建 → dist 秘密扫描 →
> 上传新 release → 原子切软链 → 重启双链索引器并等待 ready → 公网 health 检查 → release 保留清理；
> 失败时打印回滚命令，另有 `rollback web|indexer <timestamp>` 子命令。executor 仍按 §7.1 手工发布。
> 以下手工步骤保留为脚本背后的依据与兜底。

当前一个静态包同时包含两条链；`CHAIN=bsc` 只决定默认链，`VITE_CHAIN_GATEWAY_HOST` 启用当前域名的双链同源路由。

```bash
cd /Users/alex/Work/LP/lp-terminal-upstream

RPC='' \
CHAIN=bsc \
VITE_CHAIN_GATEWAY_HOST=newlp.coinfetcher.xyz \
KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber \
KYBERSWAP_FEE_RECEIVER=0x2bb53df69efa1b967660f2780ddcf6f76f90ae78 \
npm run build
```

发布前搜索 `dist/`，确认没有 Alchemy/The Graph Key、私有 RPC URL、管理员 Token 或私钥。把 `dist/` 上传到新的 `/var/www/lp-terminal/releases/<YYYYMMDDTHHMMSSZ>`，确认目录完整后原子切换：

```bash
sudo ln -sfn /var/www/lp-terminal/releases/<timestamp> /var/www/lp-terminal/current.next
sudo mv -Tf /var/www/lp-terminal/current.next /var/www/lp-terminal/current
```

不要覆盖旧 release，也不要在软链切换前清理旧版本。

## 7. Indexer 与 Executor 发布

后端 release 使用相同的 UTC 时间戳命名。每个 release 必须包含完整源码、锁定依赖和自己的 `node_modules`；建议在构建机或新 release 中运行 `npm ci`，不要修改已经发布的旧目录。

推荐顺序：

1. 查看 executor 是否存在 `planned`、`executing`、`recovery` 或 `manual_review` job。
2. 准备并上传新的自包含 release。
3. 核对新 release 的属主、依赖和入口文件。
4. 原子切换对应 `app` 软链。
5. 共享代码变化时依次重启两条链的实例：

```bash
sudo systemctl restart lp-terminal-indexer@robinhood lp-terminal-indexer@bsc
sudo systemctl restart lp-terminal-executor@robinhood lp-terminal-executor@bsc
```

6. 等待公网 health 通过，再检查策略状态、最近 job 与 recovery 队列。

更新 executor 绝不能覆盖 `/opt/lp-terminal-executor/data/` 或 `/etc/lp-terminal-executor/`。更新 indexer 绝不能删除 `/opt/lp-terminal-indexer/data/`。不要为了修复代码而重建生产数据库。

## 8. 上线检查

```bash
curl -fsS https://newlp.coinfetcher.xyz/healthz
curl -fsS https://newlp.coinfetcher.xyz/_chain/robinhood/api/health
curl -fsS https://newlp.coinfetcher.xyz/_chain/bsc/api/health
curl -fsS https://newlp.coinfetcher.xyz/_chain/robinhood/executor/health
curl -fsS https://newlp.coinfetcher.xyz/_chain/bsc/executor/health

ssh -i ../LP.pem ubuntu@43.134.42.2
sudo systemctl status \
  lp-terminal-indexer@robinhood lp-terminal-indexer@bsc \
  lp-terminal-executor@robinhood lp-terminal-executor@bsc nginx \
  --no-pager
```

放行标准：

- 两个 indexer 的顶层 `ready` 为 `true`，V4 `degraded` 为 `false`。
- 两个 executor 返回 `ok:true`、`vaultReady:true`、`signerReady:true`、`apiAuthReady:true`，且非意外暂停。
- Robinhood 价格接口可返回 WETH/USDG 等精确地址报价。
- 活动策略处于预期状态，最近 job 已完成或正在按预期执行，recovery 队列无未知任务。
- 首页返回 `200`，浏览器加载的静态资源属于新 release。

需要管理员 API 的只读检查时，在服务器进程内临时读取对应 token 文件，不要打印 token，也不要把值带回本地终端历史。

## 9. Release 保留与磁盘检查

每次成功部署并通过 health/smoke 后，三个 release 根目录各只保留最新 3 个版本。必须先 dry-run 并检查目标，再应用：

```bash
sudo /opt/lp-terminal-indexer/app/deploy/prune-releases.sh
sudo /opt/lp-terminal-indexer/app/deploy/prune-releases.sh --apply
```

脚本保护当前软链目标，并拒绝删除仍被保留 release 依赖的旧版本。不能绕过安全失败。清理后必须再次检查：

```bash
readlink -f /var/www/lp-terminal/current
readlink -f /opt/lp-terminal-indexer/app
readlink -f /opt/lp-terminal-executor/app
df -h /
df -i /
```

绝不能删除生产 `data/`、`vaults/`、备份或 `/etc/lp-terminal-executor/`。

## 10. 备份、迁移与回滚

### 10.1 Executor 一致备份

1. 确认没有正在签名或等待链上确认的 job。
2. 短暂停止对应链 executor。
3. 一起备份该链的 `state.db`、`state.db-wal`、`state.db-shm`（停进程后通常 WAL/SHM 已收敛）、完整 `vaults/`、Master Key、API Token、RPC 文件和 env 文件。
4. 记录三个当前软链的解析目标。
5. 立即重启并重新验证 health、策略和 recovery。

数据库、vault 与 Master Key 必须作为同一个加密备份集合。只复制数据库或只生成新 Master Key 都不能恢复钱包。

### 10.2 再次迁移服务器

- 旧 executor 必须先永久停止签名，再启动新机 executor。
- 前端和 indexer 可以从代码与链上重新构建，但 executor 的数据库、vault 和 Master Key 不可从链上恢复。
- 新机先只绑定 loopback，核对钱包、策略、job 和 recovery 后再切 DNS/Nginx。
- 若存在 pending/manual-review 交易，先核对链上事实，不得通过重置 nonce 或删数据库解决。

### 10.3 回滚

无数据库 schema 变化时，可以把 `current`/`app` 原子切回上一个保留 release 并重启对应服务。若新版本已经写入新 schema 或账本语义，不能假设旧代码兼容，必须按该版本的专门迁移说明处理。回滚后仍需运行完整线上检查。
