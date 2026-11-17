# 广告平台账单对账工作台（Platform Bill Reconciliation Workbench）

面向财务分析员的**平台账单 × 内部活动记录对账**前端应用。基于 React 18 + TypeScript + Vite + ECharts 实现，纯前端工程（无后端依赖，解析与对账为纯函数引擎，服务层以异步模块模拟），导入批次、字段对应、运行版本、调整凭证与财务确认通过 `localStorage` 持久化。

> 本功能**只核验费用数据，不执行支付、开票或财务记账**。
> 正式核平固定在平台原生的**账户 / 日期 / 币种**粒度；只有平台提供**可核验**活动拆分时才确认活动级金额，无法拆分的余额留待核，不伪装成逐活动实收。

---

## 1. 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript 5（strict） |
| 构建 | Vite 5 |
| 图表 | Apache ECharts 5（独立分包） |
| 路由 | react-router-dom 6（HashRouter，兼容静态托管） |
| 状态 | zustand 4（persist 中间件，localStorage） |
| 金额 | 全量整数（各币种最小货币单位）+ BigInt 定点汇率换算，杜绝浮点误差 |
| 测试 | Vitest（金额换算 / 解析受理 / 对账引擎 / 版本确认 / 存储工作流 / 竞态 / SSR 冒烟） |
| 部署 | 多阶段 Dockerfile + docker-compose（nginx 托管 SPA） |

币种小数位与汇率精度**由输入口径登记**（如 JPY=0 位、USD/CNY=2 位、汇率 6 位小数），换算逻辑不写死任何币种。

---

## 2. 本地启动

### 2.1 开发模式

```bash
npm install --no-audit --no-fund
npm run dev
# 打开 http://localhost:5173
```

### 2.2 生产构建与本地预览

```bash
npm run build      # tsc -b 类型检查 + vite 构建，产物在 dist/
npm run preview    # 静态预览，http://localhost:4173
```

### 2.3 一键容器启动（交付物要求）

```bash
docker compose up -d --build
# 打开 http://localhost:8080 ；停止：docker compose down
```

Dockerfile 为多阶段构建：node:22-alpine 构建 → nginx:1.27-alpine 托管 `dist/`，`nginx.conf` 已配置 SPA history 回退与静态资源缓存。

> 说明：当前隔离沙箱内 Docker daemon 不可用，容器镜像未在本环境实际构建；`npm run build` 产物与 nginx 配置均已通过静态检查，Dockerfile/compose 为标准多阶段写法。

### 2.4 运行测试

```bash
npm test           # 等价于 vitest run，共 7 个测试文件 61 个用例
```

---

## 3. 测试账号（顶栏右上角可随时切换，模拟登录）

| 身份 | 账号 | 权限 |
| --- | --- | --- |
| 财务分析员 A | **林岚（U-1001）** | 导入文件、维护字段对应、创建对账运行与调整 |
| 财务分析员 B | **高航（U-1002）** | 补入迟到贷项、修订映射与汇率，产生新版本运行 |
| 财务负责人 | **赵明（U-2001）** | 分级确认（账户总额 / 活动归属）、并发差额复核、分区结账 |

无需密码；所有操作在同一演示数据集上进行，侧边栏「重置演示数据」可回到初始状态。

---

## 4. 推荐验证路径（覆盖全部需求/验收场景）

初始三个示例文件（平台账单 CSV、内部小时活动 CSV、服务日汇率 CSV）在应用加载时**与用户导入走同一套解析管线**进入受理账，并非写死结果。

### 场景 0：创建首个核平运行 V1

- 进入 **对账运行** 页 → 点击「创建首个对账运行（V1）」。
- 预期：9 个账户日分区（3 账户 × 3 天 × 3 币种）；2 个阻断（JP 11-03 账单来源缺失、US 11-03 日账与活动差 20 USD）；1 条日内迁移软警告（CN 11-03 投放位 PL-CN-9）。

### 场景 1：文件导入、字段确认与拒绝行预览

- **数据导入与字段对应** 页选择任一示例文件或自行上传 CSV/JSON：预览列含义、按别名自动匹配字段对应、可手动修正并「保存字段对应」。
- ④ 受理账批次中点「查看原始行」：可看到被拒绝的原始行（坏日期、币种与账户固定币种不符、超精度金额/汇率、缺明细时间等）与重复件留痕。
- 可自行构造坏数据粘贴验证：拒绝行保留原始内容与原因，不进入后续对账。

### 场景 2：同额重复件（去重，不相加）

- 对账运行页执行「导入重复件批次并重算」。
- 预期：导入回执显示 2 件重复（一条同额同号、一条换号同业务键）；新运行 **行级比较** 出现 2 条「重复候选」；CN 11-01 更正后金额仍为 **15,000.00 CNY**，未被翻倍。

