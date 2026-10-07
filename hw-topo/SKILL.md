---
name: hw-topo
description: Generate evidence-traceable RTL hardware topology diagrams — Verilog/SystemVerilog module instantiation hierarchy, shared-module wiring, vendor primitives — from real RTL source trees, local paths or GitHub hardware repos (search + pinned-commit download, no clone needed). 用于 RTL/Verilog/SystemVerilog 硬件拓扑图、模块例化层级、模块连接关系、FPGA 工程结构图、GitHub 硬件项目拓扑，以及需要可溯源/反幻觉证据链的硬件架构图。Facts come from the RTLens evidence backend by default (rtlens.evidence/1, fallback to a builtin scanner with an explicitly visible degraded marker); every node and edge must carry file:line evidence verified against a fresh re-scan before delivery. Outputs an interactive HTML viewer, a standalone SVG whose nodes are GitHub source permalinks, a wiki codebase-index page, and a verification receipt with an explicit hallucination-risk metric. Division of labor — rtlens owns structural facts and Q&A (index, hierarchy, ports, drivers, impact), hw-topo owns the RTL topology diagram deliverable, and non-RTL general architecture, cloud/network/API-sequence/state-machine/dataflow or Mermaid diagrams belong to a different skill (archify), not to this one. Do not use this skill for non-RTL architecture diagrams. Serves HSB-style projects and general Verilog/SystemVerilog trees.
license: MIT
metadata:
  version: "0.3.0"
  author: port of tt-a1i/archify-dsh, adapted for hardware topology
  based_on: tt-a1i/archify (MIT, @tt-a1i/archify-dsh@0.1.0)
---

# hw-topo — 可溯源硬件拓扑图

从一个 JSON 规格生成拓扑关系 SVG:交互 HTML(证据面板)+ 独立 SVG + wiki 索引页 + 校验回执。核心约束:**图中任何元素都必须能回溯到 `file:line` 源码证据,交付前由 `verify` 门禁对 RTL 树重新扫描逐项复核**。

## 反幻觉工作流(硬性路径)

按此路径执行,不得跳步。图的内容永远来自扫描结果,绝不来自记忆。

1. **先取证据,再写 JSON**。第一动作是 `scan`,但 `scan` 默认 `--backend auto`:优先让 **RTLens 证据后端**产出并消费 `rtlens.evidence/1` 证据包,rtlens 不可用时才回落到内置正则扫描器。在写任何 JSON 之前先拿到证据包:

   ```bash
   node bin/hw-topo.mjs scan <RTL根目录> --out topo.bundle.json --json
   ```

   参数:

   - `--backend auto|rtlens|builtin`(默认 `auto`)。`auto` = 优先 rtlens、不可用即**显式降级**;`rtlens` = 强制证据后端,不可用即失败(不静默降级);`builtin` = 强制内置扫描器(仅用于对照/排障)——**显式选它也是降级**,同样记 `degraded: true` + `reason`,不是"没降级"。
   - `--evidence <file>`:直接消费一份已生成的 `rtlens.evidence/1` JSON(通常是 `python -m rtlens evidence <root> --json` 的输出),跳过二次扫描;适配器只做纯转录,不补扫、不猜字段。走到这一步时回执会记下 `provenance.evidenceFile`。
   - `-D NAME`(可重复,`+define+` 语义):传给 rtlens 的 define 集(对应 `rtlens evidence -D NAME`)。**索引结果随 define 集变化**,因此 `scan` 与 `verify` 必须用同一个 `-D` 集(契约 R5),后端身份也必须是同一个。

   零依赖、离线、支持 Verilog/SystemVerilog 混合树;厂商原语(SB_IO、BUFG 等)与外部依赖自动分类,未知类型如实标注为 `unknown`,不猜。

   **什么时候会降级**:`python` 不在 PATH / Python < 3.8 / rtlens 版本与 `rtlens.evidence/1` 不符 / CLI 非零退出 → 回落 `builtin`,`provenance.degraded = true`。

   **降级意味着什么——证据等级下降**:rtlens 后端是**位置不变的词法解析 + 引用追踪**(行号取自词法器,不受噪声干扰);内置扫描器是**容错正则提取**(容错更多写法,但行号与分类是启发式的)。两者在同一 fixture 上事实可以完全一致,但稳健性与坐标基准不同,所以降级必须显式。

   **降级信息在哪看**(缺一即视为静默降级,违反契约 R6):

   - 回执 `topo.receipt.json` 的 `provenance`(`backend` / `degraded` / `reason` / `evidenceSchema` / `tool.version` / `defines` / `rootAbs`);
   - HTML 查看器顶部的降级横幅;
   - wiki 索引页的页眉标注。

   看到 `degraded: true` 时,必须在回复里说明"当前是正则级证据,不是索引级"。

