# 证据契约离线镜像 — `rtlens.evidence/1`

> **状态:镜像(mirror),非规范版本(non-canonical)。**
> 规范版本(canonical,状态 frozen)在 RTLens 仓库:`lsP/rtlens/docs/EVIDENCE_CONTRACT.md`。
> **任何差异以规范版本为准。**
> 漂移由 `schema` 字符串在运行时断言兜底:hw-topo 适配器(`lib/evidence-adapter.mjs`)解析证据包时断言
> `schema === "rtlens.evidence/1"`,**不匹配即抛错拒绝**(CLI 侧按退出码约定以 **exit 2 = usage/IO error** 表达),
> 不尝试兼容解析、不猜测字段、不做"尽力而为"。
> 本文件的存在理由:hw-topo 侧需要在**没有 RTLens 仓库工作副本**的机器上(以及离线 review 时)仍能对照实现。
> 本文件是参考文档,不是营销文案:每个字段、每条规则都对应可检查的实现行为。

读者有两类:

1. 实现 `scan --backend rtlens` / `--evidence <file>` 适配器的人;
2. 审阅回执(HTML 横幅 / wiki 页眉 / `.receipt.json`)里 `provenance` 是否如实的人。

两端实现(截至本镜像编写时):生产者 `rtlens/evidence.py`;消费者 `hw-topo/lib/evidence-adapter.mjs`
(转录)与 `hw-topo/lib/rtlens-backend.mjs`(后端选择与降级)。

---

## 0. 为什么需要这份契约

rtlens 与 hw-topo 各自实现了"从 RTL 源码提取结构事实"的能力。两套实现的**事实一致**(实测同一 fixture:
3 文件 / 6 模块 / 7 例化,数字完全相同),但**坐标系统不同**:

| 事实 | hw-topo 内置扫描器(`builtin`) | RTLens 索引(`rtlens`) |
|---|---|---|
| `module dma_engine` | `dma_engine.v:4` | `…\dma_engine.v:3` |
| `module hsb_top` | `hsb_top.v:6` | `…\hsb_top.v:5` |
| `instance hsb_top dut` | `dma_engine.v:50` | `…\dma_engine.v:49` |

即:**1-based + root 相对 POSIX** vs **0-based + 绝对路径**。

后果不是"不好看",而是**致命**:把 rtlens 的行号直接喂进 hw-topo 的 `verify` 反幻觉门禁,
13 个元素全部判 `broken`,`hallucinationRisk = 1.0`,门禁拒绝交付(exit 1)——
**两个反幻觉门禁互相指控对方在造假,尽管底层事实完全一致。**

契约的作用:让坐标转换只发生**一次**,发生在唯一一处边界(适配器)上,且**永不靠猜**。

---

## 1. 硬性规则(R1–R6)

| # | 规则 | 违反后果 |
|---|---|---|
| **R1** | 行号**双基准同时给出**:`line0`(0-based,LSP/词法器原生)与 `line1`(1-based,编辑器/人类/hw-topo spec)。恒有 `line1 == line0 + 1`。 | 消费方各自假设基准 → 全局差 1 → 证据全废 |
| **R2** | 证据路径 `file` 恒为 **root 相对 POSIX**(正斜杠、无盘符、无前导 `/`、无 `..`)。绝对路径另有字段 `absPath`,不得混用。 | 跨机器/跨平台不可复现;`resolveInsideRoot` 拒绝读取 |
| **R3** | 每个源文件带 `sha256`(原始字节)。 | 无法检测源码漂移,`verify` 的 `broken` 判定失去依据 |
| **R4** | 证据中**禁止出现裸 `line` 字段**。消费方必须显式选 `line0` 或 `line1`。 | 默认值猜测 → 回到 R1 的坑 |
| **R5** | 同一个 spec 的 `scan` 与 `verify` **必须同后端**;后端身份写入 `provenance`。 | 两个后端交叉验证 → 假 `broken` 洪水 |
| **R6** | 降级**必须显式**:`provenance.degraded = true` + `reason`,并出现在回执、HTML、wiki 中。 | 静默降级 = 用户以为拿到了索引级证据,实际是正则级 |

