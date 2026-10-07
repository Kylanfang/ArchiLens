# 给同事:hw-topo 插件安装与上手

hw-topo 是 DSH 的硬件拓扑技能:扫描 RTL 源码生成模块拓扑 SVG,**每个节点/连线都带 `file:line` 源码证据**,交付前机器复核幻觉率(非零拒交),输出交互 HTML + SVG + wiki 索引页。零依赖、离线可用;`search`/`gh` 两个子命令可选联网直连 GitHub 仓库出图。

## 安装(三选一)

**方式 A:tgz 文件直发(最简单,推荐)**

把 `hw-topo-dsh-0.2.0.tgz` 发给同事(微信/网盘/内网共享均可),对方:

```bash
dsh plugin add ./hw-topo-dsh-0.2.0.tgz --profile <他的profile名>
```

**方式 B:共享目录**

整个 `archify-dsh/` 目录放内网共享,对方:

```bash
cd archify-dsh && npm install   # 触发 prepare 暂存 skills/(仅此用途,无运行时依赖)
dsh plugin add <archify-dsh路径> --profile <他的profile名>
```

若 pnpm 拦下构建步骤:在 profile 的 `pnpm-workspace.yaml` 把本包加进 `allowBuilds` 再装一次。

**方式 C:Git 仓库(团队长期使用)**

推到公司 GitLab/Gitea 或 GitHub 后:

```bash
dsh plugin add github:<owner>/archify-dsh --profile <他的profile名>
```

## 装完自检(30 秒)

```bash
# 找到技能 CLI(在 DSH profile 的 node_modules 里)
node <profile>/node_modules/hw-topo-dsh/skills/hw-topo/bin/hw-topo.mjs doctor --json
# 期望 {"ok": true ...}
```

日常使用不需要手动跑 CLI——在 DSH 会话里直接说:

```text
Use the hw-topo skill to map <RTL根目录> 的模块拓扑,生成可溯源的 SVG 与 wiki 索引。
```

## 常用命令(CLI 直用)

```bash
node bin/hw-topo.mjs demo <输出目录>                        # 端到端演示
node bin/hw-topo.mjs scan <RTL根目录> --out b.json --json   # 扫描成证据包
node bin/hw-topo.mjs derive b.json --out s.json --focus <顶层模块> --json
node bin/hw-topo.mjs verify s.json --json                   # 幻觉率门禁(非零即拒)
node bin/hw-topo.mjs deliver s.json --json                  # HTML+SVG+wiki+回执 四件套
node bin/hw-topo.mjs search "关键词" --json                  # GitHub 仓库搜索(可选)
node bin/hw-topo.mjs gh <owner/repo> --json                 # GitHub 直达成图(可选)
```

GitHub 功能提示:未认证 API 限 60 次/小时,设 `GITHUB_TOKEN` 环境变量可提升。

## 环境要求

Node ≥18。无 npm 运行时依赖、无遥测、无后台服务;联网仅限 `search`/`gh`。

## 卸载

```bash
dsh plugin remove hw-topo-dsh --profile <他的profile名>
```
