# Lingtai 市场机会与产品增强研究

**研究快照：2026-09-03**

## 结论先行

Lingtai 最有价值的不是“让 agent 写代码”，而是已经长出来的另一件东西：**在 agent 与 base branch 之间，做一个独立、可回放、能解释“为什么允许这次合并”的控制层**。

这很重要，因为“ticket → agent → PR”本身已经高度商品化：Codex Cloud、GitHub Copilot cloud agent、Claude Code、Cursor、Devin、Factory 和 OpenHands 都能做异步执行、隔离环境、并行任务、人工复核或自动评审；Factory 甚至已经用“model independent、全 SDLC、治理、审计、结果衡量”完整占据了“Software Factory”叙事。Lingtai 若只补并发、更多模型、更多入口和更漂亮的任务板，会变成一个功能更少的同类品，而不是有清晰理由存在的产品。

建议把产品北极星改写成：

> **Your agent writes the change. Lingtai decides whether it may land — and leaves a verifiable receipt.**

中文可表述为：**Agent 负责改代码，Lingtai 负责决定它能不能落地，并留下可验证的凭证。**

围绕这个定位，最值得押注的两个“爆点”是：

1. **Lingtai Receipt：每次合并自动生成可独立验证的“飞行记录/合并凭证”**，证明计划了哪些 gate、实际执行了哪些、证据对应哪个 SHA、使用了哪个 runtime/model/config、谁批准、花了多少、最后合并成哪个 commit。它应能以 PR/issue 卡片和标准 attestation 导出，而不只是藏在本机数据库里。
2. **Outcome Lab：不衡量“agent 写了多少”，而衡量“这次委派是否真的有用”**。把成本、周期、人工等待、返工、revert、后续 regression/incident 与模型、prompt、recipe、gate 版本关联；再用历史任务做 champion/challenger replay。这个方向与现有 Phase 6 一致，但应成为产品主线，而不是最后的附属分析功能。

一个很适合演示传播的组合是：

> **同一张 ticket，让 Claude Code 与 Codex 各跑一次；Lingtai 在同一 base、同一预算、同一组 gate 下比较两个候选，只放行更好的一个，并给出一张任何人都能验证的合并凭证。**

这不是普通的“并行 agent”，而是**有预算、有裁判、有证据、有唯一 merge authority 的 agent 竞标场**。

在做这些之前，有三项更紧急的产品可信度工作：完成 Phase 2 的“两张连续 ticket”实证与 Phase 4 自托管；修正文档与代码已经发生的语义漂移；把 runtime 能力从静态假设改成可探测、可版本化、随 run 留存的事实。

---

## 1. 研究方法与证据边界

本报告先阅读了仓库的 [README](../../README.md)、[design](../design.md)、[roadmap](../roadmap.md)、[reference](../reference.md)、ADR 0013/0016/0018、实验记录，以及 core、runtime、conductor、gates、board 和 CLI 的关键实现。外部研究只使用产品官方文档、官方更新日志、官方仓库 issue/discussion、开放标准原始仓库与原始研究。

“未满足空白”需要谨慎理解：本报告能证明的是**在所审阅的公开文档里没有发现同样的端到端承诺**，不能证明某家厂商的内部或未文档化功能绝对不存在。厂商公布的客户结果属于一手商业主张，不等于独立验证。

---

## 2. Lingtai 当前到底是什么

### 已成立的产品骨架

- 核心闭环是“拿一张 ticket，调用 agent，在固定点运行 action，然后合并到 base”；这在 [ADR 0016](../decisions/0016-the-settled-model.md) 中被明确限定，不是通用工作流引擎。
- append-only Postgres event log 是唯一真相，board、CLI、projection 与 subscriber 都围绕同一记录工作；目前 reference 列出 38 种 event、五类 stream、两个 projection、五个 gate point。
- `GatesResolved` 在执行前记录五个点的完整计划，空点也显式记录；所有 verdict 绑定 `onSha`。这是“计划过但没执行”和“本来就没配置”可被区分的关键，也是 Lingtai 最不寻常的资产。
- conductor 自己管理 mirror、一次性 worktree、claim lease 与按 base branch 串行化的 merge lane；operator 的 checkout 不在信任路径中。
- 已有 Claude Code adapter、process/agent/watch/human/end actions、人工 approve/reject/waive、SSE board、daemon、reconcile、outbox、GitHub webhook 和 macOS 通知。
- 项目自己的真实实验记录了 73 次旧 loop 运行，以及目前少量 Lingtai 端到端运行的成本、turn、失败原因和发现的实现缺陷。这些不是 demo 数据，而是 Outcome Lab 的种子数据。