关于 R1 的强制做法:`line1` 不是"转换出来的方便字段",而是**契约的一部分**——生产者必须同时产出两者,
消费者必须挑一个并**写明挑了哪个**。这样任何一方都无法"默认"成错误的基准。

规则落到本仓库的实现锚点(可逐条 grep 验证):

| 规则 | 实现锚点 |
|---|---|
| R1 | `lib/evidence-adapter.mjs` 的 `assertLinePair()`:`line1 !== line0 + 1` 即抛 `off-by-one` |
| R2 | `lib/evidence-adapter.mjs` 的 `isRelativePosix()` / `assertRelativePosix()`,与 `lib/util.mjs` 的 `resolveInsideRoot` 同规则 |
| R3 | `files[].sha256` 直传,不重算 |
| R4 | bundle 里只有 `line`(1-based,由 `line1` 转录),证据包里没有裸 `line` |
| R5 | `lib/rtlens-backend.mjs` 的 `resolveBackend()`;后端身份写进 `bundle.provenance` |
| R6 | `BUILTIN_PROVENANCE()`:任何非 rtlens 路径都置 `degraded: true` + 非空 `reason` |

---

## 2. `rtlens.evidence/1` 结构

生产者(RTLens 侧,唯一出口):

```bash
python -m rtlens evidence <root> --json                    # JSON 到 stdout
python -m rtlens evidence <root> -o evidence.json          # 落盘(可与 --json 并用)
python -m rtlens evidence <root> -D SIM -D W=8 --json      # define 集参与 `ifdef 求值
python -m rtlens evidence <root> -I ../shared --max-signals 4096 --compact --json
```

参数(`rtlens/__main__.py` → `evidence` 子命令):

| 参数 | 语义 |
|---|---|
| `<root>` | 索引根(位置参数) |
| `--json` | **只有带它才把 JSON 打到 stdout**;否则输出人类可读摘要(摘要会提示 "pass --json for stdout") |
| `-o` / `--out <file>` | 额外把信封写到文件 |
| `-D` / `--define NAME[=V]` | 可重复,`+define+` 语义,参与 `` `ifdef`` 求值 |
| `-I` / `--include-path <dir>` | 可重复,额外索引搜索路径 |
| `--max-files <N>` | 索引文件数上限(默认 5000) |
| `--max-signals <N>` | 单模块 signals 转录上限(默认 256,超出打 `signalsTruncated`) |
| `--compact` | 单行 JSON(默认 pretty) |

