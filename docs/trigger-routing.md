# 三方技能触发权分层 — rtlens / hw-topo / archify

一个 DSH profile 里同时装了三套"会画架构、会讲结构"的 skill,它们的 `description`(skill 路由的唯一依据)
在重叠区互相抢触发,结果是**没有崩溃,但同一份 RTL 上两个 skill 给出对不上的说法与行号,AI 用起来互相打架**。
本文件把触发权按层写清楚:谁负责事实、谁负责图、谁在重叠区主动让权。

## 0. 三方定位(一句话版)

| skill | 来源 | 一句话定位 | 不做什么 |
|---|---|---|---|
| `rtlens` | `rtlens-dsh`(本机仓库 `lsP/rtlens`) | **唯一证据引擎 / 事实层**:索引、层级、端口、驱动、影响面、模板 | 不出图、不做交付物渲染 |
| `hw-topo` | `hw-topo-dsh`(`tt-a1i/archify-dsh`,源码在 `hw-topo/`) | **RTL 拓扑图交付物**:scan→derive→verify→deliver(HTML/SVG/wiki/回执) | 不重新定义事实;不接非 RTL 架构图 |
| `archify` | `@tt-a1i/archify-dsh`(第三方,装在 `node_modules`) | **通用架构图**:云/网络/API 时序/状态机/数据流/Mermaid 美化 | 不产出 RTL 证据链,不做反幻觉门禁 |

分工可以被压缩成三句话:

1. **事实以 rtlens 为准**——索引、层级、端口、驱动、影响面这些结构性答案来自 `rtlens.evidence/1`。
2. **RTL 的图交给 hw-topo**——要 RTL/Verilog/SystemVerilog 的拓扑图交付物时用它,它的默认证据后端就是 rtlens。
3. **非 RTL 的架构图交给 archify**——云/网络/API 时序/状态机/数据流这类通用架构图不是 hw-topo 的活。

## 1. 决策表(用户意图 → 该用谁 → 不该用谁)

| 用户意图 | 该用谁 | 不该用谁 | 备注 |
|---|---|---|---|
| **结构性问题**:谁例化了谁 / 端口对不对 / 信号谁驱动 / 改了要重跑什么 | `rtlens`(`query` / `check` / `trace` / `context` / `evidence`) | `hw-topo`(不出图就别起流水线)、`archify`(不产生 RTL 事实) | 答案必须带 `file:line`,行号基准要写明 |
| **要 RTL 拓扑图 / 可交付图**(HTML/SVG/wiki/回执) | `hw-topo`(证据后端默认 `--backend auto` → rtlens) | `archify`(会丢 RTL 证据链与 `verify` 门禁) | 同时要事实时,先 `rtlens evidence` 再 `hw-topo --evidence` |
| **要非 RTL 的通用架构图 / 时序图 / 状态机**(云、网络、API、数据流、Mermaid 美化) | `archify` | `hw-topo`(description 已显式排除)、`rtlens`(非 RTL 无索引价值) | 这是三方里唯一"hw-topo 明确让权"的方向 |
| **GitHub 硬件项目出图** | `hw-topo` `gh`(搜索 + 钉 commit SHA 下载,免 clone) | `archify`(无 RTL 分层与源码永久链接) | 事实侧仍可先跑 rtlens 取证;无 RTL 的仓库 hw-topo 报 `no-rtl` 不生成空图 |
| **改 RTL 前的取证** | `rtlens`(`index` → `query` / `check` / `trace` / `evidence`) | `hw-topo`(`scan` 不是取证入口,它消费证据)、`archify` | "index before you speak":任何结构断言先有索引 |
| 先取证、后出图(组合意图) | `rtlens evidence <root> --json` → `hw-topo scan --evidence <file>` 或 `--backend rtlens` | 两边各自扫一遍、行号基准混用 | 同一 spec 的 `scan` 与 `verify` 必须同后端(契约 R5) |
| 行号对不上 / 两个 skill 说法冲突 | 以 `rtlens.evidence/1` 的 `line0`/`line1` 双基准为准 | 任何"顺手 ±1"或凭记忆补行号的做法 | 基准必须显式写出,见 §2 第 4 条 |

> 注:表中的 `--backend` / `--evidence` / `-D` 是冻结方案的目标接口。它们的**实际接线状态见 §4**——
> 在 `scan` 接线完成前,需要 RTLens 证据时请显式执行 `python -m rtlens evidence <root> --json`,
> 不要假定 `scan` 已经在消费它。

## 2. 冲突消解原则

1. **事实以 rtlens 为准。** 同一份 RTL 上,行号、端口、例化关系、驱动关系出现两种说法时,
   以 `rtlens.evidence/1`(经 `python -m rtlens evidence <root> --json` 产出)为准。
   hw-topo 的 `builtin` 正则扫描是**兜底**,仅在 rtlens 不可用且 `provenance.degraded = true` 时成立。
