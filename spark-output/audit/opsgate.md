# Audit — OpsGate v1（MCP 网关）体验走查

- **生成时间**：2026-11-12
- **走查对象**：代码仓库 `D:\work\opsgate`（frontend/src 全量 + src 后端）+ 隔离实例浏览器实测（端口 8180，独立数据目录）
- **走查模式**：自动（代码逐页读 + 真实浏览器结构走查）+ 竞品对照（本地 mcphub-ref + 网络调研）
- **走查页面数**：17 页 + 7 组件 + 设计系统 + 后端 6 组路由
- **审查三层**：① 产品定义层（Spec/ADR 是否把概念造复杂）② 实现符合度层（偏离设计）③ 体验执行层（视觉/交互）

> 结论先行：**后端能力比前端呈现强得多**。工具列表、实例状态、连通测试、审计多维过滤的 API 都已存在，但前端几乎没接。用户感知的"别扭/复杂/看不到"，大部分是**实现与呈现缺口**，少部分是**产品定义本身的张力**（分类taxonomy、槽位模型、Market 解耦），视觉则是**两套设计语言冲突**导致落成了通用浅色模板。

## 总览

| 严重度 | 数量 |
| --- | --- |
| 🔴 Blocker | 1 |
| 🟠 Major | 21 |
| 🟡 Minor | 14 |

**按维度分布**：

| 维度 | findings 数 |
| --- | --- |
| visibility | 5 |
| real-world-match | 5 |
| user-control | 2 |
| consistency | 4 |
| error-prevention | 4 |
| recognition | 2 |
| flexibility | 4 |
| aesthetic | 2 |
| error-recovery | 2 |
| help-docs | 2 |
| responsive | 1 |
| performance | 3 |

---

## 三层诊断（回答"为什么不理想"）

### 层 1 · 产品定义层（概念本身的张力）

1. **分类 taxonomy 与目录内容错配**。`category` 枚举为运维场景设计（host/mysql/k8s/other），但 Market 收录的是通用 MCP（filesystem/memory/playwright/fetch…）。实测 13 条中 **10 条落在 other**，分类筛选几乎失效。这是定义层问题，不是实现 bug。
2. **槽位模型只认"整值 `${VAR}`"**。`detectSlots` 用 `^\$\{NAME\}$` 整值匹配；args 里内嵌密钥、config 文件路径、嵌套 JSON 配置都无法纳管 → 明文落库、原样执行、无提示。这正是用户担心的"schema 表单兼容性/拓展性"根源：4 字段槽位 `{target,name,label,file}` 表达力有限。
3. **凭证类型硬编码**。前端 `CRED_TYPES` 8 种、键名写死（host/username/password、access_key/secret_key…）。新增凭证形态要改代码 → "硬造 schema 表单"的观感来源。
4. **Market 实例化后彻底解耦（ADR-003）**。无升级/刷新路径、添加前无工具预览、`verified` 是手动状态机而非强制测试通过 → 用户"没信心新增的就能用"。定义上解耦是对的（运行时稳定），但**缺少"添加前可见工具 + 发布前强制连通"两个信心锚点**。

### 层 2 · 实现符合度层（后端有、前端没接 / 偏离 Spec）

- 资产详情**无工具列表、无连接/实例状态、无调用统计/审计 Tab**（Spec §8.5 要求四 Tab）。后端 `GET /:id/tools/raw`、`GET /:id/instances`、`POST /:id/test` 全在，前端只接了 4 个 API。
- 概览页落成**通用统计卡**，违反自身 §8.1/§8.5"首屏反模板"（应为安全状态条+热资产+高危事件流+端点复制）。
- 审计页只有七列表格；后端支持的时间/风险过滤、详情、统计均未暴露；筛选要**手贴 UUID**。
- 资产列表"可见范围"列是裸文本 `owner/group/public`，**违反 §8.6 V1/V2**（public 必须琥珀警示徽章）。
- 首启**不 seed Market**（仅 `pnpm run seed`），新部署目录为空 → 管理员被迫手写 JSON 条目。

### 层 3 · 体验执行层（视觉/交互）

- **两套设计语言冲突**：Spec §8 是"深色机房控制台、钢青蓝、hairline、无阴影、密度7"；实际 `styles.css` v3 是"浅色通用 SaaS、#4f7cff、rounded-xl、软阴影、hover 上浮"。默认浅色 → 用户看到的就是"古老/模板性"后台。
- **下拉全是原生 `<select>`**（无搜索/无键盘导航）；自研凭证下拉**任意滚动即关闭**、无键盘支持。
- **无 toast/成功反馈系统**；错误仅内联红字。动效只有页面级 fade/slide，交互级（下拉/Tab/提交）无反馈 → "没任何动效/没反馈"。
- 模态**无焦点圈定**、backdrop 点击即丢未保存表单。

---

## 改版机会点（按优先级）

### 🥇 高优先级