### 2.1 顶层字段

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `schema` | string | ✔ | 恒为 `"rtlens.evidence/1"`。**唯一漂移守卫**,适配器断言不匹配即拒绝(exit 2) |
| `tool` | object | ✔ | `{ name, version }`,生产者身份(进入 `provenance.tool`) |
| `root` | object | ✔ | `{ abs, separator }`,扫描根绝对路径与分隔符(`abs` 进入 `provenance.rootAbs`) |
| `generatedAt` | string | ✔ | ISO-8601 UTC 毫秒(与 JS `toISOString()` 同格式) |
| `defines` | object | ✔ | 参与 `` `ifdef`` 求值的 define 集。**索引结果随 define 集变化**,必须随证据一起传递 |
| `stats` | object | ✔ | 计数汇总,见 2.3 |
| `files` | array | ✔ | 源文件清单,见 2.2 |
| `modules` | array | ✔ | 模块/接口及其成员,见 2.2 |
| `instances` | array | ✔ | **权威全量**扁平例化表(消费方优先用它) |
| `unresolved` | array | ✔ | 未解析类型(厂商原语/树外依赖),如实分类而非报错 |
| `diagnostics` | object | ✔ | 解析与截断诊断,见 2.4 |

### 2.2 嵌套字段

| 字段路径 | 类型 | 语义 |
|---|---|---|
| `files[].path` | string | root 相对 POSIX(即证据 `file` 的取值域) |
| `files[].absPath` | string | 绝对路径,**仅诊断用**,禁止写入 spec 证据 |
| `files[].bytes` / `lines` | number | 原始字节数 / `text.split('\n')` 行数(与内置扫描器同口径) |
| `files[].sha256` | string | 原始字节 SHA-256(64 hex),漂移检测依据 |
| `modules[].name` / `kind` / `role` | string | 名称 / `module`\|`interface` / `top`\|`leaf-or-mid` |
| `modules[].file` | string | root 相对 POSIX |
| `modules[].line0` / `line1` | number | module 声明行(双基准) |
| `modules[].endLine0` / `endLine1` | number | `endmodule` 行(双基准);恒有 `line0 <= endLine0` |
| `modules[].portCount` | number | 端口数(与 `ports.length` 一致) |
| `modules[].definitions` | number | 同名多定义时的总数(缺失时为 `1`) |
| `modules[].ports[]` | object | `{ name, line0, line1 }` + 可选 `direction` / `width` / `dataType` / `detail`(**空值不出现在 JSON 里**,不是空串保证) |
| `modules[].params[]` | object | `{ name, line0, line1 }` + 可选 `detail` |
| `modules[].signals[]` | object | `{ name, line0, line1 }` + 可选 `detail`;受 `--max-signals` 限制 |
| `modules[].instantiatedBy[]` | string[] | 父模块名列表(去重排序) |
| `modules[].instances[]` | object | 嵌套便利视图,与顶层 `instances[]` **同构同字段** |
| `modules[].signalsTruncated` | boolean | 可选。signals 超上限被截断时的显式标记 |
| `instances[].parent` / `type` / `instance` | string | 父模块 / 被例化类型 / **实例名**(不要从行号反推实例名) |
| `instances[].file` | string | root 相对 POSIX |
| `instances[].line0` / `line1` | number | 例化**语句起始行 = 类型 token 所在行**(见 2.4) |
| `instances[].endLine0` / `endLine1` | number | 该例化语句的收尾行(连接列表右括号所在行);恒有 `line0 <= endLine0` |
| `instances[].resolution` | string | `declared` \| `vendor-primitive` \| `external`(见 2.4 的枚举映射) |
| `instances[].connectionCount` | number | 连接条目数(`.port(...)` 计数) |
| `instances[].connections[]` | object | `{ port, signal, line0, line1 }`;位置连接时 `port` 为**空串**(不编造端口名) |
| `instances[].connectionsTruncated` | boolean | 可选。连接数超上限(默认 256)被截断时的显式标记 |
| `unresolved[].type` | string | 未解析类型名 |
| `unresolved[].classification` | string | **只取 `vendor-primitive` \| `unknown`**(见 2.4) |
| `unresolved[].file` + `line0`/`line1` | string + number | 首次出现位置(双基准) |
| `unresolved[].count` / `parents[]` | number / string[] | 出现次数 / 涉及父模块(最多 16 个) |
| `unresolved[].suggestions[]` | string[] | 可选。近似名字建议 |

### 2.3 `stats` 计数

| 字段 | 语义 |
|---|---|
| `files` / `modules` / `instances` | 由本信封实际产出的数组长度计数 |
| `ports` / `signals` / `params` / `interfaces` / `packages` | 来自索引整体统计(与 `modules[]` 的转录上限无关) |
| `topModules[]` | `role == "top"` 的模块名(去重排序) |

### 2.4 字段语义要点(踩过的坑都在这里)

- **实例行号的精确定义**:`instances[].line0/line1` = 实例化**语句起始行,即类型 token 所在行**,
  **不是**实例名所在行。参数化例化写成多行时两者不同:

  ```verilog
  21:     counter #(            <-- line0=20 / line1=21  证据指向这一行
  22:         .WIDTH(CNT_WIDTH)
  23:     ) u_counter (         <-- 实例名在这一行
  24:         .clk(clk),
  ```

  两个生产者(rtlens 索引 / hw-topo 内置扫描器)都取类型 token 行,因此**天然一致**;
  任何新消费者若假设"指向实例名那行"就会得到错位证据。实例名从 `instance` 字段取,不从行号反推。
- **两个枚举不要混**(这是最容易写错的字段):

  | 字段 | 取值 | 说明 |
  |---|---|---|
  | `instances[].resolution` | `declared` \| `vendor-primitive` \| `external` | RTLens 内部枚举 `workspace`\|`vendor_primitive`\|`unknown` 的**固定名字映射**,不是猜测 |
  | `unresolved[].classification` | `vendor-primitive` \| `unknown` | 只有两档;适配器**拒绝**其它取值(如 `maybe-vendor`),不允许上游改口径 |

  `external` / `vendor-primitive` **不是错误**,是如实分类;不要为了让图"干净"而重分类。
- **`instances[]` 是权威**:顶层的 `instances[]` 是扁平全量列表,自带 `parent`;`modules[].instances[]`
  只是按声明模块分组的便利投影,两者同构同字段(都用 `instance` 表示实例名)。适配器优先用顶层,
  仅当顶层缺失/为空时才回退到嵌套视图,并把实际来源记进 `provenance.instantiationSource`。
- **`endLine0/endLine1`**:例化语句的收尾行(连接列表右括号所在行);模块的 `endLineN` = `endmodule` 行。
  适配器要求 `endLine1 >= line1`,否则抛错。
- **`defines` 必须随证据传递**:`` `ifdef`` 求值依赖 `-D`,不同 define 集**会产生不同的索引结果**;
  `defines` 进入下游 `provenance`,否则同一个 root 会得出两份不同的"事实"。
- **确定性**:`files` 按 root 相对路径排序后转录,同一棵树两次运行产出**逐字节相同**的证据
  (这是它能当"证据"用的前提)。
- **截断与排除都显式**(不静默丢数据):`signalsTruncated`(单模块,`--max-signals`)、
  `connectionsTruncated`(单例化,默认 256)、`diagnostics.signalsTruncatedModules`(计数),
  以及 `-I` 引入 root 之外文件时的 `diagnostics.outsideRootFiles` / `outsideRootCount`
  (**这些文件的证据指针无法被下游 `resolveInsideRoot` 解析,因此整体排除并如实计数**)。
- **`line0` 缺失时的语义**:符号没有行范围信息时 `line0 = 0`(与"文件开头"同义),**不是编造行号**。
- `definitions > 1`:同名模块多处定义(PicoRV32 的 `top` 有 4 处)。hw-topo 侧取首个定义,
  `verify` 按"候选集"匹配而非单点匹配。
- `diagnostics.elaborated` 恒为 `false`:**不做 elaboration**。参数化位宽保持源码文本(`[W-1:0]`),
  宽度是否匹配由 verilator/yosys 判定,不是本契约的职责。
- `ports` / `params` / `instances` **不截断**——它们是拓扑证据的主体;只有 signals 与 connections 有上限。
- interface 与 module 一样计入 `modules[]`(`kind: "interface"`)并可被例化,两边口径必须一致。

---

## 3. hw-topo bundle 映射(适配器职责)

hw-topo 内部证据包(bundle)结构保持不变(`schemaId = "hw-topo.bundle/1"`),由适配器从
`rtlens.evidence/1` **纯转录**得到:

| bundle 字段 | 来源 | 转换 |
|---|---|---|
| `modules[].line` | `modules[].line1` | 直取(禁止 `line0 + 1` 之外的运算) |
| `modules[].endLine` | `modules[].endLine1` | 直取(并要求 `>= line`) |
| `modules[].file` | `modules[].file` | 直取(已是 root 相对 POSIX) |
| `modules[].ports` / `params` | `modules[].ports[]` / `params[]` | 取名字数组(对象或纯字符串都接受,其它类型抛错) |
| `modules[].portCount` | `portCount`,缺失时 | 用 `ports.length` 兜底 |
| `instantiations[]` | 顶层 `instances[]`(优先)或 `modules[].instances[]` | `{ parent, type, instance, file, line: line1 }`;来源记入 `provenance.instantiationSource` |
| `unresolved[]` | `unresolved[]` | `classification` 直传,取值只允许 `vendor-primitive` \| `unknown`;其它取值**抛错**,不改口径 |
| `files[]` | `files[]` | `path` / `bytes` / `lines` / `sha256` 直取 |
| `stats` | 由转录结果**重新计数** | `files` / `modules` / `instantiations` / `unresolvedVendor` / `unresolvedUnknown` |
| `modules[].role` | `modules[].role`,缺失时 | 唯一一处"派生":按"被例化过 → `leaf-or-mid`,否则 `top`"兜底,并把次数记入 `provenance.roleFallbacks` |
| `provenance` | 新增(非 rtlens 字段) | 见 §4 |

**适配器不得引入其它启发式**:不做正则补扫、不做名称归一化、不猜缺失字段。
转录不完整就报错退出,而不是"尽力而为"。唯一允许的派生是上面 `role` 的缺失兜底,且必须被计数。

适配器的拒绝条件(每一条都对应一个抛错点,可对照测试):

| 条件 | 行为 |
|---|---|
| `schema !== "rtlens.evidence/1"` | 抛错并回显实际 schema(`rtlens.evidence/2` → 拒绝,不兼容解析) |
| 证据不是 JSON 对象 | 抛错 `must be a JSON object` |
| 任一坐标缺 `line0`/`line1`,或非整数 | 抛错(R1/R4) |
| `line1 !== line0 + 1` | 抛错 `off-by-one`(定位到具体元素) |
| `endLine1 < line1` | 抛错 `precedes` |
| `file` 非 root 相对 POSIX(反斜杠 / 盘符 / 前导 `/` / `..` / NUL) | 抛错(R2) |
| `modules[].name`、`instances[].parent/type/instance`、`unresolved[].type` 缺失或非字符串 | 抛错 |
| `unresolved[].classification` 非两档枚举 | 抛错 |
| `ports`/`params` 非数组,或条目没有可用名字 | 抛错 |

---

## 4. `provenance`(可追溯性)

两个方向都要记录,并进入 `spec.meta.derivedFrom` 与 `receipt`。基础字段(契约 §4):

```jsonc
"provenance": {
  "backend": "rtlens",              // rtlens | builtin
  "degraded": false,
  "reason": null,                   // degraded=true 时必填
  "evidenceSchema": "rtlens.evidence/1",
  "tool": { "name": "rtlens", "version": "6.2.0" },
  "defines": { "SIM": "1" },
  "rootAbs": "D:\\proj"
}
```

hw-topo 侧额外写入的字段(实现事实,便于审计;消费方必须容忍未知字段):

| 字段 | 语义 |
|---|---|
| `instantiationSource` | `instances[]` 或 `modules[].instances[]`——本次转录实际用了哪一份 |
| `roleFallbacks` | 上游 `role` 缺失、由适配器兜底推导的模块数(`0` = 完全上游权威) |
| `evidenceFile` | 走 `--evidence <file>` 时,记录那份证据文件的路径 |

降级场景:`rtlens` 不可用(python 缺失 / Python < 3.8 / 版本低于 `evidence` 子命令所需 / CLI 非零退出 /
stdout 不是 JSON)时回落到内置正则扫描器:

```jsonc
{ "backend": "builtin", "degraded": true,
  "reason": "rtlens unavailable: python not on PATH",
  "evidenceSchema": null }
```

- `--backend auto`(默认):优先 rtlens;失败则降级,`degraded: true` + `reason` 说明原因。
- `--backend rtlens`:强制证据后端,**不可用即硬失败**(绝不悄悄回落)。
- `--backend builtin`:强制内置扫描器——**显式选择更低证据等级,同样记为 `degraded: true` 并给出 reason**,
  不是"没降级"。

**降级 = 证据等级下降**(正则容错提取 vs 位置不变的词法解析 + 引用追踪)。内置扫描器是兜底,不是等价替代。
降级信息必须出现在三处,缺一即视为静默降级(违反 R6):

| 位置 | 形态 |
|---|---|
| 回执 `.receipt.json` | `provenance.backend` / `degraded` / `reason` |
| HTML 查看器 | 顶部降级横幅 |
| wiki 索引页 | 页眉标注 |

---

## 5. 版本与兼容

- `schema` 字符串是**唯一**的漂移守卫。适配器解析时断言:
  - 不匹配 `rtlens.evidence/1` → **拒绝**(exit 2),不尝试兼容解析。
  - `rtlens` 主版本升级需同步升 schema 号(`rtlens.evidence/2`)。
- 新增**可选**字段不需要升号;消费方**必须容忍未知字段**(镜像里已经出现多个可选字段:
  `detail` / `signalsTruncated` / `connectionsTruncated` / `suggestions` / `instantiationSource` /
  `roleFallbacks` / `evidenceFile` / `diagnostics.outsideRoot*`)。
- 删除 / 改义字段必须升号;**行号基准变更等同于改义字段**,必须升号。
- `evidence` 子命令随 rtlens **6.2.0** 提供;后端探测会拒绝更旧的 rtlens(旧版本没有该子命令)。
- 契约双方各自保留一份本文件;RTLens 仓库内那份是**规范版本(canonical)**。

---

## 6. 必须长期保持的负面测试

`verify` 门禁的 off-by-one 回归:把一份通过验证的 spec 的 `line` 全部减 1、`file` 换成绝对路径
(= 模拟"没走适配器、直接把 rtlens 坐标灌进 spec"),`verify` **必须**失败:

```
elements 13 · backed 0 · broken 13 · hallucinationRisk 1.0 · exit 1
```

另有一条适配器级回归:把一份合法证据的某个 `line1` 减 1,`evidenceToBundle` **必须抛错**
(`off-by-one`),而不是产出平移一行的 bundle。这两条测试是把"不兼容"钉死、不再复发的锚点;
它们存在的原因就是本文件 §0 那张坐标表。

---

## 7. 实现自检清单(逐条可勾选)

- [ ] `schema !== "rtlens.evidence/1"` 时拒绝,错误信息回显实际 schema 字符串。
- [ ] 每一处引用行号都显式取 `line1`;不存在裸 `line` 兜底,也不存在 `line0 + 1` 之外的算术(唯一例外见 `role` 兜底)。
- [ ] 每个坐标对断言 `line1 === line0 + 1`;`endLine1 >= line1`。
- [ ] 证据路径经过 root 相对 POSIX 断言;`absPath` 只出现在诊断输出,绝不进入 spec。
- [ ] `files[].sha256` 直传,不重算、不省略。
- [ ] `-D NAME` 集进入 `provenance.defines`,且 `verify` 复用同一集合与同一后端(R5)。
- [ ] `unresolved[].classification` 只接受 `vendor-primitive` / `unknown`,不改口径。
- [ ] 优先消费顶层 `instances[]`,回退到嵌套视图时记录 `instantiationSource`。
- [ ] `role` 兜底(如有)被计入 `roleFallbacks`,不隐藏。
- [ ] `degraded = true` 时 `reason` 非空,且回执 / HTML / wiki 三处可见(R6)。
- [ ] `--backend rtlens` 下 rtlens 不可用即失败,绝不悄悄回落。
- [ ] 截断(`signalsTruncated` / `connectionsTruncated`)在图上或回执里可见,不静默。
- [ ] 适配器不含正则补扫 / 名称归一化 / 缺失字段猜测。
