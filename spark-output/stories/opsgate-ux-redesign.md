# Stories — OpsGate 可信·可见·低门槛改版

- **生成时间**：2026-11-12
- **数据源**：spark-output/context/audit.json（36 findings / 7 机会点）+ Spec §2.2 三类用户
- **Persona**：陈涛（30 岁一线运维工程师，用 agent 排障）· 林岚（38 岁运维主管，怕授权绕过）· 赵敏（35 岁安全合规专员，要追溯/轮换）
- **Direction**：把 OpsGate 从"能用的网关"改造成"可信、可见、低门槛的运维 MCP 控制台"

## Story 索引

| # | 标题 | 颗粒度 | 优先级 | 关键假设 | 对应任务 |
| --- | --- | --- | --- | --- | --- |
| 1 | 直填密钥不再对普通成员露明文 | Story | P0 | ⭐ | T1 |
| 2 | 解绑只移除我点的那一条 | Micro | P0 | — | T1 |
| 3 | 添加不建重复/半成品 | Story | P0 | — | T1 |
| 4 | 添加后立刻见工具与通断 | Story | P0 | ⭐ | T2 |
| 5 | 列表行内见在线/缺失/全员可见 | Micro | P1 | — | T2 |
| 6 | 市场添加前见工具、发布强制测试 | Story | P0 | ⭐ | T3 |
| 7 | 首启有目录、管理员不手写 JSON | Story | P1 | — | T3 |
| 8 | mcpServers JSON 批量导入 | Story | P1 | — | T3 |
| 9 | 统一控制台质感+可搜索下拉+toast | Story | P1 | — | T4 |
| 10 | 凭证匹配可解释、形态数据驱动 | Story | P1 | — | T5 |
| 11 | 审计名称化筛选+五要素+导出 | Story | P1 | — | T6 |
| 12 | 概览首屏回答授权风险 | Story | P1 | — | T6 |
| 13 | 列表不卡顿、术语人话 | Micro | P2 | — | T7 |

---

**1 · 共享资产的直填密钥不再对普通成员露明文**
- Persona：赵敏。JTBD：当资产被共享给分组，赵敏想确保成员只能用密钥而不能看到密钥，从而共享不变成泄密。
- 主体：作为赵敏，我想要直填密钥对非归属人掩码，从而放心把资产共享出去。
- 完成标准：成员见掩码；归属人/admin 受控看明文且留审计；接口不向可见者返回他人明文。
- 触点：screen:/assets/:id · component:SlotBinder · state:masked/revealed · pattern:write-only。
- 诚实看法：这是 Blocker，先于一切体验改版。参考：Docker secret 只见名不见值。

**2 · 解绑只移除我点的那一条绑定**
- Persona：陈涛。JTBD：当一槽绑了我两条凭证，陈涛想只解绑点的那条，从而不误伤另一条。
- 完成标准：只删该条；同槽其他本人绑定保留；他人绑定不受影响。
- 触点：screen:/assets/:id · component:SlotBinder · state:confirm · pattern:per-row-destructive。
- 诚实看法：现状按 (server,slot,user) 删是正确性 bug，quick-win。

**3 · 添加资产不会因手抖或重试建出重复/半成品**
- Persona：陈涛。JTBD：当网络慢或绑值失败，陈涛想安全重试，从而不留半成品也不建重复。
- 完成标准：提交中禁用+加载态；创建+绑值原子化；失败给可行动提示。
- 触点：screen:/market/:key、AssetCreateModal · component:Button/Toast · state:loading/error · pattern:atomic-submit。
- 诚实看法：需后端单事务端点，前端防重复只是表层。

**4 · 添加后立刻看到这台资产有哪些工具、通不通** ⭐
- Persona：陈涛。JTBD：当刚实例化一个资产，陈涛想立刻看到工具与状态，从而确认它真的能用。
- 完成标准：有工具列表；有状态点（就绪/启动中/失败/空闲）；可试调/连通测试见结果。
- 触点：screen:/assets/:id · component:ToolList/StatusDot/Tabs · state:loading/ready/failed/empty · pattern:test-call。
- 诚实看法：后端 tools/raw、instances、test 全在，纯接线，ROI 最高。参考 mcphub 卡片展开+页内试调。