**O1 · 重建"添加→可见→可信"闭环（资产/Market）**
- 关联：audit-2, audit-34, audit-4, audit-23
- 理由：直接对应用户痛点 4（看不到工具/状态）与痛点 2（没信心）。后端 API 已具备，纯前端接线 + 状态点 + 工具预览，投入产出比最高。
- 范围：资产详情加"工具/状态/统计/审计"Tab；Market 详情添加前展示工具清单；列表行内状态点 + 自适应轮询（借鉴 mcphub）。

**O2 · 添加流程降门槛 + 提交可靠性**
- 关联：audit-35, audit-36, audit-20, audit-14, audit-15
- 理由：对应痛点 2（新增麻烦）。首启自动 seed、条目结构化表单 + JSON 粘贴批量导入（mcphub 已有）、提交防重复 + 原子化。
- 范围：boot seed；MarketEntries 表单化/JSON 导入；AssetCreateModal 增加 mcpServers JSON 导入；instantiate+绑值合并为单事务端点。

**O3 · 统一设计语言，去模板化**
- 关联：audit-11, audit-21, audit-22, audit-18, audit-1, audit-8, audit-26
- 理由：对应痛点 1（样式古老/反人类/无动效）。先裁决"深色控制台 vs 浅色 SaaS"单一语言，再补 combobox/toast/焦点圈定/响应式。
- 范围：设计令牌收敛；自定义 Combobox/Toast/Modal（焦点圈定+dirty 保护）；交互级动效；<768px 降级。

**O4 · 凭证/槽位模型数据驱动 + 收敛明文回显（含安全）**
- 关联：audit-32, audit-33, audit-17, audit-30, audit-10
- 理由：对应痛点 3（兼容性/拓展性）+ 一个 Blocker 安全缺口 + 一个解绑误删 bug。
- 范围：inlineValue 仅归属人/admin 可见或掩码；解绑按 (slot,credential) 精确删除；凭证类型/槽位注入目标数据驱动。

### 🥈 中优先级

**O5 · 把审计/概览做成差异化卖点**
- 关联：audit-3, audit-6, audit-23, audit-24
- 理由：审计是本项目相对竞品的差异点，但 UI 最薄。补五要素详情展开、时间/风险筛选、名称化筛选、导出、概览安全状态条。

**O6 · 列表性能与响应式**
- 关联：audit-27, audit-28, audit-29, audit-26
- 理由：资产列表 N+1（每行一个 /slots 请求）、搜索无防抖、单 520KB bundle、无断点。

**O7 · 术语与状态语义人性化**
- 关联：audit-5, audit-7, audit-12, audit-13, audit-16, audit-31
- 理由：裸枚举/内部 ADR 文案/琥珀语义误用/分类错配，统一映射中文标签与正确状态色。

---

## 完整 Findings 清单

### visibility
1. **[major]** 无 toast/成功反馈系统，创建/绑定/保存后无确认。证据：`frontend/src/api.ts`（无 toast）、各页仅 `setErr`。建议：全局 ToastProvider。成本 medium。
2. **[major]** 资产详情无工具列表/连接状态/实例态。证据：`AssetDetail.tsx:12-25,68-97`；后端 `src/routes/assets.ts:688-715,602-616` 已存在。建议：接 tools/raw + instances + 状态点。medium。
3. **[major]** 概览为通用统计卡，缺安全状态条/热资产/高危事件流/端点复制。证据：`Overview.tsx:19-58` vs Spec §8.5。medium。
4. **[minor]** 运行时页无自动刷新、仅实例池（缺 SSH 池/暂存区）。证据：`Runtime.tsx:16`。medium。
34. **[major]** Market 添加前无工具预览、verify 不强制测试 → 信心不足。证据：`MarketDetail.tsx`（无 tools）、`marketAdmin.ts:477-488`。medium。

### real-world-match
5. **[major]** 裸枚举直示：visibility/type/executionMode/category/slot target/configHash。证据：`Assets.tsx:101-104`、`AssetDetail.tsx:63,69-75`。quick-win。
6. **[major]** 审计筛选需手贴用户/资产 UUID。证据：`Audit.tsx:90-92`。medium。
7. **[minor]** 用户文案暴露内部 ADR 编号。证据：`Settings.tsx:41`、`Credentials.tsx:137`、`Groups.tsx:50`。quick-win。
31. **[major]** 分类 taxonomy 与通用目录错配（10/13 other）。证据：实测 Market 分类聚合。medium。
36. **[major]** 管理员新增条目需手写两段 JSON（installations+slotLabels）。证据：`MarketEntries.tsx:297-302`。medium。

### user-control
8. **[major]** 模态 backdrop 点击丢未保存表单、无焦点圈定。证据：`Modal.tsx:40`。medium。
9. **[minor]** 凭证下拉任意窗口滚动即关闭。证据：`SlotValueEditor.tsx:52-54`。quick-win。