### 场景 3：同号更正件（修订候选，只重开受影响分区）

- 执行「导入 JP 同号更正件并重算」（B-JP-3001 修订号 1→2，120000→118000 JPY）。
- 预期：受理为**修订候选**而非重复件，旧修订行留痕；运行状态 `reopened`；仅 `ACC-JP-03 / 2026-11-01` 重算为 118000 JPY，其余 8 个分区标记「继承旧版本」，月结分区继续有效。

### 场景 4：日内活动迁移（活动级待分配，账户级仍核平）

- **核平报告** 页点击 `ACC-CN-01 / 2026-11-03` 分区行下钻。
- 预期：运行软警告写明投放位 PL-CN-9 当天由 C-CN-C 切换到 C-CN-D；因平台日账单无法拆出两个区间金额，两条活动行均为**待分配（midday_switch）**；该分区账户级仍显示「核平」，未归属余额 3,000.00 CNY 完整留待核。

### 场景 5：跨币种服务日汇率与舍入差额

- 报告页查看 `ACC-US-02 / 2026-11-02`：两行 USD（250.55 + 549.45）逐行按服务日汇率 7.123457 换算，**逐行换算合计与汇总换算之差 1 分**单独列示，不塞给任何活动。
- `ACC-JP-03 / 2026-11-01`：120000 JPY（零小数币种）@0.047823 = 5738.76 CNY；汇率按账户币种 + 服务日逐分区选取，不存在总账单平均汇率。

### 场景 6：迟到部分贷项（关联原账单行，不冲减其他活动）

- 先在 **调整与财务确认** 页确认并结账 `ACC-US-02 / 2026-11-02`，再回对账运行页执行「补入迟到部分贷项并重算」（B-US-2004，-100.00 USD，关联原单 B-US-2002）。
- 预期：已结账分区不回改（继承旧版本），同时生成 1 张**调整凭证**（-100 USD，标准金额 -712.35 CNY，凭证关联原账单行）；其他活动的已确认费用不变。未结账时同贷项会把该分区更正后金额改为 700.00 USD（贷项字段 -100.00）。

### 场景 7：汇率修订与确认并发复核

- 执行「替换为汇率版本 B 并重算」（JSON，仅 USD 2026-11-02 改为 7.130000）。
- 预期：影响预览只列出 1 个新旧差额分区（+524 分）；新运行仅该分区重开（标准金额 5704.00），同日其他币种与其他 USD 日期继承。调整页确认弹窗中填入不一致的新旧差额 → 确认状态为「待复核」，复核通过前不得结账。

### 场景 8：分级确认与不平阻断

- 调整页：平衡分区可分别「确认账户总额」与逐活动「确认活动归属」；待分配活动的活动级按钮禁用；阻断分区（US 11-03、JP 11-03）任何确认都被拒绝，提示「禁止标记已核清」。
- 单一映射缺口不会卡住其他已核账单；账户确认与活动确认互不依赖。

### 场景 9：差异下钻与导出、账户隔离

- 报告页五类行级比较（已相等 / 来源缺失 / 重复候选 / 口径不同 / 真实金额差异）均带账单金额、内部金额与文字说明；分区下钻可追溯到来源账单行（含修订号、关联原单）与汇率版本。
- 三个导出按钮分别导出账户日核平、活动归属、行级比较 CSV。
- 修改 JP 账户后，CN/US 账户分区数值与继承关系完全不变（自动化测试 `账户隔离` 用例固化）。

---

## 5. 关键约束与实现对照