2. **图以 hw-topo(RTL)或 archify(非 RTL)为准。** 图怎么画、分几组、怎么渲染、交付什么形态,
   由出图方决定;事实方不对排版负责,出图方不得改动事实字段。
3. **三者都不许凭记忆回答结构事实。** 没有工具输出的模块名、端口名、行号一律不得出现在回复里;
   查询为空就如实说"not found in index",不回落训练数据。
4. **行号基准永远是显式契约,不是默认值。** rtlens CLI 原生 **0-based**;hw-topo 的 bundle/spec 用 **1-based**;
   跨工具传递一律用 `line0`/`line1` 双基准字段,转换只发生一次、在适配器里,永不靠猜。
5. **后端不得交叉。** 同一个 spec 的 `scan` 与 `verify` 必须同后端,否则会出现假 `broken` 洪水
   (`verify` 会把坐标不匹配的元素全部判失效,`hallucinationRisk` 冲到 1.0)。
6. **降级必须说出口。** 看到 `provenance.degraded = true` 时,回复里必须说明"当前是正则级证据,不是索引级",
   并指出证据链等级下降的位置(回执 `provenance` / HTML 横幅 / wiki 页眉)。

## 3. 现实约束:我们改不了 archify

`archify` 是第三方包(`@tt-a1i/archify-dsh`,装在 profile 的 `node_modules` 下),
**我们不能改它的 `SKILL.md`**,也不能改它的任何文件。因此路由只能从我们这一侧主动让权:

- `hw-topo` 的 `description` 里**显式排除**非 RTL 通用架构图,并点名"that is archify's job";
- `rtlens` 的 `description` 里声明自己只是**事实/证据层**,出图交付物交给 `hw-topo`(RTL)或 `archify`(非 RTL);
- 两侧都写明与对方的分工,让路由在**重叠词**(如"架构""拓扑""diagram")上指向正确的一方。

### 这个约束的后果

- **不能让 archify 主动收窄自己的触发面。** 它的 description 覆盖甚广(architecture / workflow / sequence /
  dataflow / lifecycle / cloud / network / Mermaid),任何一个词与 hw-topo 的"拓扑图"重叠,都可能被它抢到。
- **若 archify 仍然抢触发**(例如用户说"给这个 RTL 项目画个架构图"而 archify 先被选中),两条兜底:
  1. 在 **profile 层**禁用 archify(或按任务 profile 分开装),这属于环境配置,不是本仓库能做的事;
  2. **用户显式点名**:让用户直接说 `hw-topo`(或 `rtlens` 取证后再出图),显式点名优先于 description 匹配。
- **被抢触发时的正确反应**:不要用 archify 的输出假装 RTL 证据链。如实说明"这张图没有 RTL 证据门禁",
  需要可溯源图时转交 hw-topo 重做。

## 4. 落地状态与待办(诚实记录)

- **rtlens 侧已落地**:`python -m rtlens evidence <root> [--json] [-o <file>] [-D NAME]` 已随 rtlens 6.2.0 提供
  (`rtlens/evidence.py` 是参考实现),产出规范版 `rtlens.evidence/1`。
- **hw-topo 侧库已落地**:`lib/evidence-adapter.mjs`(`rtlens.evidence/1` → bundle 的纯转录与断言)、
  `lib/rtlens-backend.mjs`(后端选择 `auto|rtlens|builtin` 与降级标记)、对应测试已就位。
- **CLI 接线状态**:截至本文档编写时,`bin/hw-topo.mjs` 的 `scan` 尚未接线 `--backend` / `--evidence` / `-D`
  (未知 flag 会走 usage 并 exit 2),`scan` 目前仍直接调用内置扫描器。**参数的实际可用性以
  `node bin/hw-topo.mjs`(不带参数)打印的 usage 为准**;在接线完成前,若需要 RTLens 证据,请显式
  执行 `python -m rtlens evidence`,不要假定 `scan` 已经在消费它。
- **两份 SKILL.md 的触发文本**:hw-topo 的 `hw-topo/SKILL.md`(源码,本仓库可改)与 profile 实际加载的
  `skills/hw-topo/SKILL.md`(由 `scripts/stage-skill.mjs` 统一 stage);rtlens 侧的
  `skills/rtlens/SKILL.md` 同样需要重新 stage/发布。**只改源码不重新 stage,profile 里的路由不会变**;
  stage 由维护者统一执行。
- **archify 侧不改**:它是第三方包,本仓库不修改其文件(见 §3);任何"让 archify 少抢触发"的动作
  只能发生在 profile 配置层或用户点名。
- 契约文本的规范版本在 RTLens 仓库 `docs/EVIDENCE_CONTRACT.md`;hw-topo 侧离线镜像见
  `docs/evidence-contract.md`(含字段表、拒绝条件与 `provenance` 字段)。