**5 · 列表行内一眼看出在线/凭证缺失/全员可见**
- Persona：林岚。JTBD：当扫列表，林岚想不点详情就确认授权与状态，从而一眼排雷。
- 完成标准：全员可见琥珀徽章（图标+文字）；状态双通道行内；可按可见范围筛选。
- 触点：screen:/assets · component:Badge/StatusDot/Filter · pattern:inline-security。
- 诚实看法：现状裸文本违反自身 §8.6 V1/V2，属 P0 规则回补。

**6 · 从市场添加前就能看到它将提供的工具** ⭐
- Persona：陈涛。JTBD：当挑一个 MCP，陈涛想添加前看到工具、发布前确认连通，从而有信心。
- 完成标准：添加前工具清单；verified 强制测试通过；添加后直达详情见工具/状态。
- 触点：screen:/market/:key · component:ToolList/VerifyGate · pattern:confidence-anchor。
- 诚实看法：verify 手动状态是信心缺口，需后端强制，定义层补两个锚点。

**7 · 新部署打开市场就有目录；管理员不手写 JSON 收录新 MCP**
- Persona：林岚。JTBD：当全新部署或收录新 MCP，林岚想开箱有目录、表单化收录，从而不被 JSON 劝退。
- 完成标准：首启自动 seed；结构化表单/JSON 粘贴；草稿测试后才发布。
- 触点：screen:/market、/market/entries · component:EntryForm/JsonImport · pattern:guided-admin。
- 诚实看法：首启不 seed + 手写两段 JSON 是"新增麻烦"直接来源。

**8 · 把现有 mcpServers JSON 一次粘贴批量导入**
- Persona：陈涛。JTBD：当手里有客户端配置，陈涛想一次迁移，从而不逐个手填。
- 完成标准：粘贴预览校验；逐条成功/失败反馈；占位符自动识别槽位。
- 触点：AssetCreateModal · component:JsonImport/Preview · pattern:batch-import。
- 诚实看法：mcphub 已有，OpsGate 缺失抬高迁移成本。

**9 · 界面是现代克制高密的开发者工具**
- Persona：陈涛。JTBD：当日常操作，陈涛想要醒目、清晰、有图标有反馈的界面，从而不觉得古老别扭。
- 完成标准：暗优先+亮色跟随系统，Linear/Vercel/Railway 质感；下拉可搜索/键盘、模态焦点圈定+dirty 保护、⌘K 面板；toast+状态配图标/文字；<1024 侧栏抽屉。
- 触点：global · component:Combobox/Toast/Modal/CommandPalette/StatusBadge · pattern:design-system。
- 诚实看法：已拍板方向；真问题是不醒目/字体模糊/缺图标。纯前端重构，src/ 零改动。

**10 · 凭证匹配失败知道为什么去哪补；新形态不用等发版**
- Persona：陈涛。JTBD：当无匹配或要加新凭证，陈涛想被解释并自助补齐，从而不被模型卡住。
- 完成标准：匹配失败解释+引导创建；凭证类型数据驱动；槽位注入边界明示或扩展。
- 触点：/credentials · component:SlotValueEditor/CredForm · pattern:data-driven。
- 诚实看法：硬编码 CRED_TYPES 与整值槽位是拓展性瓶颈，走 ADR。

**11 · 审计能按人/资产名/时间/风险筛出并展开五要素、导出**
- Persona：赵敏。JTBD：当追溯高危操作，赵敏想按名称/时间/风险筛出并看全五要素，从而回答"谁干了什么"。
- 完成标准：名称选择器筛选；时间+风险筛选；行展开五要素+导出。
- 触点：/audit · component:Filter/DetailExpand/Export · pattern:five-elements。
- 诚实看法：后端过滤已具备，前端未暴露；审计是差异点但 UI 最薄。

**12 · 概览首屏直接回答现在有没有授权风险**
- Persona：林岚。JTBD：当每天打开控制台，林岚想第一眼看到授权风险，从而不用翻列表。
- 完成标准：安全状态条非零琥珀可点击；热资产+高危事件流；端点复制区。
- 触点：/overview · component:SecurityBar/EventFeed · pattern:anti-template。
- 诚实看法：现状通用统计卡违反自身首屏反模板规则。

**13 · 资产列表翻页搜索不卡顿，术语是人话**
- Persona：陈涛。JTBD：当翻 50/页列表，陈涛想要流畅与人话标签，从而不卡顿不困惑。
- 完成标准：批量槽位状态（去 N+1）；搜索防抖+路由分割；枚举/ADR 文案中文化。
- 触点：/assets · component:Table/Filter · pattern:perf。
- 诚实看法：N+1 与无防抖是卡顿直接来源，quick-win 集合。