### 还不能对外承诺的部分

- [roadmap](../roadmap.md) 明确写着 Phase 2 尚未完成“两张连续 ticket 无人工介入地依次落地”；Phase 4 自托管、Phase 5 第二项目/真实并发/sandboxed tier/Codex adapter、Phase 6 replay/feedback 均未完成。
- [Codex adapter](../../packages/runtime/src/codex.ts) 仍是会直接抛错的 stub；当前不是 multi-runtime 产品。
- 当前 integration 不是标准 PR 流：它在自有 worktree 中 merge 后直接 push base（见 [integrate.ts](../../packages/conductor/src/integrate.ts)）。这对单人自动化很干脆，但与绝大多数团队依赖 PR、branch protection、required checks 的流程存在根本张力。
- 当前 board 无认证，项目也明确把 auth、work-item DAG、通用 workflow engine 排除在 roadmap 外。这使它诚实地适合“一个 owner 管自己的机器”，但还不是团队/企业控制面。
- 根包版本为 `0.0.0`、`private: true`，仓库中没有 LICENSE、SECURITY 或 CONTRIBUTING 文件。若目标是外部采用，这不是包装小问题，而是用户无法判断可否使用与如何信任的入口阻塞。

### 需要立即处理的可信度缺口

1. **README 已与 accepted ADR/代码相冲突。** 例如 README 仍展示旧的 gate 数组格式、声称有四种 gate kind、`ProjectPolicySet`、`--tier/--require` policy，以及已删除的 guard/`--no-guard`（[README 574 行起](../../README.md#onboarding-a-repository)）；但 ADR 0016 和当前 schema 已是五个固定 point、无 policy、无 guard。一个以“日志能如实解释实际发生了什么”为卖点的产品，文档本身不能同时描述两个系统。
2. **runtime 能力假设已经落后于上游。** `claude-code.ts` 仍把 Claude Code 的最强能力写成 `guarded`，理由是“没有自身 filesystem sandbox”；但 Claude Code 官方现在提供 OS 级 filesystem/network sandbox，并可配置 unavailable 时直接失败。[官方 sandbox 文档](https://code.claude.com/docs/en/sandboxing) 同时指出 approval fatigue 是实际问题。这说明能力不应长期硬编码为产品记忆，而应在 `doctor` 中探测 binary version、可用 sandbox、hook 集、permission mode 和 settings 来源，并把探测结果随 run 固化。
3. **代码注释也保留了已删除模型。** Claude adapter 的 `bypassPermissions` 说明仍写着“guard is the gate”，而当前 hook wiring 已删除 `PreToolUse`。这不一定立即造成运行错误，但会让未来维护者依据一个不存在的安全边界做决定。

---

## 3. 市场已经验证了什么：这些是入场券，不是护城河

| 需求 | 一手证据 | 对 Lingtai 的含义 |
|---|---|---|
| 异步、并行、隔离执行 | [Codex Cloud](https://developers.openai.com/codex/cloud) 主打隔离云环境、并行任务、可比较多个尝试；[Cursor Background Agents](https://docs.cursor.com/background-agent) 提供远程 VM、follow-up/takeover，其 API 文档宣称每个 key 可有 256 个活跃 agent；[Claude Code agents](https://code.claude.com/docs/en/agents) 已同时提供 agent view、subagent、agent team、worktree 与 `/batch`。 | Phase 5 并发必须做，但“并行任务板”已经不是爆点。Lingtai 必须回答并行之后如何选、如何安全合并、如何证明。 |
| 可复现环境与 worktree | [Codex environment](https://developers.openai.com/codex/cloud/environments) 支持 setup/maintenance、缓存、变量与仅 setup 阶段可见的 secret；[Factory worktree](https://docs.factory.ai/factory-app/worktrees) 自动隔离、准备和保留/清理 checkout。 | Lingtai 的 mirror/worktree 是正确底座，但 onboarding、缓存和 `.env`/依赖准备体验需产品化。 |
| 计划、迭代与远程接管 | GitHub 官方建议复杂任务先 research/plan/iterate，再开 PR，并强调 ticket 要合理拆分（[best practices](https://docs.github.com/en/copilot/using-github-copilot/using-copilot-coding-agent-to-work-on-tasks/best-practices-for-using-copilot-to-work-on-tasks)）；[Claude Remote Control](https://code.claude.com/docs/en/remote-control) 可从手机继续本地 session，并在完成或需要决定时推送。 | `admit` 点应承担“先澄清/拆分/估价再花钱”；等待人工不能只靠打开本机 board。 |
| 多模型、多 agent 与专项角色 | GitHub 已允许在同一 agent 工作流使用 Copilot、Claude、Codex，并自动做安全扫描（[third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)）；[Claude agent teams](https://code.claude.com/docs/en/agent-teams) 有共享任务表和 agent 间通信；[Factory](https://factory.ai/product/software-factory) 直接定位为 model-independent 全 SDLC 平台。 | “支持 Claude + Codex”只是必要的去锁定能力。差异化应在跨 runtime 的共同裁判与结果数据，而非 adapter 数量。 |
| hooks、skills、plugins | GitHub Copilot 已支持 session/tool/subagent/error 等 hooks，且明确用于审计、策略、统计和告警（[hooks](https://docs.github.com/en/copilot/concepts/agents/hooks)）；Claude hooks 可运行 command、HTTP、MCP、prompt 或 agent（[hooks guide](https://code.claude.com/docs/en/hooks-guide)）；[Agent Skills](https://github.com/agentskills/agentskills) 已是跨产品开放格式。 | 不要再发明一套通用“技能”格式。Lingtai recipe 只描述 gate 与 release 语义；agent 的程序性知识优先引用开放 Skill。 |
| 安全边界与管理员治理 | Cursor 明确警告后台 agent 自动执行且联网会带来 prompt injection/数据外泄风险；GitHub 的[防火墙文档](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall) 也坦承 firewall 可被高级攻击绕过；[OpenAI 的内部部署说明](https://openai.com/index/running-codex-safely/) 使用 sandbox、network policy、不可覆盖的 managed requirements、审批与 agent-native telemetry。 | worktree 不是 sandbox。若面向团队，必须把实际 runtime policy、network、credential 与 settings 来源记录进 receipt；若面向企业，还要正面处理“管理员要求不可由 repo 放松”。 |
| agent 可观测性 | GitHub、Claude Code、OpenHands 都已支持 OpenTelemetry。GitHub 的 [OTel 文档](https://docs.github.com/en/copilot/concepts/agents/opentelemetry) 覆盖 trace/model/tool/token/feedback；[OpenHands observability](https://docs.openhands.dev/sdk/guides/observability) 覆盖 agent step、tool、LLM、browser 和 conversation。 | “我们有日志”不再独特。Lingtai 的优势必须是日志参与控制、可重建状态、记录应做与实做，并能连接软件结果。 |
| 自动评审与验证 | GitHub 官方承认 agent review 会漏报和误报，仍需人工复核（[responsible use](https://docs.github.com/en/copilot/responsible-use/agents)）；Claude 的[Code Review](https://code.claude.com/docs/en/code-review) 已用多个专项 agent 再加验证步骤过滤误报。 | 冷 reviewer 曾是很好的差异点，现在已是 table stakes。应把 reviewer 变成可度量、可回放的 gate，而不是继续强调“我们也有 AI review”。 |
| 从生产信号自动回到代码 | Devin 官方用例已经包括 Sentry 自动分诊、Datadog 根因分析、CI 自动修复、夜间 E2E、并行迁移与策略赛跑（[use cases](https://docs.devin.ai/use-cases/gallery/index)）；Factory 也覆盖 incident、release、outcome analytics。 | 接 Sentry/CI/Datadog 是被验证的需求，但不是独占空白。它们应成为 Outcome Lab 的结果输入，而非另起一套泛自动化产品。 |

### 市场含义

“全能软件工厂”赛道不仅拥挤，而且价格已经下探。Factory 个人 Pro 官方定价为 $20/月，包含本地与云后台 agent、usage/readiness dashboard（[pricing](https://factory.ai/pricing)）。Lingtai 不宜用功能清单正面追赶；它需要一个头部产品即使拥有更多模型能力，也不容易诚实提供的中立角色：**厂商无关的放行权、证据与效果核算。**

---

## 4. 仍然存在的空白与 Lingtai 的结构性优势

### 空白 A：使用量很多，但“是否有效”仍说不清

GitHub 在 2026-02 的 metrics GA 公告中明确表示，当前先解决采用率与使用量，下一步才是回答“是否有效”、把使用模式连接到工程结果（[GitHub changelog](https://github.blog/changelog/2026-02-27-copilot-metrics-is-now-generally-available/)）。METR 的随机对照实验也展示了感知与结果可能相反：16 名熟悉自己成熟仓库的开发者完成 246 个真实任务，early-2025 工具条件下实际用时增加 19%，而参与者仍认为自己更快；这只是特定时间和人群的快照，但足以证明不能用主观速度代替结果度量（[原始论文](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf)）。

DORA 2025 在近 5,000 名技术人员数据上发现，AI adoption 与 throughput/product performance 呈正相关，却仍与 delivery stability 呈负相关；报告把高质量内部平台、自动测试和快速反馈视为释放价值的前提（[Google Cloud/DORA](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)）。

**Lingtai 优势：**它天然拥有 work item → run → gate → merge commit 的因果链，也已经规划 `regressions` 与 `run_receipts`。多数 telemetry 产品从 tool/model call 往上聚合；Lingtai 可以从实际落地结果往回归因。

### 空白 B：有 telemetry，但“这个证据由谁观察、是否可验证”仍未标准化

OpenTelemetry 的 GenAI 约定正在快速发展，agent/workflow/plan span 仍标为 Development（[agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)）。2026-07 的开放讨论仍在处理两个治理核心问题：如何区分 self-reported 与 externally observed evidence（[#386](https://github.com/open-telemetry/semantic-conventions-genai/issues/386)），以及如何把 agent/tool span 与可验证的 execution-environment attestation 关联（[#406](https://github.com/open-telemetry/semantic-conventions-genai/issues/406)）。

**Lingtai 优势：**gate action 只返回 verdict，core 负责把 verdict 绑定到 SHA；`GatesResolved` 又先记录完整计划。这比“agent 自己说测试通过了”更接近外部观察者。若再把 event slice、证据 digest、runtime/config identity 封装成 in-toto statement，就能复用成熟的 attestation 模型；[in-toto v1.2](https://github.com/in-toto/attestation/blob/main/spec/README.md) 正是为“关于软件 artifact 的可认证 metadata、供 policy engine 消费”设计。

### 空白 C：跨厂商比较的共同结果层仍弱

Codex、Claude、GitHub、OpenHands 都导出 telemetry，但字段、身份、session 与成本语义不同；OTel 社区明确把标准化动机写成避免 vendor/framework lock-in（[OpenTelemetry agent observability](https://opentelemetry.io/blog/2025/ai-agent-observability/)）。Factory 已提供多模型 routing，说明需求成立；但厂商自己既是执行方又是评分方。公开资料中没有发现一个轻量、自托管、以 merge outcome 为核心、同时能让不同 CLI runtime 在相同 gate 下受审的产品承诺。

**Lingtai 优势：**runtime interface 已刻意取 Claude/Codex 的交集；继续把 provider-specific 细节封装在 adapter，把 release verdict 与 outcome 留在 core，正好可以成为跨厂商基准面。

### 空白 D：跨仓库变更仍是明确限制

GitHub Copilot cloud agent 官方限制为一次 session 只能改一个 repository、一个 branch，并且恰好一个 PR，最长 59 分钟（[cloud agent limitations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)）。大规模迁移工具能生成许多 PR，但“多个 repo 的兼容版本、合并顺序、共同 release gate 与整体凭证”仍不是普通 agent task 的自然单位。

**Lingtai 优势与代价：**project、base-specific merge lane 和 event stream 已存在，因而有机会在它们之上增加 release train；但这会直接推翻 roadmap 的“无 work-item DAG”决定。它是远期产品分叉，不应偷渡为一个小 feature。

### 空白 E：人类注意力成为新的稀缺资源

Claude 用 agent view 专门显示哪些 session 需要输入，并通过手机推送完成/决策通知；其 sandbox 文档把 approval fatigue 明确列为反复授权的后果。Lingtai 已把 `waiting` 设为独立 lane，这是很正确的产品直觉，但当前通知主要是本机 macOS，无法服务离开开发机或多人轮值的场景。

**Lingtai 优势：**所有待决策事件、所依赖 SHA、gate evidence 和审批结果都在同一 log 中，很适合做去重、升级、SLA、batching 与 stale-decision 防护，而不是简单“多发几条消息”。

---

## 5. 优先级建议

| 优先级 | 建议 | 用户价值 | 差异化 | 实现风险 |
|---|---|---:|---:|---:|
| P0 | 可信度基线：连续两单、自托管、文档真值、runtime capability probe | 高 | 中 | 低—中 |
| P1 | **Lingtai Receipt**：可验证合并凭证 | 高 | **高** | 中 |
| P1 | **Outcome Lab**：成本/周期/回归/返工归因与历史 replay | **很高** | **高** | 中 |
| P1 | `admit` preflight + agent-readiness onboarding | 高 | 中 | 中 |
| P2 | Claude vs Codex champion/challenger 安全竞标 | 高、演示性强 | **高（与 receipt 组合时）** | 中—高 |
| P2 | Human Attention Router：远程、批量、SLA、stale-safe 审批 | 高 | 低—中 | 中 |
| P2 | OTel/in-toto 导出与 Sentry/CI outcome subscriber | 中—高 | 中 | 中 |
| P3 | 跨 repo release train | 很高（特定团队） | 高 | **很高** |

### 5.1 P0 — 先证明系统值得被托付

在再加功能前完成四个“可信事实”：

1. 连续两张 ticket 自动衔接并落地，满足 Phase 2 exit criterion。
2. 完成一次 Lingtai 自己修改、自己过 gate、人工批准、合并、人工 restart 的 Phase 4 运行。
3. README、reference、CLI help、recipe example 从 schema/事件注册表生成或在测试中校验，防止再次出现旧模型残留。
4. `lingtai doctor` 输出并记录 runtime binary/version、真实 hook 集、sandbox 可用性、permission mode、network policy、用户/项目/managed settings 来源及其 digest。能力不足要 `DispatchRefused`，不能依赖静态常量。

这四项完成后，Lingtai 才能把“信任不是口号，而是可检查的事实”作为产品故事。

### 5.2 P1 爆点 — Lingtai Receipt

**用户体验。** 每个 landed task 产生一张短卡和一个机器可读文件：

```text
LANDED  6f41c2a → develop
WHY     5/5 points accounted for · 3 passed · 2 skipped
BOUND   all verdicts on 8ab921e · recipe sha256:…
RUNTIME claude-code 2.x · model … · sandbox … · settings sha256:…
EVIDENCE build … · cold-review … · human approval by …
COST    $0.83 · 15 turns · 9m12s · 3m40s waiting for human
VERIFY  lingtai receipt verify receipt.dsse.json
```

MVP 不必先上复杂公钥基础设施：

- 从一个 work-item/run/integration event slice 生成 canonical JSON；subject 是 merged commit，predicate 记录 recipe/config、planned/actual gates、evidence digest、runtime identity、operator decision、cost 与 event-log high-water mark。
- 本机先以 Ed25519 key 签名，提供 `lingtai receipt show/verify/export`。
- issue 或 PR 留一条人类可读摘要与 receipt digest；以后可导出 in-toto DSSE / Sigstore bundle。Sigstore bundle 已支持把签名、时间戳与 attestation 放在单文件并离线验证（[Sigstore verification](https://docs.sigstore.dev/cosign/verifying/verify/)）。
- 明确写在 UI 上：**receipt 证明流程与证据完整性，不证明代码一定正确。** 这与 OTel #406 对 attestation 边界的提醒一致。

为什么它可能成为传播点：普通 agent 的产物是一张 PR；Lingtai 的产物是“PR/commit + 一张能回答为什么允许落地的证据卡”。这张卡可被贴进 issue、release、审计单或事故复盘，天然会离开 Lingtai UI 被别人看到。

### 5.3 P1 护城河 — Outcome Lab，提前实现 Phase 6

建议把 Phase 6 从“最后再做的反馈分析”提前成与第二 runtime 同期的主线。最小数据模型：

- 输入维度：runtime、model、harness version、prompt/skill digest、recipe/gate version、task kind、估计复杂度、files/components touched。
- 过程指标：准备时间、agent wall/token/cost、gate 时间、人工等待、重试、context compaction、失败 stage。
- 结果指标：landed、首次通过率、人工 reject/waive、合并后 revert、关联 bug/incident、修复时长、30/90 天存活。
- 单位经济：cost per landed、cost per non-regressed change、human minutes per landed、每类 task 的最佳 runtime。

然后分三步提供能力：

1. **Outcome linking**：通过 issue label、revert commit、Sentry/Datadog fingerprint 或人工按钮，把生产问题关联回 merge commit 和 run。
2. **Recipe report card**：不是统计用了几次，而是显示某 gate 的 precision/recall 代理、增加的等待、避免的 regression、每次成功的边际成本。
3. **Counterfactual replay**：对历史 diff 运行新 reviewer/gate；对可安全重放的任务用新 model/prompt shadow run，比较结果但不 merge。

OpenHands 官方已经建议对 skill 追踪接受率、趋势、模型/prompt 对比并聚合反馈（[monitoring skills](https://docs.openhands.dev/overview/skills/monitoring)），说明需求已经验证。Lingtai 应比它更进一步：不用 LLM judge 作为唯一真相，而把真实合并结果和后续 regression 放在评分中心。

### 5.4 P1 — `admit` 变成“花钱前的任务整形器”

`admit` 是 Lingtai 一个被低估的差异化位置：它发生在 claim、worktree 和 agent 成本之前。建议增加只读 preflight action：

- ticket 是否有可验证验收标准、复现步骤、目标 branch 与明确范围；
- 预计涉及的 package/file 数、跨 repo 依赖、migration/security/UI 风险；
- repo 能否在干净 worktree 内安装和运行最小验证；
- 根据历史同类任务给出成本区间、成功率与推荐 runtime；
- 低置信度时生成 1—3 个澄清问题或拆分建议，保持 queued，而不是让 agent 在运行中烧钱等待。

另做 `lingtai onboard <repo>`：先输出 readiness report，再生成候选 recipe/Skill，必须人工 review 后提交。Factory 已把 agent-readiness dashboard 放进个人付费计划，DORA 也把内部平台和快速反馈列为 AI 成功前提，所以这是已验证的实用需求；它的角色是降低失败率，不是品牌爆点。

### 5.5 P2 爆点 — Champion/Challenger 安全竞标

在 Codex adapter 与真实并发完成后，为一张高价值 ticket 增加显式模式：

```yaml
runtime:
  candidates:
    - agent: claude-code
      model: ...
    - agent: codex
      model: ...
  budget:
    totalUsd: 8
  select:
    gate: proposed
    action: compare
```

约束必须比演示更重要：候选从同一 base SHA 出发；各自 worktree、成本上限和 receipt 独立；先跑确定性 gate，再由冷 judge 做 pairwise 比较；无法明确胜出则交给人；只有 winner 能进入唯一 merge lane；loser 永不自动拼接进 winner。

Codex 已支持比较多个尝试，Devin 已公开“让三个 session 竞跑三种优化策略”的用例，说明用户愿意为高价值任务买冗余。Lingtai 的独特版本不是“也能 race”，而是**用同一套外部 gate 和真实历史 outcome 校准选择器，并留下选择依据**。

### 5.6 P2 — Human Attention Router

从“macOS 通知”升级成一份有优先级的决策 inbox：

- Slack/Teams/email/mobile web push 任选其一开始；一个待决策项只生成一个逻辑 notification，subscriber 负责投递状态。
- 通知内含 diff 摘要、失败 gate、风险、成本和 receipt preview；approve/reject/waive 必须回传目标 SHA，过期自动拒绝。
- 支持 quiet hours、owner/on-call routing、超时升级、同类低风险变更 batch approve。
- 把“人工等待时间”做成显眼指标；优化目标是减少需要人的决定数量与决策时间，而不是减少所有人类参与。

### 5.7 P3 — Cross-repo Release Train（明确的产品分叉）

目标体验是“一张 change request → 多 repo 子任务 → compatibility gate → 按拓扑合并 → 一个总 receipt”。典型用例：API + SDK、schema + consumers、共享 package + 多服务升级。

但不要宣称“原子跨 repo merge”；Git 没有这种事务。诚实模型应是 staged branch、ordered landing、每步 gate、失败时停止并生成 compensating revert/forward-fix 计划。只有在 Phase 5 多项目可靠之后，再用 3—5 个真实跨 repo 变更验证是否值得推翻“无 DAG”原则。

---

## 6. 两个必须由产品负责人选择的战略分叉

### 分叉 1：PR-less personal foundry，还是 team release governor？

当前直接 push base 是一个非常鲜明的选择。

- 若目标是**单人/高度信任的小团队 personal foundry**：保留 direct mode，卖点是“不制造 PR 队列，满足 recipe 就落地”，并把 receipt 做成事后可检查的证据。此时应极致简化本机安装与恢复，不急着做 RBAC。
- 若目标是**团队 release governor**：必须增加 `integration.mode: pull-request`，把 gate verdict 映射为 GitHub checks，服从 branch protection/merge queue/code owners，在 PR head SHA 变化时撤销旧 verdict。此时 board auth、actor identity 和 approver policy 也成为必需品。

主流竞品一致选择 PR + human review，不代表 Lingtai 必须照做；但它必须把“不走 PR”当成被验证的产品假设，而不是默认实现细节。建议访问 8—10 个潜在用户，只问一个行为题：**“你愿意让独立 daemon 在满足哪些可验证条件时直接 push protected base？”** 如果答案普遍是“永远不”，尽早增加 PR mode。

### 分叉 2：trusted operator，还是 enterprise governance？

ADR 0016 的“无 policy、repo 自己决定 workflow”对 owner-operated 工具是简洁且一致的。但 Codex、GitHub Copilot 和 Claude 的企业方案都提供用户不可覆盖的 managed configuration/policy；这是企业安全团队的明确需求。

因此二者必须择一：

- 保持无 policy：明确写“Lingtai 信任 base branch 的维护者，receipt 记录其决定，不替管理员设底线”，不要用 enterprise governance 做定位。
- 进入企业市场：需要一个 repo 无法放松的 operator/admin requirement 层，以及身份、RBAC、密钥、retention 与审计边界。这等于用新 ADR 有意识地推翻 0016 的一部分，不能伪装成 preset。

本报告建议近期坚持 trusted operator，先把独立 receipt/outcome 做深；只有有真实设计伙伴愿意为治理买单时，再接受第二条产品线的复杂度。

---

## 7. 建议的实现顺序

1. **Truth sprint**：完成 Phase 2/4 实证；修 README 漂移；runtime capability/version/settings snapshot；发布明确 license 或明确保持私有。
2. **First public artifact**：生成 unsigned/canonical receipt JSON、HTML/Markdown 卡片和 `verify` 命令；在 issue end action 贴 digest。
3. **Outcome slice**：`run_receipts` + regression/revert 关联 + board 上 cost per landed / human wait / non-regressed rate。
4. **Second runtime**：完成 Codex adapter，让相同 ticket 可手动跑两次并在 detail page 对比；先不自动选择。
5. **Signed and standard**：in-toto DSSE 导出、OTel export；记录 evidence origin 与 runtime environment digest。
6. **Safe race**：预算化 champion/challenger、确定性 gate 优先、冷 judge、人工兜底、唯一 merge lane。
7. **Signal plugins**：先做 CI 与 Sentry 两个 subscriber，证明 production outcome 能回流；再决定是否扩展 Datadog/Linear/Slack。
8. **只在证据出现后**考虑 PR mode、auth/RBAC、管理员 policy 或跨 repo DAG。

### 不建议现在做

- 自研模型、IDE 或完整聊天界面；runtime 厂商迭代速度远高于本项目。
- 泛化成任意 workflow engine；这会抹掉“唯一 merge authority”的边界。
- 先做插件 marketplace。先把 3—5 个内置/仓库内 plugin 的接口和 failure semantics 跑实；agent 的程序性知识复用 Agent Skills 标准。
- 仅为吞吐扩并发。OpenHands 2026-07 仍出现“配置的 max concurrency 对原生 async path 不生效”的公开 bug（[issue #4063](https://github.com/OpenHands/software-agent-sdk/issues/4063)），说明并发控制非常容易看似存在、实际失效。Lingtai 应先让 lease、per-project limit、global budget、merge lane 和 crash recovery 都能由事件证明。
- 以 LOC、session 数或 token 数作为成功指标。这些最多是成本/采用指标，不是软件结果。

---

## 8. 最值得立刻做的用户研究

选择 6—10 位已经每周运行多个后台 coding agent 的开发者/tech lead，拿真实最近一次任务访谈，不问“你想要什么功能”，而问：

1. 最近一次 agent PR 为什么没 merge？谁发现的？花了多少人工时间？
2. 你能否在五分钟内回答“这个 agent 上周到底省了时间还是制造了返工”？数据在哪里？
3. 你是否会让 agent 直接 push base？必须看到哪些证据才会改变答案？
4. 两个模型都能做时，你怎样选择？凭感觉、价格、benchmark，还是仓库内历史？
5. 哪类改动必须人批，哪类审批只是习惯性点击？
6. 一次生产 regression 能否追溯到具体 agent session、prompt、model、gate 与 approver？
7. 你需要保留 PR，还是只需要一个可审计、可撤销、可验证的 change record？

三个快速 demand test：

- 做一张真实的 Lingtai Receipt 静态卡，给 10 人看，观察他们先点什么、是否愿意贴到 PR/审计单。
- 用已有运行记录手工做一页 Outcome Lab，比较“cost per landed”与“cost per 30-day non-regressed change”，看后一个指标是否改变模型/gate 选择。
- 用同一低风险 issue 跑 Claude/Codex 两个候选，让用户在不知道模型名的情况下选 winner，再揭示成本；验证“中立比较”是否真的有决策价值。

---

## 9. 来源索引

### 仓库内

- [README](../../README.md)；[design](../design.md)；[roadmap](../roadmap.md)；[reference](../reference.md)
- [ADR 0013 — daemon hosts the work](../decisions/0013-daemon-hosts-the-work.md)
- [ADR 0016 — settled model](../decisions/0016-the-settled-model.md)
- [ADR 0018 — proposed point](../decisions/0018-the-proposed-point.md)
- [Claude Code runtime](../../packages/runtime/src/claude-code.ts)；[Codex stub](../../packages/runtime/src/codex.ts)；[integrator](../../packages/conductor/src/integrate.ts)；[recipe schema](../../packages/config/src/recipe.ts)

### 外部一手来源

- OpenAI：[Codex Cloud](https://developers.openai.com/codex/cloud)、[Cloud environments](https://developers.openai.com/codex/cloud/environments)、[Running Codex safely](https://openai.com/index/running-codex-safely/)
- GitHub：[Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)、[third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)、[hooks](https://docs.github.com/en/copilot/concepts/agents/hooks)、[firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall)、[OTel](https://docs.github.com/en/copilot/concepts/agents/opentelemetry)、[metrics GA](https://github.blog/changelog/2026-02-27-copilot-metrics-is-now-generally-available/)
- Anthropic：[parallel agents](https://code.claude.com/docs/en/agents)、[agent teams](https://code.claude.com/docs/en/agent-teams)、[Remote Control](https://code.claude.com/docs/en/remote-control)、[sandbox](https://code.claude.com/docs/en/sandboxing)、[hooks](https://code.claude.com/docs/en/hooks-guide)、[code review](https://code.claude.com/docs/en/code-review)
- Cursor：[Background Agents](https://docs.cursor.com/background-agent)、[Background Agents API](https://docs.cursor.com/background-agent/api/overview)
- Devin：[first session](https://docs.devin.ai/get-started/first-run)、[advanced capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities)、[use cases](https://docs.devin.ai/use-cases/gallery/index)
- Factory：[Software Factory](https://factory.ai/product/software-factory)、[worktrees](https://docs.factory.ai/factory-app/worktrees)、[pricing](https://factory.ai/pricing)
- OpenHands：[observability](https://docs.openhands.dev/sdk/guides/observability)、[skill monitoring](https://docs.openhands.dev/overview/skills/monitoring)、[concurrency issue #4063](https://github.com/OpenHands/software-agent-sdk/issues/4063)
- 开放标准：[Agent Skills](https://github.com/agentskills/agentskills)、[OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)、[in-toto Attestation v1.2](https://github.com/in-toto/attestation/blob/main/spec/README.md)、[Sigstore verification](https://docs.sigstore.dev/cosign/verifying/verify/)
- 原始研究：[METR randomized trial](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf)、[2025 DORA report announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