2. **机械派生,而非手工编写**。用 `derive` 从证据包生成规格,证据指针由机器转录:

   ```bash
   node bin/hw-topo.mjs derive topo.bundle.json --out topo.topology.json --title "<题>" --project <名> --json
   ```

   大设计加 `--focus <顶层模块>` 只画子树。此步产出的规格证据完备度=100%。

3. **允许的策展操作**(只做减法和标注):删除节点/边、改标题、`--no-groups`、添加 `groups`(成员必须来自现有节点)、添加信号级 `connections`(**每条必须给出 signal 出现的 file:line**)、把无法溯源但确需展示的元素列入 `meta.disclosed_unverified`(渲染为 ⚠ 虚线,不计入风险分子但显式可见)。禁止:凭记忆新增模块、编造行号、改 `file`/`line`/`label` 除非有源码依据。

4. **交付前自检,非零即停**:

   ```bash
   node bin/hw-topo.mjs verify topo.topology.json --json
   ```

   `verify` 对 RTL 根目录**重新扫描**(不信任旧证据包),逐元素判定:`backed`(证据精确命中)/ `disclosed`(显式披露)/ `unbacked`(无证据,计为潜在幻觉)/ `broken`(指针失效:文件缺失、行号越界、模块挪位)。回执给出 `hallucinationRisk`;`unbacked>0` 或 `broken>0` 时退出码 1——**exit 1 严禁描述为成功**。修复只针对诊断给出的 subject,按 `supportedFixes` 选择;连续两轮无改善则如实上报未解决问题。

5. **交付即四件套**:

   ```bash
   node bin/hw-topo.mjs deliver topo.topology.json --json
   ```

   产出 `<前缀>.html`(交互查看器:点击元素看证据片段、搜索、深浅主题)+ `<前缀>.svg`(独立矢量图)+ `<前缀>.wiki.md`(代码库索引页:模块表/例化表/信号表,每行带 file:line 链接)+ `<前缀>.receipt.json`(校验回执与 SHA-256)。verify 未过会被拒绝;`--allow-unverified` 仅在用户明确要求时使用,HTML 会盖红色警示横幅。

## 与 rtlens / archify 的分工(谁负责什么)

三句话:**事实以 rtlens 为准**(索引、层级、端口、驱动、影响面由 `rtlens` 回答,本 skill 只消费事实);**RTL 的图交给 hw-topo**(要 RTL/Verilog/SystemVerilog 拓扑图交付物时用它);**非 RTL 的架构图交给 archify**(云、网络、API 时序、状态机、数据流、Mermaid 美化不是本 skill 的活)。

什么请求交给谁:

| 请求 | 交给谁 | 不交给谁 |
|---|---|---|
| 谁例化了谁 / 端口对不对 / 信号谁驱动 / 改了要重跑什么 | `rtlens`(`query` / `check` / `trace` / `context`) | 本 skill(不出图就不要起流水线) |
| RTL 拓扑图 / 可交付图(HTML/SVG/wiki/回执) | **本 skill**(证据后端默认走 rtlens) | `archify`(拿不到 RTL 证据链与 verify 门禁) |
| 非 RTL 通用架构图 / 时序图 / 状态机 / 数据流 | `archify` | **本 skill**(description 已显式排除) |
| GitHub 硬件项目出图 | **本 skill** `gh`(钉 SHA 下载,免 clone) | `archify`(无模块分层与源码永久链接) |
| 改 RTL 前的取证 | `rtlens`(`index` + `evidence`) | 本 skill(`scan` 是消费证据,不是取证入口) |
| 先取证后出图 | `rtlens evidence <root> --json` → 本 skill `--evidence <file>`(或 `--backend rtlens`) | 两边各扫一遍、把两种行号基准混着用 |

**两边冲突时以谁为准**:

- **事实冲突**(同一份 RTL 的行号/端口/例化说法不一致)→ **以 rtlens 证据为准**(`rtlens.evidence/1`)。本 skill 的 `builtin` 扫描只是兜底,且必须已标注 `degraded`。
- **图冲突**(怎么分组、怎么排版、交付什么形态)→ 以本 skill 的交付物为准;但本 skill 不得改动事实字段。
- **非 RTL 架构图冲突** → 以 `archify` 为准,本 skill 不接。
- **行号基准冲突** → 任何一方都不许猜:一律走 `line0`/`line1` 双基准字段,见"已知边界"。

配套参考:触发权分层的完整决策表见 `docs/trigger-routing.md`;`rtlens.evidence/1` 的字段表见 `docs/evidence-contract.md`(规范版本在 RTLens 仓库 `docs/EVIDENCE_CONTRACT.md`)。

## GitHub 直达成图(搜索 → 下载 → 出图)

用户给出 GitHub 仓库(或要求搜索)时,无需本地 clone,直接:

