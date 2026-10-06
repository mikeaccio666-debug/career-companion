# 已有 AI 产品公开了哪些部署信息

核查日期：2026-10-06。这里使用产品方工程文章与云厂商的直接客户案例，只记录公开的组件；客户案例的使用量是当时报道口径，不是今天的活跃用户或并发。网页框架、DNS、招聘技能要求、某厂商logo，以及第三方同名开源clone都不足以证明整个产品的部署结构。

## 可证案例

| 产品／资料日期 | 公开部署证据 | 为什么采用／能借鉴什么 | 没有公开证明的部分 |
| --- | --- | --- | --- |
| Higgsfield，2024-08-08／08-30 | 创始人在Google Cloud文章中说明使用Vertex AI、AI Hypercomputer等支持训练、推理、数据处理和编排；同月Google说明其使用GPU与Gemini支持视频产品和自有模型 | 创始人给出的原因是训练／生成速度、处理大数据、快速试验和基础设施支持；我们可以借鉴把模型计算与产品服务分开，但第一版求职伙伴调用模型API，无需照搬自训视频模型的GPU规模 | 2026年完整web/API/database/queue架构和是否只用一个云；2024信息不能写成目前整个平台都在GCP |
| OpenEvidence，2026-02-25 | Python backend在GCP，负责ingestion、模型编排与业务逻辑；Next.js frontend在Vercel | 官方客户访谈明确这种分工保留Python后端并获得前端发布体验，是最贴近“网页＋垂直知识＋AI”的参考 | 不能由前端Vercel推断后端也全部在Vercel；文章中的2026年1月超过20M consultations不是同时在线人数 |
| Character.AI，2026-01-13 | 公开一套DigitalOcean Kubernetes＋AMD GPU＋vLLM的生产Qwen3推理配置；文章介绍约20M worldwide users | 原文目标是低延迟下提高GPU吞吐和降低推理成本；流量大、自行托管模型时，GPU资源编排与每请求成本变得关键 | 披露的是特定推理工作负载；不证明所有模型、训练、网页、数据库都迁往同一集群，也不是我们的起步配置 |
| Replit，2025-09-04及2026安全文章 | 用户发布的应用运行在GCP；App Storage用GCS，防护包括Cloud Armor；安全文章解释每位客户独立GCP project等隔离 | 对运行用户代码的产品，租户隔离、资源边界和发布环境是核心；我们的浏览器／代码执行池也应有独立边界 | 用户应用的托管架构不等于Replit完整editor、Agent、控制面stack；其业务用户数量不能用于估算我们单次求职聊天成本 |

Higgsfield依据：[创始人文章](https://cloud.google.com/transform/3-lessons-for-gen-ai-startups-higgsfield-ai-infrastructure-talent-models)、[Google Cloud当月客户说明](https://cloud.google.com/blog/products/ai-machine-learning/magic-ai-100m-tokens-cloud-supercomputer)。OpenEvidence依据：[Vercel客户访谈](https://vercel.com/customers/how-openevidence-built-a-healthcare-ai-that-physicians-can-trust)。Character.AI依据：[官方技术深挖](https://blog.character.ai/technical-deep-dive-how-digitalocean-and-amd-delivered-a-2x-production-inference-performance-increase-for-character-ai/)。Replit依据：[Google Cloud合作说明](https://replit.com/blog/replit-expands-google-cloud-collaboration-with-new-google-cloud-marketplace-listing)、[安全与运行隔离](https://replit.com/blog/defense-in-depth-how-replit-secures-every-layer-of-the-vibe-coding-stack)。

Higgsfield当前公开API的交互是提交任务、取得request id、查询状态／取消、返回媒体。这可以作为用户体验与异步provider adapter的接口参考，不能从公开API反推出其内部队列或部署供应商。[Higgsfield API说明](https://open.higgsfield.ai/quick-start)

## 对我们选型的意义

下面是基于公开案例与本项目源码的工程判断：

1. 应分别选择网页、业务API、持久任务、数据和特殊执行资源。一个平台能托管网页，不代表每个进程都要放在那里；多个供应商也不是必然更复杂或更成熟，要看实际连接和运维成本。
2. 起步使用成熟托管服务可以是正式产品方案。我们应先验证职业比较、知识引用和验证行动的效果，同时实现真实身份、持久化、任务恢复和数据删除；用户量增长后可分别增加API或worker容量。
3. 自训／自托管视频与大语言模型的GPU成本结构，与调用商业模型API的求职伙伴不同。不要因Higgsfield或Character.AI有GPU集群，提前采购我们暂时用不到的机器。
4. “未来能调整”来自代码与数据边界：自有求职领域、版本化contract、容器、Postgres与私人S3接口。迁移Redis/BullMQ到另一队列或迁移身份供应商仍需改造与验收，不能保证一键迁移。

具体候选与费用条件见 [托管方案](cloud-managed-options.md)、[大云与VM](cloud-infrastructure-options.md)、[我们的部署决策](cloud-decision.md)。容器与Render配置已经是本地可审阅基础；这份案例研究没有连接云账号或部署服务。
