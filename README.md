# ArchiLens — 可溯源 RTL 硬件拓扑图（DSH 插件）

**ArchiLens（包名 `hw-topo-dsh`，核心技能 `hw-topo`）是一个面向 DeepSeek Harness（DSH）的硬件拓扑图插件：扫描 Verilog/SystemVerilog 源码生成模块拓扑图，图中每个节点与连线都强制携带 `file:line` 源码证据，交付前由机器对源码树重新扫描逐项复核，幻觉率非零即拒绝交付。**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](./package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](./package.json)
[![npm 依赖](https://img.shields.io/badge/npm%20运行时依赖-0-brightgreen.svg)](./package.json)

> **上游归属（保留声明）**：本项目基于 [`tt-a1i/archify`](https://github.com/tt-a1i/archify) 的官方 DSH 包 `@tt-a1i/archify-dsh@0.1.0`（同源移植 [GongYuanCaiJi/dsh-archify](https://github.com/GongYuanCaiJi/dsh-archify)）改造：保留 DSH 插件打包形态（`cordis.patch.yml` filesystem Skill provider + `prepare` 暂存脚本）与独立 HTML 查看器理念，将五类通用图表引擎替换为**硬件拓扑专用 + 证据优先 + 自检门禁**流水线。完整第三方声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 为什么需要它

让 AI 画硬件架构图，最大的敌人是幻觉：模型凭记忆补全，模块名拼错、连线不存在、行号瞎编——而这些错误嵌在一张"看起来很专业"的 SVG 里，肉眼几乎查不出来，等发现图和代码对不上，往往已经进了文档、进了评审。

ArchiLens 的解法是把"生成"变成"转录"：图里的每一个元素都不允许来自记忆，只能来自对源码树的机械扫描；交付之前再用一次**全新的扫描**反向核对每一个证据指针，对不上就拒交。门禁是机器执行的退出码，不是模型的自觉。

## 核心能力

| 能力 | 说明 |
|---|---|
| RTL 证据扫描 | `scan` 默认走 RTLens 的 `rtlens.evidence/1` 证据后端（词法解析 + 引用追踪，行号位置不变）；RTLens 不可用时显式降级到内置容错正则扫描器，`degraded` 状态进回执、HTML 横幅、wiki 页眉（`hw-topo/lib/rtlens-backend.mjs`、`scan-rtl.mjs`） |
| 机器派生规格 | `derive` 从证据包机械转录拓扑规格（模块 / 例化 / 连线，证据完备度 100%）；`--focus <顶层模块>` 只画子树，`--no-groups` 关闭按目录分组（`hw-topo/lib/spec.mjs`） |
| 反幻觉门禁 | `verify` 对 RTL 树**重新扫描**（不信任旧证据包）逐元素复核，输出 `backed / disclosed / unbacked / broken` 四态判定与 `hallucinationRisk`，非零即 exit 1 拒交（`hw-topo/lib/verify.mjs`） |
| 四件套交付 | `deliver` 产出 `<前缀>.html`（交互查看器：点击元素看证据片段、搜索、深浅主题）+ `<前缀>.svg`（独立矢量图）+ `<前缀>.wiki.md`（代码库索引页，每行带 file:line 链接）+ `<前缀>.receipt.json`（机器可读回执与工件 SHA-256）（`hw-topo/lib/viewer.mjs`、`render-svg.mjs`、`wiki.mjs`） |
| GitHub 直达成图 | `search` + `gh` 免 clone：把分支/标签解析成 commit SHA 后下载 tarball（记录 SHA 与 tarball sha256，带路径穿越防护），SVG 节点框直达 `github.com/<owner>/<repo>/blob/<sha>/<file>#L<line>` 永久链接，解包结果按 SHA 缓存（`hw-topo/lib/github.mjs`） |
| 双引擎交叉核对 | `--cross-check` 让另一个引擎当见证者，只比行号不改图；分歧按五类披露（`coordinate-mismatch` / `dead-ifdef` / `generate-block` / `arrayed-form` / `coverage-only`），`--cross-check-strict` 下坐标冲突即 verify 失败（`hw-topo/lib/cross-check.mjs`） |
| DSH 插件形态 | `npm install` 触发 `prepare` 暂存技能到 `skills/`，`cordis.patch.yml` 注册 filesystem Skill provider，一条 `dsh plugin add` 即装（`scripts/stage-skill.mjs`、`cordis.patch.yml`、`lib/index.js`） |

## 快速开始

环境：Node ≥ 18，无 npm 运行时依赖。

### 安装（DSH 插件）

```bash
# 方式一：Git 仓库（推上去之后；<owner> 换成实际用户/组织名）
dsh plugin add github:<owner>/archify-dsh --profile <profile 名>

# 方式二：npm pack 产物 tgz 直装
npm pack
dsh plugin add ./hw-topo-dsh-<版本>.tgz --profile <profile 名>

# 方式三：本地开发（目录直装）
git clone <本仓库> archify-dsh && cd archify-dsh
npm install                                   # 仅触发 prepare 暂存 skills/，无运行时依赖
dsh plugin add <archify-dsh 路径> --profile <profile 名>
```

装完 30 秒自检（技能 CLI 在 DSH profile 的 node_modules 里）：

```bash
node <profile>/node_modules/hw-topo-dsh/skills/hw-topo/bin/hw-topo.mjs doctor --json
# 期望 {"ok": true ...}
```

### 第一次出图（CLI 直用）

```bash
node hw-topo/bin/hw-topo.mjs demo <输出目录>                        # 端到端演示：扫描→派生→交付
node hw-topo/bin/hw-topo.mjs scan  <RTL根目录> --out topo.bundle.json --json
node hw-topo/bin/hw-topo.mjs derive topo.bundle.json --out topo.topology.json --title "<题>" --project <名> --json
node hw-topo/bin/hw-topo.mjs verify topo.topology.json --json       # 幻觉率门禁，非零即停
node hw-topo/bin/hw-topo.mjs deliver topo.topology.json --json      # HTML + SVG + wiki + 回执
node hw-topo/bin/hw-topo.mjs validate topo.topology.json --json     # 仅校验规格结构
```

常用 scan 选项：`--backend auto|rtlens|builtin`（默认 auto）、`--evidence <rtlens证据.json>`（直接消费已生成的 `rtlens.evidence/1` 文档，跳过二次扫描）、`-D NAME`（可重复，`+define+` 语义）、`-I <目录>`（`` `include`` 搜索路径）。完整参数以 `node hw-topo/bin/hw-topo.mjs`（不带参数）打印的 usage 为准。

在 DSH 会话里则直接让 agent 按名字用技能：

```text
Use the hw-topo skill to map <RTL根目录> 的模块拓扑,生成可溯源的 SVG 与 wiki 索引。
```

### GitHub 仓库直达成图

```bash
node hw-topo/bin/hw-topo.mjs search "riscv cpu" --limit 5 --json    # 按星数返回候选
node hw-topo/bin/hw-topo.mjs gh <owner/repo> --ref <分支|tag|sha> --focus <顶层> --json
```

网络只用于 `search` / `gh` 两个子命令；scan / verify / deliver 完全离线。未认证 GitHub API 限 60 次/小时，设 `GITHUB_TOKEN` 环境变量可提升。无 RTL 的仓库明确报 `no-rtl` 退出，不生成空图。

## 工作方式

```
scan ───▶ 证据包（模块/例化/端口,file:line + sha256;后端身份与降级状态记入 provenance）
derive ──▶ 拓扑规格（机器转录,证据完备度 100%）
curate ──▶ 只做减法/标注（删节点、分组;无法溯源但确需展示的项进 meta.disclosed_unverified,渲染 ⚠ 虚线）
verify ──▶ 对 RTL 树重新扫描逐元素复核 → hallucinationRisk = (unbacked + broken) / elements
deliver ─▶ HTML + SVG + wiki 索引 + 回执（四件套）
```

### verify 判定语义

| 判定 | 含义 | 计入风险分子 |
|---|---|---|
| `backed` | 证据精确命中（file + line + 内容） | 否 |
| `disclosed` | 无源码证据但已显式披露（⚠ 虚线） | 否（页面可见） |
| `unbacked` | 无任何证据 → 潜在幻觉 | **是** |
| `broken` | 指针失效：文件缺失 / 行号越界 / 模块挪位 | **是** |

退出码约定：`0` 成功；`1` verify 未过（严禁描述为成功）；`2` usage / IO 错误（证据 schema 不匹配也走这一档）。

### 证据后端与行号契约

| 后端 | 行为 |
|---|---|
| `auto`（默认） | 找得到可用 RTLens（≥ 6.2.0）就用它；找不到回退内置扫描器，记 `degraded: true` + 人话原因 |
| `rtlens` | 永不降级：不可用即 exit 2 并点名是哪个 root / 解释器 / 版本不合格 |
| `builtin` | 一律内置容错正则扫描器，如实标注为降级 |

- **行号契约**：RTLens 原生 0-based + 绝对路径，hw-topo 对外 1-based + 根相对 POSIX；换算只发生在适配器（`hw-topo/lib/evidence-adapter.mjs`）一处，每个坐标带 `line0` / `line1` 双基准，`line1 === line0 + 1` 不成立即抛错。这条契约有一个永久回归锚点：把未经适配的原始坐标喂进门禁，必须 13 个元素全部判 `broken`、风险 1.0、exit 1（`hw-topo/test/off-by-one-regression.test.mjs`）。
- **同后端铁律**：`verify` / `deliver` 复用 bundle `provenance` 记录的后端与参数，不会出现"扫一次、验一次、两套行号"；显式换后端会在回执打 `backendOverride` 标记。
- **降级三处可见**：回执 `provenance`、HTML 顶部横幅、wiki 页眉——缺一即静默降级。`rtlens.evidence/1` 字段表见 `docs/evidence-contract.md`。
- 参数透传不静默：`-D` / `-I` / `--max-files` 等改变证据内容的选项原样转交 RTLens 并记入 `provenance.backendOptions`；取值不合法直接 exit 2，绝不悄悄退回默认值。

### 核心模块（`hw-topo/lib/`）

| 模块 | 职责 |
|---|---|
| `scan-rtl.mjs` | 内置容错正则扫描器（兜底后端） |
| `rtlens-backend.mjs` | RTLens 后端发现 / 探活 / 调用与显式降级 |
| `evidence-adapter.mjs` | `rtlens.evidence/1` → hw-topo bundle 的纯转录（唯一坐标换算点） |
| `spec.mjs` | bundle → 拓扑规格（derive） |
| `verify.mjs` | 逐元素复核门禁与风险指标 |
| `cross-check.mjs` | 双引擎交叉核对与五类分歧分类 |
| `layout.mjs` / `render-svg.mjs` | 排版与独立 SVG 渲染 |
| `viewer.mjs` / `wiki.mjs` | 交互 HTML 查看器与 wiki 代码库索引页生成 |
| `github.mjs` | 仓库搜索、钉 SHA tarball 下载与源码永久链接 |

## 测试

```bash
npm test
```

两个套件共 110 个测试（技能套件 106 + 仓库套件 4）：扫描器提取（注释/字符串/宏陷阱）、坐标契约与 off-by-one 回归锚点、证据适配器与后端降级、双引擎差分（五类分歧 + strict 门禁）、JSON BOM 容忍、路径 containment / 注入防护（`hw-topo/test/security.test.mjs`）、插件打包与 demo 端到端。其中"跨引擎真机等价性门禁"（`hw-topo/test/cross-engine-parity.test.mjs`）需要真实 RTL 语料与 RTLens 环境，缺样本时按原因自跳过，不误报失败；语料位置用环境变量 `HW_TOPO_OSS_REPOS` 指定。

## 目录导航

| 路径 | 内容 |
|---|---|
| `hw-topo/` | 核心技能源码：`SKILL.md`（技能定义与反幻觉工作流）、`bin/hw-topo.mjs`（CLI 入口）、`lib/`（上表 12 个模块）、`schemas/topology.schema.json`（规格结构）、`examples/fixture/rtl/`（3 文件演示语料） |
| `hw-topo/test/` | 测试套件与夹具（`rtlens-evidence.fixture.json` 证据样本、`rtlens-pkg/` 假 rtlens 包用于后端测试） |
| `lib/index.js` | 插件入口：从 DSH profile 解析技能根目录 |
| `scripts/stage-skill.mjs` | `prepare` 脚本：把 `hw-topo/` 暂存为 `skills/hw-topo/` 供打包分发 |
| `cordis.patch.yml` | DSH bundle patch：注册 filesystem Skill provider |
| `docs/` | `evidence-contract.md`（`rtlens.evidence/1` 字段表离线镜像，规范版本在 RTLens 仓库）、`trigger-routing.md`（rtlens / hw-topo / archify 三方触发权分层） |
| `SHARE.md` / `交付清单.md` | 面向同事的安装分发说明与交付清单 |
| `skills/`、`*.tgz`、`.tmp*/` | 构建产物（prepare 暂存 / npm pack 输出 / 临时目录，均已 gitignore） |

## 与相关项目的关系

一个 DSH profile 里通常同时装着三套"会讲结构"的技能，触发权分层见 `docs/trigger-routing.md`：

| 请求 | 交给谁 |
|---|---|
| 谁例化了谁 / 端口对不对 / 信号谁驱动 / 改动影响面 | **RTLens**（peer 依赖 `rtlens-dsh ≥ 6.2.0`，可选；唯一证据引擎 / 事实层，不出图） |
| RTL 拓扑图交付物（HTML / SVG / wiki / 回执） | **本插件**（事实默认来自 RTLens，图与门禁是自己的） |
| 非 RTL 通用架构图 / 时序图 / 状态机 / 数据流 / Mermaid | **archify**（上游项目，本插件 description 显式排除，不接） |

冲突裁决：事实冲突（行号 / 端口 / 例化说法不一致）以 RTLens 证据为准；图冲突（分组 / 排版 / 交付形态）以本插件交付物为准，但不得改动事实字段。若 DSH profile 另连了 RTLens MCP，可用 `get_hierarchy` / `get_module_info` / `trace_signal` 取信号级连接转录进 spec——每条仍需 file:line 证据过门禁，RTLens 数据不替代 verify 门禁。

## 许可

[MIT](./LICENSE)。版权链：© 2026 tt-a1i (Archify)、© 2025 Cocoon AI（原始 architecture-diagram-generator）、© 2026 GongYuanCaiJi（dsh 移植）；本插件的改造延续同一许可。上游归属与保留 / 替换清单见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 已知边界

- 内置扫描器是容错正则提取，不是完整 parser：会在 `` `ifdef `` 死区里报出实际不生效的例化，也会漏掉数组例化（`m[0:3] u(...)`）；RTLens 后端没有这两个问题，但会跳过 `for (genvar ...)` 生成块内的例化。两边的覆盖差异由 `--cross-check` 实测并按类披露，不计为坐标违规；内置扫描器的噪声会如实出现在 unknown / 指标里，不会静默。
- 例化证据指向**实例化语句的类型 token 行**（参数化多行例化时不是实例名所在行）；实例名从 `instance` 字段取，不从行号反推。
- 交叉例化边（同一模块被多个父级共享）以紫色虚线渲染，不带常显标签（悬停可见）；密集设计的边走线可能穿越节点区域，证据面板与 wiki 索引是权威溯源面。
- 本 README 安装命令中的 `<owner>` 与 `<profile 名>` 为占位符，使用时替换为实际值。
- `hw-topo-dsh` 当前未发布 npm registry，分发走 tgz / Git 仓库 / 目录三种离线形态（见 `SHARE.md`）。

## 安全姿态

无遥测、无凭据处理、无后台服务；`prepare` 仅暂存技能文件。网络访问仅限显式的 `search` / `gh` 子命令（GitHub API + tarball 下载，`GITHUB_TOKEN` 可选提升限额）；核心流水线 scan / verify / deliver 完全离线。下载与渲染侧的防护有测试钉死：路径穿越拒绝、证据片段不得读根外文件、wiki 页抗 markdown / HTML 注入、tar 成员拒绝 NTFS 备用数据流（`hw-topo/test/security.test.mjs`）。