```bash
# 1) 搜索(可选):按星数排序返回候选,打印 slug/分支/描述
node bin/hw-topo.mjs search "riscv cpu" --limit 5 --json

# 2) 一步出图:钉 commit SHA 下载 tar.gz → 零依赖解包 → scan → derive → verify → deliver
node bin/hw-topo.mjs gh <owner/repo> [--ref <branch|tag|sha>] [--focus <顶层>] [--out <目录>] --json
```

`gh` 的证据链特点:
- **钉 SHA**:通过 API 把分支/标签解析成 commit SHA,回执记录 SHA 与 tarball sha256——上游再怎么动,已交付图形的溯源不漂移。
- **源码映射**:`meta.project.github` 存在时,wiki 每行、查看器索引、导出 SVG 的节点框全部变成 `https://github.com/<slug>/blob/<sha>/<file>#L<line>` 永久链接——**点 SVG 里的模块框直达源码行**。
- **缓存**:`<out>/.gh-cache/<repo>-<sha12>/` 按提交缓存解包结果,重跑不重复下载。
- 无 RTL 的仓库会明确报 `no-rtl` 退出,不生成空图。
- 网络**只**用于 `search`/`gh` 两个子命令;scan/verify/deliver 保持离线。未认证 API 限 60 次/小时(可设 `GITHUB_TOKEN` 提升)。

## 输出契约

返回:四个工件的精确路径、verify 指标(backed/total、disclosed、unbacked、broken、hallucinationRisk)、`provenance`(backend / degraded / reason——降级时必须说出证据等级下降)、以及(若有)未解决问题清单。不得宣称执行了未执行的检查,不得把非零退出说成成功。

## 环境与兜底

```bash
node bin/hw-topo.mjs           # 不带参数打印 usage:当前 CLI 实际支持的参数以这里为准
node bin/hw-topo.mjs doctor    # 自检(node 版本 + fixture 扫描)
node bin/hw-topo.mjs demo <目录>  # 端到端演示:扫描→派生→交付
```

Node ≥18,无 npm 依赖。规格结构见 `schemas/topology.schema.json`。退出码约定:`0` 成功、`1` verify 未过、`2` usage 或 IO 错误(证据 schema 不匹配也走这一档)。

`rtlens` 不可用时的降级行为、`provenance` 字段表与适配器拒绝条件,见 `docs/evidence-contract.md`。

## RTLens 证据后端(默认)与 MCP 增强(可选)

**默认证据后端就是 RTLens,不是可选的交叉验证。** `scan --backend auto`(默认)会优先调用
`python -m rtlens evidence <root> --json`,把 `rtlens.evidence/1` 证据包**纯转录**为 hw-topo 的 bundle;
rtlens 不可用(python 缺失 / 版本不符 / CLI 失败)时才回落到内置正则扫描器,并置
`provenance.degraded = true` + `reason`,同时写进回执、HTML 横幅、wiki 页眉(见工作流第 1 步)。
后端身份必须写进 `provenance`,且同一 spec 的 `scan` 与 `verify` 必须同后端——跨后端混用会产生
假 `broken` 洪水。

若 DSH profile 还连接了 RTLens MCP(`mcp__rtlens__*`),可以用 `get_hierarchy` / `get_module_info` /
`trace_signal` 拿到**信号级、端口级**的更丰富连接信息,再**转录**为 spec 的 `connections`
(每条仍需 file:line 证据,并写明行号基准)。

**原则不变:RTLens 数据不替代 `verify` 门禁。** 无论证据来自 CLI 证据后端还是 MCP,图里的每个元素
在交付前都必须由 `verify` 对 RTL 树重新扫描逐项复核;RTLens 只是证据来源,不是门禁的替代品。

## 已知边界

- 扫描器是容错正则提取,不是完整 parser:数组例化 `m[0:3] u(...)`、generate 块内动态结构可能少报;噪声/漏报都会如实出现在 `unknown`/指标里,不会静默。**注意**:这一条描述的是**内置兜底扫描器**;走 rtlens 证据后端时,证据来自词法解析 + 引用追踪(位置不变),降级与否看 `provenance.degraded`。
- **行号契约:bundle/spec 用 1-based + root 相对 POSIX;RTLens 原生是 0-based + 绝对路径。转换只发生一次、在适配器里,永不靠猜。** 证据包的 `line0`/`line1` 两个字段同时存在,适配器取 `line1`(并断言 `line1 === line0 + 1`,`endLine1 >= line1`);跨工具引用行号必须写明基准,基准不明的行号不得进入任何交付物。`spec` 校验会把 `line < 1` 判为非法,把越界/绝对路径判为 `file-outside-root`。另有一条易踩的语义:**例化证据指向实例化语句的类型 token 行**(参数化多行例化时不是实例名所在行);实例名从 `instance` 字段取,不从行号反推。
- 交叉例化边(同一模块被多个父级共享)以紫色虚线渲染,不带常显标签(悬停可见)。
- 密集设计的边走线可能穿越节点区域;证据面板与 wiki 索引是权威溯源面。