### consistency
10. **[major]** 解绑 DELETE 按 (server,slot,user) 删，误删同槽本人多条绑定；UI 却按 (slot,cred) 确认。证据：`assets.ts:479-488` vs `SlotBinder.tsx:116-120`。quick-win。
11. **[major]** 两套设计语言冲突（Spec §8 深色 vs styles.css v3 浅色）。证据：`styles.css:30-103` vs Spec §8.3。major-rework。
12. **[minor]** 琥珀语义误用：被引用数 >0 才琥珀（应 0 琥珀）；"已添加"用 badge-warn。证据：`Credentials.tsx:243`、`MarketDetail.tsx:267`。quick-win。
13. **[minor]** 硬编码 hex 回退 `var(--warning,#b45309)` 违反 token-only。证据：`Credentials.tsx:18`、`CredentialDetail.tsx:23`。quick-win。

### error-prevention
14. **[major]** MarketDetail"添加并绑定"无 disabled，可重复提交建重复资产。证据：`MarketDetail.tsx:357`。quick-win。
15. **[major]** 创建非原子：instantiate 后循环 PUT 绑值，部分失败留下半成品。证据：`MarketDetail.tsx:141-170`、`AssetCreateModal.tsx:143-211`。medium。
16. **[minor]** 成员身份 select 变更即生效，无提权确认。证据：`Users.tsx:157-166`。quick-win。
30. **[blocker]** `GET /slots` 向任何可见者返回解密 inline 明文（注释称仅归属人/admin 但无校验），visibility 放宽即泄露，违反 write-only UI。证据：`assets.ts:425-446`。quick-win。

### recognition
17. **[major]** 凭证匹配失败提示"需含键 X"行话、无创建引导、匹配规则不可见。证据：`SlotValueEditor.tsx:90-93,169-172`。medium。
18. **[minor]** 全原生 select，长列表无搜索。证据：`AssetCreateModal.tsx:289-299`。medium。

### flexibility
19. **[minor]** 无 ⌘K/快捷键、无资产批量操作（Spec 承诺）。证据：`App.tsx` header、`Assets.tsx`。medium。
20. **[minor]** 无 mcpServers JSON 粘贴/批量导入（mcphub 有）。证据：`AssetCreateModal.tsx`。medium。
32. **[major]** 槽位仅整值 ${VAR}，内嵌密钥/文件路径/嵌套 JSON 不纳管。证据：`marketCatalog.ts:60-105`、`slots.ts`。major-rework。
33. **[major]** 凭证类型硬编码 8 种、键名写死。证据：`Credentials.tsx:46-73`。medium。

### aesthetic
21. **[major]** 通用浅色 SaaS 模板观感，默认浅色，与定位不符。证据：`styles.css`、登录截图。major-rework。
22. **[minor]** 全局 hover 上浮（btn -1px / card -2px）玩具感。证据：`styles.css:233,473`。quick-win。

### error-recovery
23. **[major]** 加载/错误/空态混淆：AssetDetail/CredentialDetail 查询错误无限转圈；Assets/Audit 错误显示"空"。证据：`AssetDetail.tsx:27-37`、`CredentialDetail.tsx:50-60`、`Assets.tsx:88`、`Audit.tsx:171`。medium。
24. **[minor]** 无全局 401 处理，会话过期不跳登录。证据：`api.ts:10`。quick-win。

### help-docs
25. **[minor]** 槽位/凭证概念无 inline 帮助；首启空目录无管理员引导。证据：`Market.tsx:95-103`。medium。
35. **[major]** 首启不 seed Market，新部署目录为空。证据：`seed.ts:121` 仅手动；实测空。quick-win。

### responsive
26. **[major]** 无响应式断点，固定 240px 侧栏+宽表，<768px 破坏。证据：`App.tsx:80-92`、`styles.css`。medium。

### performance
27. **[major]** 资产列表 N+1：每行一个 /slots 请求（50/页）。证据：`Assets.tsx:15-22`。medium。
28. **[minor]** 搜索逐键触发请求，无防抖。证据：`Assets.tsx:66`、`Market.tsx:60`、`Audit.tsx:90`。quick-win。
29. **[minor]** 单 520KB bundle 无代码分割。证据：vite build 输出。medium。

---

## 竞品对照（要点）

mcphub（OpsGate 的参考实现）已具备而 OpsGate UI 缺失：卡片展开**工具列表+逐工具开关+inputSchema 自动表单页内试调**、**四态状态点+自适应轮询**、**JSON 粘贴批量导入+逐条反馈**、**SSE 日志**、**Activity 审计统计+多维过滤**。Docker Toolkit/Obot/Smithery 共性：catalog 一键安装、secret 只见名不见值、审计按角色限阅。→ OpsGate 的差距主要在**呈现层**，后端并不缺。

## 下一步建议

- 先修 Blocker（audit-30 明文回显）与两个 quick-win bug（audit-10 解绑误删、audit-14 重复提交）。
- 高优先 O1/O2 直接对应用户四大痛点，且后端已具备，建议作为下一任务包主体。
- O3 设计语言需先由用户裁决"深色控制台 vs 浅色 SaaS"，再统一令牌与组件。
- 定义层（分类/槽位/凭证类型/Market 解耦）走新增 ADR，不就地改写 Spec。