| 需求约束 | 实现位置 |
| --- | --- |
| 受理账保存原始行与账期；按账户+账期+摘要去重 | `engine/dedup.ts` + `store/useAppStore.ts` 受理流程；批次保留 `rejected/duplicates` 原始行 |
| 同编号金额改变 = 修订候选，不丢弃也不相加 | `decideIngestion` + `effectiveBillRows`（最高修订号生效，旧行留痕） |
| 先拆账户币种再按服务日汇率标准化，禁止平均汇率 | `engine/fx.ts` 逐 (币种, 服务日, 版本) 选取；`engine/reconcile.ts` 按分区换算 |
| 币种小数位/汇率精度由输入口径决定 | `lib/constants.ts` 币种登记；`lib/money.ts` BigInt 定点换算，超精度拒绝 |
| 逐行换算与汇总舍入差额分别列示 | `roundingDiff()`；`AccountDayResult.roundingDiffMinor` |
| 原生账户/日期粒度为正式核平；活动级仅确认可核验拆分 | `buildReconcileRun` 中 `platform_verifiable / estimated_share / midday_switch / unallocatable_balance` 四口径 |
| 占比分配标估算并接受偏差；整数守恒 | `allocateByBps`（末行承接尾差）；活动行 `estimated=true` |
| 日内迁移保留映射区间；不可拆则活动级待分配、账户级仍核平 | `deriveMappingIntervals`；迁移为软警告 `run.warnings` 而非阻断 |
| 已确认+估算+未归属 = 账户日更正后金额 | `checkInvariant` + 每分区 `invariantHeld`（测试全量校验） |
| 五类行级比较 | `LineComparison`：equal/source_missing/duplicate_candidate/caliber_different/amount_diff |
| 整日更正只重开受影响账户/日期，未受影响分区继承 | `reopenedKeys` + `carriedFromRunId`；store 按触发原因计算重开集合 |
| 迟到贷项关联原账单行；已付款部分生成调整凭证 | `buildAdjustmentVouchers`；`AdjustmentVoucher.linkedBillRowIds` |
| 映射更正仅重开未结账分区 | `previewMappingChange` 区分 `partitions / closedPartitions` |
| 汇率修订与确认并发要求复核新旧差额 | `confirmPartition` 的 `fxReview` → `requires_rereview` |
| 不平禁止标记已核清，差异可追到来源行与换算版本 | `run.blockers` 驱动确认禁用；分区保留 `sourceRowIds/fxRateVersion` |
| 修改一个账户不影响其他账户 | 重开集合按账户日隔离；`versions.test.ts` 账户隔离用例 |
| CSV/JSON 导入、列含义预览、拒绝行、可保存字段对应 | `engine/parse.ts` + `pages/DataIngestionPage.tsx` |
| 旧响应不覆盖新筛选 | `services/api.ts: RequestSeq` + 报告页序号守卫（页面提示丢弃计数） |
| 只核验费用，不支付/开票/记账 | 全站无支付/记账动作；侧边栏与报告页明示边界 |

---

## 6. 测试与实际验证结论

### 自动化测试（实际执行）

```bash
$ npm test
 Test Files  7 passed (7)
      Tests  61 passed (61)
```

- `tests/money.test.ts`（10）：多币种整数解析、BigInt 汇率换算、舍入差额、基点分配守恒。
- `tests/parseDedup.test.ts`（11）：CSV 引号/CRLF、字段别名建议、拒绝行、拆分守恒、重复件/换号候选/修订候选/修订链。
- `tests/reconcile.test.ts`（13）：9 分区核平、四口径活动归属、整数守恒、五类比较、阻断与软警告、更正/重复/贷项/汇率四类版本演进、账户隔离。
- `tests/versions.test.ts`（13）：分级确认、待分配禁确认、并发复核、确认状态机、三类影响预览、调整凭证、账户隔离。
- `tests/storeWorkflow.test.ts`（8）：导入→受理→运行→确认→结账→贷项凭证→汇率修订→字段对应保存全链路。
- `tests/requestSeq.test.ts`（2）：并发请求旧响应 `accepted=false` 被丢弃。
- `tests/smoke.test.tsx`（4）：四个路由 SSR 渲染不抛错。

### 构建与运行（实际执行）

- `npm run build`：`tsc -b` 严格类型检查通过，Vite 构建成功，产物 `dist/`（echarts/react 独立分包）。
- `npm run preview` 静态预览可正常加载（见下节手动验证）。
- 容器构建：本沙箱无 Docker daemon，**未实际执行** `docker compose build`；配置文件已按标准多阶段方式提供，需在具备 Docker 的环境执行第 2.3 节命令验证。

---

## 7. 目录结构

```
src/
├── components/      # EChart 封装、通用 UI（徽章/弹窗/抽屉）
├── data/            # 示例输入文件（账单/活动/汇率 CSV+JSON 原文与预置字段对应）
├── engine/          # 纯函数引擎：parse 解析 / dedup 受理判重 / fx 汇率 / reconcile 核平 / versions 版本确认
├── lib/             # 常量账户口径、定点金额 money、格式化、图表配色、CSV 导出
├── pages/           # 数据导入 / 对账运行 / 核平报告 / 调整与确认 四个页面
├── services/        # 模拟异步 API 与 RequestSeq 竞态守卫
├── store/           # zustand 持久化状态（批次/运行/调整/确认生命周期）
├── types/           # 领域模型类型
└── styles/          # 全局样式
tests/               # Vitest 测试与共享构造辅助
Dockerfile / docker-compose.yml / nginx.conf
```

## 8. 已知边界

- 数据来自浏览器导入与内置示例，持久化位于 localStorage，仅用于单机演示；接入真实后端时替换 `services/api.ts` 与 store 的数据源即可，解析与对账引擎为纯函数可直接平移。
- 跨时区拆日仅在来源包含可验证明细时间（带偏移 ISO-8601 小时行）时允许；只有日级金额时不做任何隐式拆日。
- 平台消耗占比分配始终带「估算」标记，费率与时段差异造成的偏差由使用方在确认环节显式接受，系统不把估算额呈现为实收。
