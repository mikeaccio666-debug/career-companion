import {runInNewContext} from "node:vm";
import ts from "typescript";
import {ASSISTANT_EXECUTOR_FILE} from "../../assistant/features/autofill/executor-installation";
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_EXTENSION_ID, DEVELOPMENT_EXTENSION_PUBLIC_KEY } from '../../lib/developmentIdentity';
const root = resolve(__dirname, '../../.output-assistant/chrome-mv3');
const runtimeEnabled = process.env.VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED === '1';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(v => v.isDirectory() ? files(join(dir, v.name)) : [join(dir, v.name)]);
describe('complete assistant staging artifact', () => {
  it('keeps the unpacked Assistant artifact below the 3 MiB review budget', () => {
    // background.js（运行时包开启时）2026-09-23：416 → 424 KiB。ARIA 代理选择题（Ashby 的 aria-pressed
    // 是非按钮、Workable 的 role=radio 代理）与「标签上的必填记号」：background 把后端下发的规则编译成
    // 适配器，扫描那一半（解释器的代理题归组与题干/必填判定、scanRoot 的代理序号与封存放行、
    // dict/ariaChoice 与 dict/requiredMarker、点击策略的 proxy-option 事实）随之进来；写入器（点击原语、
    // proxyChoiceGroup）不在这里。合计 +8,428 字节（main 上 421,890 → 430,318）。没有带进新的依赖。
    // 运行时包关闭时是 383,764，410 KiB 不动。
    // 2026-09-24：424 → 448 KiB（运行时包开启时）。浮层任务接线（argoland「开始申请即批准」）：worker 里加了按标签页的
    // 任务归属、「开始申请」批准与提交回报的客户端、任务运行记录（批准 → 签发 → claim → 回执）、任务材料入口的客户端
    // （简历字节按摘要与大小核对、求职信）、四种浮层任务消息的解析与 §4.15 的契约解码；删了旧的 dock/fill 那条路
    // （按页找任务、本地 run 启动）与旧的 resume-file 读取。合计 +18,873 字节（main ff8dc1c 上 429,993 → 448,866）。
    // 没有带进新的依赖。调到 448 KiB 留约 9.9 KB。运行时包关闭时 384,385 → 403,258，410 KiB 不动。
    // 2026-09-27：448 → 460 KiB（运行时包开启时）。按页面附求职信（负责人 2026-09-27：申请表上有求职信栏就附上为这个岗位写的
    // 一封；argoland #653）：worker 里加了按页面要求职信的客户端（lookup / prepare / text / pdf，PDF 按名字、身份与摘要核对，
    // 与任务材料入口共用读字节与摘要的几个小函数）、求职信消息的解析与 PREPARE → TEXT / PDF 的处理（岗位库里已有就不碰计量的
    // prepare、同一页的请求合并、重试沿用请求号）、四条路的契约解码与这一页职位描述的校验。合计 +9,918 字节（main + #124 上
    // 452,118 → 462,036）。没有带进新的依赖；内核的求职信判据不在这个文件里。调到 460 KiB 留约 9 KB。运行时包关闭时
    // 406,386 → 约 416,300，410 KiB 不动。
    // 2026-09-28：运行时包关闭时 410 → 416 KiB（开启时 460 KiB 不动）。下一个商店版本对后端先发的加法容错：worker 里的
    // 契约解码不再按封闭键集整份拒收、改为只认必需的键并按认得的字段重建（AI 代答的流与改写、次数、起草、求职信、简历附件与
    // 可选简历、简历库），流上不认识的行与指令、答案记忆里不认识的种类跳过，运行时包与规则装载逐类记诊断码，档案元数据的陌生值
    // 判定。与 main（ef39576）同基点实测：运行时包关闭时 416,414 → 422,427（+6,013），开启时 462,144 → 469,061（+6,917，
    // 460 KiB 还留约 1.9 KB），apply.js 475,563 → 477,919（+2,356）。没有带进新的依赖。
    // 2026-09-28：运行时包开启时 460 → 484 KiB、关闭时 416 → 432 KiB。替用户注册、登录招聘网站（负责人 2026-09-28：Workday、
    // iCIMS 的账号墙）：worker 里加了本机保险箱（AES-GCM、不可导出的密钥放扩展自己 origin 的 IndexedDB，约 3.6 KB）、交出
    // 邮箱与密码之前判两把钥匙的那一层与共用密码的生成和规则（约 4 KB）、浮层账号消息的解析（约 1.5 KB）、消息处理与退出时
    // 清空、按这一家读写策略的 `fillPolicyForVendor`（约 1.5 KB），内核点击策略里规则声明的账号控件那一支（约 1.5 KB）；
    // 开启时 background 还要把规则里的 `accountSteps` 编译成账号墙（schema 与 rules/accountWall.ts，约 4.6 KB）。合进含 #131、
    // #134 的 main（0663c78）后同基点实测：开启时 470,329 → 487,594（+17,265；main 上只剩 711 字节），关闭时 423,310 → 435,968
    // （+12,658）。没有带进新的依赖。开启时调到 484 KiB 留约 8 KB、关闭时调到 432 KiB 留约 6.4 KB；再碰线时同样写明加了什么。
    // 2026-09-28（通用路，claude/generic-fill，合进含 #133 的 main 之后）：不调。worker 里编译下发规则的那一份解释器与扫描根跟着变了
    // （简历算进认表门槛、小标签接组标题、占位项标签、「要从下拉里选」交还、一拍一份影子根索引、简历词表的德法西文）。与 main
    // （74d9d61）同基点实测：运行时包开启时 487,594 → 491,246（+3,652），484 KiB 还留 4,370 字节；关闭时 435,968 → 435,968（+0，
    // 这些代码只在开启时进 background），432 KiB 还留 6,400 字节。没有带进新的依赖。
    // 2026-10-04：运行时包开启时 484 → 488 KiB（关闭时 432 KiB 不动）。资料新鲜度（2026-10-03 前端体检 P0／P1，负责人要求全修）：
    // worker 里扁平档案每个请求的时限与「门户正在保存」时等约 1 秒再读一次（约 0.6 KB）、资料目录的到点／正在保存／写之前核是谁
    // （约 0.8 KB）、整份档案答复的时限与读之前读完各认一次是谁（约 0.6 KB）、任务归属与材料清单换账号时清掉（约 0.1 KB），
    // 以及两处消息解析多认一个会话代号（约 0.4 KB）。「我的资料」的会话缓存与会话代号本身只在浮层构建里，Assistant 产物里常量
    // 折叠删掉。与 main（336cd9d3）同基点实测：开启时 493,098 → 495,542（+2,444，484 KiB 只剩 74 字节；在途的 #142 还要 +489），
    // 关闭时 437,423 → 439,868（+2,445，432 KiB 还留 2,500 字节）。没有带进新的依赖。开启时调到 488 KiB 留约 4.1 KB。
    // 2026-10-04（线上可观测性，前端体检 11-1…11-5）：开启时 488 → 500 KiB，关闭时 432 → 442 KiB。worker 这一侧加的：上报改成
    // 放在 storage.session 里的有界队列（worker 挂起、重启不丢）、退避重试与 Retry-After、三种事件分批（原因码、入口处的异常、
    // 一轮的结局；后端还不认结局时那一批单独丢、六小时不再送）、HTTP 失败带 x-request-id 与状态码、数量码带次数（合计约 +6.0 KB，
    // lib/diagnosticsUploader.ts）；内容脚本与浮层的原因码表与错误类名闭集（lib/dockDiagnostic.ts，约 +2.0 KB）；httpFailure.ts、
    // AI 计时的固定桶、资料与授权读取带请求号（约 +1.0 KB）。一轮结局的解析与那几张闭集表在 Assistant 构建里是死代码（编译期常量
    // 关掉），不占这里。与 main + #142（2ff01b58）同基点实测：开启时 493,587 → 502,650（+9,063），关闭时 437,924 → 446,985
    // （+9,061）。没有带进新的依赖。合进含 #141–#146 的 main 后实测：开启时 497,170 → 506,213（+9,043），关闭时
    // 441,492 → 450,556（+9,064）。开启时调到 500 KiB 留约 5.7 KB，关闭时 442 KiB 留约 2.0 KB；再碰线时同样写明加了什么。
    // 2026-10-04：运行时包关闭时 442 → 448 KiB（开启时 500 KiB 不动）。浮层说实话（#150）：worker 记下运行时包放行了哪几家
    // （bundleOpenVendors）、认出了申请表而这一家没放行时脸是「这类网站还没开放自动填写」、DISCOVERY 那两个码单独答 VENDOR_CLOSED，
    // 以及 worker 里编译下发规则的那一份解释器多认 `consentGate`（同意页的停因）与规则声明的题干读法。合进含 #141–#149 的 main
    // 后实测：关闭时 452,069 → 452,877（+808），442 KiB 超出 269 字节；开启时 508,390 → 509,595（+1,205），500 KiB 还留约 2.4 KB。
    // 没有带进新的依赖。关闭时调到 448 KiB 留约 5.7 KB；再碰线时同样写明加了什么。
    // 2026-10-04：运行时包开启时 500 → 504 KiB（关闭时 448 KiB 不动）。worker 里编译下发规则的那一份解释器多了三个方法——申请表
    // 还没打开时交出「打开申请表」那一颗（D8）、交出数据同意页的表与居住地下拉（D7）、按规则声明的题干给「页面上还空着的必填」
    // 读题目（#150）——与它们共用的「这一颗提交得了表吗」；worker 记「替他过了数据同意页」的那一声（与「刚按了提交」同一个
    // 做法）。#150 同基点实测：开启时 494,324 → 496,427（+2,103），484 KiB 超出 811 字节。没有带进新的依赖。合进含 #141–#150 的
    // main 后实测：开启时 509,595 → 511,697（+2,102），500 KiB 只剩 303 字节，所以调到 504 KiB 留约 4.3 KB；关闭时 452,877 →
    // 453,651（+774），448 KiB 还留约 5.0 KB。再碰线时同样写明加了什么。
    expect(statSync(join(root, 'background.js')).size).toBeLessThanOrEqual((runtimeEnabled ? 504 : 448) * 1024);
    // 2026-09-22：360 → 376 KiB。main 上 apply.js 已是 368,414 字节，只剩 226 字节余量，同一天在途的
    // 几刀每一刀都单独碰线：Workday 电话设备类型（#65，+0.6 KB）、多页申请「继续到下一页」与手势路
    // 迟到复查（#66，+12.7 KB：内核判据约 3.5 KB、内容脚本控制器约 2.2 KB，其余是浮层、文案与接线，
    // 逐项量过，没有带进新的大模块）、工作授权判据（#67）与宿主校验兜底（#68）合计约 +0.9 KB。
    // 四个一起合进来是 382,712 字节（临时合并构建实测），376 KiB 还剩约 2.3 KB。这一处在各 PR 里
    // 逐字相同，按任意次序合都不冲突。这道闸仍是评审预算：下一次再碰线，同样要写明加了什么、为什么。
    //
    // 2026-09-23：376 → 392 KiB。代填条款、声明与签名（负责人 2026-09-22 夜的决定）：内核的整句判据
    // （dict/signOnBehalf.ts，几乎全是正则）、计划期的代填分支与去重豁免、点击策略的窄口子、choice 组与
    // runner 的写前复核、浮层文案与行标记，合计 +7,147 字节（main 上 #70–#73 合完是 384,570，这一刀之后
    // 391,717）。没有带进新的依赖。调到 392 KiB 留约 9.7 KB；只调到 384 KiB 只剩 1.5 KB，下一刀又得调。
    //
    // 2026-09-23（晚）：392 → 424 KiB。浮层按设计交接 `ArgoAI Autofill.dc.html` 重做（负责人：要一模一样实现）：
    // 主卡连续变形、两层进度条、逐项处理小卡与网页上的定位环、宽版「我的资料」编辑器（十二张卡片、
    // 分段／胶囊／标签／开关／步进等控件、保存蒙层与对勾动画、存回 Profile V2 / 自我认同 / 代填授权 /
    // 默认简历）、信封动画。旧浮层与它的五个模块（申请卡片那几幕、旧资料页、旧样式与图形）一并删掉。
    // 净增 +17,859 字节（396,229 → 414,088）。没有带进新的依赖。调到 424 KiB 留约 20 KB：下一刀
    // 「在插件里提交」还要加宿主提交按钮的判据与成功确认。
    //
    // 2026-09-24：424 → 440 KiB。与竞品同页对比后的三刀同批合进来（main 上 f17efac 的 apply.js 是 416,786 字节）：
    // #90 页面中途插题不再整轮中止、同一次点击里重扫补填一次（+4,939）；#91 Ashby 的是非按钮与 Workable 的
    // role=radio 成为一等选择题、必填也认题面星号（+15,156）；#92 页面看不见时的宿主任务调度与浮层原因文案
    // （约 +3,000）；#88 改名换 logo、#89 两处判据几乎不增。合起来 440,114 字节。没有带进新的依赖。调到 440 KiB
    // 留约 10 KB；下一刀「AI 代答」若再碰线，同样写明加了什么。
    // 2026-09-24：440 → 448 KiB。变基到 main 7a1cb88（含 #95：附上简历后网站回写解析结果，重写一次、浮层分清
    // 「网站填的」）后，本分支是 452,974 字节；其中 EEO 跨性别、性取向、是否 LGBTQ+ 三档（门户整句的翻译表、
    // 选项匹配、LGBTQ+ 的推法）与员工社群邀请题的判据约 +4,982（旧基线 440,636 → 445,618 实测）。没有带进
    // 新的依赖。调到 448 KiB 留约 5.6 KB；同在途的「AI 代答」「同意类代勾」合进来若再碰线，同样写明加了什么。
    // 2026-09-24：448 → 460 KiB。#96 合进 main 之后，以用户名义代填扩到六类同意（负责人 2026-09-23 夜的决定）：内核的整句
    // 判据（AI 面试记录、短信、日后联系、营销、背景调查授权、仲裁协议；逐句检查，点名第三方、联系现任雇主与混合一律拒）、
    // ARIA 代理选项上的代填读法、浮层逐条「已替你同意：…」，约 +11 KB（合并含 #96 的 main 后 464,065 字节）。没有带进
    // 新的依赖。调到 460 KiB 留约 6.8 KB，「AI 代答」（约 +4.4 KB）合进来也还在线内；再碰线时同样写明加了什么。
    //
    // 2026-09-23（夜）：440 → 448 KiB。AI 代答（负责人 2026-09-23 夜的决定）：Assistant 产物里浮层从不挂出来、手势路
    // 整条是死代码，所以挑题与请求、浮层上的 AI 分组、网页上的标记与「用 AI 写」卡片都不在这个文件里；留在这里的只是
    // 填写模块里通用的两样（开写前把计划交给调用方看一眼、用一张点击凭证写一批答案并在单子上叠出 AI 行）与 claim key
    // 的小模块。合并后实测见提交说明。没有带进新的依赖。background.js 两个变体各只多 48 字节，那两道闸不动。
    // 2026-09-24：合并含 #95 的 main（7a1cb88）后实测 452,414 字节，448 KiB 还留约 6.2 KB。
    // 2026-09-24：本 PR 合并含 #96、#97 的 main 后实测 468,487 字节，仍在 460 KiB 以内，不再调。
    // 2026-09-24：460 → 468 KiB。按学历／工作经历推出两类答案（负责人 2026-09-24：「是否年满 18」有学历或
    // 工作经历就答是、「以前在本公司工作过吗」经历里没有这家公司就答否，Jobright 的做法）：内核的推断与
    // 反着问的年龄题判读（dict/ageQuestion.ts）、依据码、浮层在值后面写明依据，合进 main（ff8dc1c）后实测
    // 475,426 字节（+6,939）。没有带进新的依赖。同时在途的 #100（代填第四刀，+689）与 #101（把 #99 带进
    // main，+899）三个一起约 477,000 字节，调到 468 KiB 还留约 2.2 KB；再碰线时同样写明加了什么。
    // 2026-09-24：（分支上）460 → 472 KiB。新岗位批测后的补缺（claude/fill-gaps-0924，逐提交实测）：多选下拉上的单值答案只选一项
    // （+642）、工作授权说得出是哪一国而资料里没有记录时带上那一国（+697）、搬迁题按岗位地点答（+272）、加行只点本区的
    // 按钮并等新行出现、每段要单独保存的区交给用户保存（+1,771）、Rippling 的「Choose not to disclose」（+25）、整轮之后
    // 网站清空的栏同一次点击之内重填一次（+1,720）。合起来 473,614 字节，超了 2,574。没有带进新的依赖。调到 472 KiB
    // 留约 9.7 KB；再碰线时同样写明加了什么。
    // 2026-09-24：合进含 #100、#101、#102、#104 的 main（b0980dd）后实测 482,693 字节（main 约 477,500，本分支 +5,200），
    // 472 KiB 还留 635 字节；#106（Workday，约 +2,200）、#103（任务接线，约 +4,400）后合时要再量、再调。
    // 2026-09-24：472 → 476 KiB。Workday My Experience（#106）：分段日期逐段只发 input、渲染落地后再提交一次，
    // 在职勾选、在职那一段不写结束日期、MBA 落到硕士，以及按行作用域加经历／教育行的键；合进含 #105 的 main
    // （8dbae48）后实测 484,871 字节（+2,178）。没有带进新的依赖。调到 476 KiB 留约 2.5 KB；#103（任务接线，
    // 约 +4,400）后合时要再量、再调。
    // 2026-09-24：（#103 分支上）460 → 468 KiB。浮层任务接线（argoland「开始申请即批准」）：内容脚本里的任务会话（记这一轮的任务运行、
    // 填完交回执、表单要求求职信时去取、网站确认后报提交、整页跳到确认页后再认一次）、四种浮层任务消息的创建与答复解析、
    // 「这张表要不要求职信」的判据与内核的求职信写入口，+4,367 字节（合并含 #98 的 main ff8dc1c 上 468,487 → 472,854）。
    // 没有带进新的依赖。调到 468 KiB 留约 6.3 KB；再碰线时同样写明加了什么。
    // 2026-09-24：476 → 480 KiB。#103 浮层任务接线合进含 #100–#106 的 main（fbeef42）后实测 489,238 字节（+4,367，
    // 与分支上量的一致：内容脚本里的任务会话、四种浮层任务消息、「要不要求职信」的判据与求职信写入口）。没有带进
    // 新的依赖。调到 480 KiB 留约 2.2 KB；再碰线时同样写明加了什么。
    // 2026-09-24：480 → 488 KiB。Workable 全加全存（负责人 2026-09-24：「和 Jobright 一样全加全存」）与「是否正在退役的军人」：
    // 行票只许加一行或按规则声明的那一颗保存（+241）、Workable 逐段加、填、按 Update 保存的循环与浮层逐段行（+5,263）、
    // 退役军人题按工作经历答否（+1,810）、空段不保存（+173）、浮层措辞（+51）、保存后重扫按主扫描同样重试（+148）、
    // 往顶上插的区按资料倒序加（+648）。合进 main（a68d5b4）后实测 498,711 字节（+8,332）。没有带进新的依赖。
    // 调到 488 KiB 留约 1 KB；在途的 Workday 专业／技能、第 3 页问法、AI 流式合进来时照样再量、再调。
    // 2026-09-24：（#111 分支上）480 → 484 KiB。Workday My Experience 的 Field of Study 与 Skills（搜索式多选，新规则字段
    // searchPromptComboboxes）：在 main（a68d5b4）的 490,379 字节上实测 493,310 字节（+2,931）。其中约 2 KB 是这一刀本身——
    // searchPrompt 写入器（打字、回车搜、唯一结果读回、好几行时按共用的候选阶梯挑一行、读回选中项）、规则解析与绑定、
    // 回车键出口；约 0.9 KB 是按负责人「一页的答案 15 秒内」加的：技能搜索整页 8 秒的时限、列表答「没有」时不等满
    // 2.5 秒、没加上的几项带稳定原因码交给浮层列出来。几处写入器共用代码省下约 0.3 KB 已算在里面。没有带进新的依赖。
    // 调到 484 KiB 留约 2.3 KB；再碰线时同样写明加了什么。
    // 2026-09-24：488 → 492 KiB。#111 合进含 #110（Workable 全加全存）的 main（1042d98）后实测 501,643 字节（+2,932，与分支上量的
    // 一致：搜索式多选的写入器、规则解析、回车那一路，以及技能搜索的总时限与「没加上」的分组说明）。没有带进新的依赖。
    // 调到 492 KiB 留约 2.1 KB；在途的第 3 页问法、AI 流式合进来时照样再量、再调。
    // 2026-09-24：492 → 496 KiB。main（944c4eb，含 #112 AI 流式、#113 第 3 页问法）上已是 503,650 字节，只剩 158 字节。
    // 这一刀是 Workday 第 3 页的两处误判（adobe.wd5 实测）：岗位公司名打头的法人实体代码（「ADUS-Adobe Inc.」）比对前去掉、
    // 担保签证题括号里举例的「spouse visa」不再当成「涉及他人」——两条正则与几行调用，实测 503,883 字节（+233）。
    // 没有带进新的依赖。调到 496 KiB 留约 4 KB；再碰线时同样写明加了什么。
    // 2026-09-28：496 → 500 KiB。替用户注册、登录招聘网站：Assistant 产物里浮层从不挂出来，账号墙那一路（控制器、保险箱的
    // 消息、浮层的卡与菜单、页面上的看守）整条是死代码、不在这个文件里；留在这里的只是内核在任何构建里都活着的三样——把规则
    // 里的 `accountSteps` 解析、编译成账号墙（约 4.6 KB），点击策略里规则声明的账号控件那一支与它的事实（约 1.5 KB），
    // 连填那一轮在账号墙之后换一次路径、人机验证判据的 `ignoreLogin`（约 0.3 KB）。合进含 #131、#134 的 main（0663c78）后
    // 同基点实测 500,906 → 507,373（+6,467），496 KiB 只剩 531 字节。没有带进新的依赖。调到 500 KiB 留约 4.6 KB；再碰线时
    // 同样写明加了什么。
    // 2026-09-28：500 → 520 KiB。通用路（公司自建的申请表）这一轮（claude/generic-fill）加上公司自建的表自动打开浮层：合进含
    // #133 的 main（74d9d61）后同基点实测 507,373 → 527,008 字节（+19,635）。按模块（esbuild 压缩后逐文件量，合计 +20.4 KB，
    // 与实测差的是打包器的差异）：没有规则绑定的 ARIA 下拉写入器 write/ariaComboboxGeneric.ts +5.2 KB；计划期的同节改认（光秃秃的
    // Name、Job Title、学历／经历的节标题、别人那一节里的 Name）、电话区号下拉、「I identify as」、现任公司职位从经历推、GPA 数字
    // engine.ts +3.5 KB；这些题面的判据与找节标题的读法 dict/fieldContext.ts +3.4 KB；解释器的简历算门槛、小标签接标题、占位项标签、
    // 「要从下拉里选」交还 +1.8 KB；runner 接下拉写入器与等宿主显示文件 +1.5 KB；拖放上传区、淡出遮罩、宿主换文件 write/setFile.ts
    // +1.5 KB；一拍一份影子根索引 scanRoot.ts +1.0 KB；简历／求职信词表的德法西文 dict/guards.ts +0.7 KB；页面证据多一档与自动打开
    // （kernelScanner、pageEvidence、dockAutoOpen）+0.6 KB；页面否决的可见性 +0.5 KB；外文国名 dict/regions.ts +0.4 KB；其余 +0.3 KB。
    // 规则 JSON 不在这个文件里。没有带进新的依赖。调到 520 KiB 留约 5.3 KB；再碰线时同样写明加了什么。
    // 2026-09-28：520 → 524 KiB。main（c55d8e2f，含 #136 Workday 区号与必填星号）上已是 532,272 字节，只剩 208 字节。这一刀是
    // Workday 简历栏的「宿主确认收下了」：规则新顶层键 `fileUploads` 的解析（约 0.33 KB）、解释器给文件框带上绑定（约 0.15 KB）、
    // write/setFile.ts 按规则声明的部件数「这一份、传好了」的项（约 0.63 KB）、runner 写完之后等这个标记（约 0.15 KB）；先压过一轮
    // （绑定直接用规则本身、键表只写一次、文件名口径与同一拍里看文件名共用），同基点实测 532,272 → 533,526（+1,254）。浮层与连填的
    // 两处（知道还有下一步就不说提交、要他去网站上点时收起让开）在 Assistant 产物里是死代码，不占这里。没有带进新的依赖。
    // 调到 524 KiB 留约 3 KB；再碰线时同样写明加了什么。
    // 2026-10-04：524 → 548 KiB。按资料答「AI 在资料里找不到依据」的那一批（claude/ai-evidence-1004）：内核直接按资料答语言题、
    // 到办公室上班、工作年限、现在在读吗、服过兵役吗，不再送 AI。同基点（main 336cd9d3）实测 534,373 → 554,745 字节（+20,372）。
    // 按模块（esbuild 压缩后逐文件量，合计 +22.8 KB，与实测差的是打包器的差异）：语言题的判读与语言名表 dict/languages.ts +7.7 KB
    // （已删掉少见的本族语写法）；办公方式 dict/workArrangement.ts +4.2 KB；工作年限的认题、按月合并重叠区间、选项分档
    // dict/experienceYears.ts +3.2 KB；engine.ts 接这几类与同节逐题不仲裁 +3.3 KB；在读、服过兵役、「any of X」与 SE／N.V. 后缀
    // dict/historyAnswers.ts +2.8 KB；集合多一样语言 +0.5 KB；kernelFiller 放行与当天 +0.2 KB；其余 +0.2 KB。语言水平的闭集放在
    // profileCollections.ts，worker 只多 124 字节（不把语言名表打进 background）。没有带进新的依赖。合进含 #141–#143、#146 的
    // main（这个文件已是 536,491 字节）后实测 557,052 字节（+20,561），原定的 544 KiB 只剩 4 字节，所以调到 548 KiB 留约 4.0 KB；
    // 再碰线时同样写明加了什么。
    // 2026-10-04：548 → 552 KiB。出差题按资料里「出差最多能接受多少」答（claude/travel-answers-1004，argoland #738）：
    // 在 #144 那一刀之上同基点实测 554,745 → 557,448 字节（+2,703）：出差题的认题、比例与「偶尔／经常」的判读
    // dict/travel.ts 约 2.0 KB，engine 接这一类、kernelFiller 放行、内容脚本带上上限与档案答复的有界读约 0.7 KB。
    // worker 只多读快照里的一格（+605 字节，闭集放在 profileV2Travel.ts，不把判读打进 background）。没有带进新的依赖。
    // 合进含 #141–#144、#146 的 main 后实测 557,052 → 559,755 字节（+2,703），548 KiB 只剩 1,397 字节，所以调到 552 KiB
    // 留约 5.4 KB；再碰线时同样写明加了什么。
    // 2026-10-04：552 → 556 KiB。验证码第 1 步（邮件里的验证码：他在浮层里输，插件写进规则声明的那几格）：Assistant 产物里
    // 浮层从不挂出来，验证码那张卡、看着这一页的那一套（lib/verificationCodePage.ts）、写入原语 write/emailCode.ts、认格的
    // rules/emailVerification.ts 都是死代码、不在这个文件里（认格那一组为此特意没挂在适配器上）；留在这里的只是任何构建里都活着的
    // 三样——规则新顶层键 `emailVerification` 的解析（约 1.5 KB）、扫描时把声明的验证码容器排除在外（约 0.2 KB）、提交控制器在
    // 网站要验证码时交回 CODE_REQUIRED（约 0.4 KB）。同基点（main 336cd9d3）实测 534,373 → 536,469（+2,096），524 KiB 只剩
    // 107 字节；同日的「浮层里提交再开几家」（Dover／Rippling／BambooHR 的最终提交：表外 form 属性认领、扫描时禁用着的那一颗
    // 再认一次）单独量是 +711，两边都合进来约 537.2 KB。没有带进新的依赖。合进含 #141–#148 的 main 后实测 561,967 → 564,064
    // 字节（+2,097），552 KiB 只剩 1,184 字节，所以调到 556 KiB 留约 5.2 KB；再碰线时同样写明加了什么。
    // 2026-10-04：（D7、D8 与自动打开避让，#154）556 KiB 不动。#150 之上（同基点 536,111，只剩 465 字节）这一刀加的都是解释器与
    // 内核里在任何构建都活着的几样：
    // 规则编译出来的适配器多两个方法——申请表还没打开时交出「打开申请表」那一颗（applyGateControl，D8）、交出数据同意页的
    // 表与居住地下拉（readConsentGate，D7）——与它们共用的「这一颗提交得了表吗」；数据同意页的写入（consentGate.ts，专用票、
    // 只动 selectedIndex）与选哪一项的判据（dict/consentGate.ts）；网站自己的主要按钮（wizardAdvance.ts 的 sitePrimaryActions，
    // 浮层自动打开时避让）。同基点实测 536,111 → 537,538（+1,427）。浮层与连填那几处在 Assistant 产物里是死代码，不占这里。
    // 没有带进新的依赖。分支上从 524 调到 528 KiB；合进含 #141–#150 的 main（预算已是 556 KiB）后实测 565,759 → 567,186
    // （+1,427），556 KiB 还留约 2.2 KB，不再调。再碰线时同样写明加了什么。
    expect(statSync(join(root, ASSISTANT_EXECUTOR_FILE)).size).toBeLessThanOrEqual(556 * 1024);
    expect(files(root).reduce((total, path) => total + statSync(path).size, 0)).toBeLessThanOrEqual(3 * 1024 * 1024);
  });
  it('excludes submission APIs from every JS file and keeps the runtime graph conditional', () => {
    const source=files(root).filter(path=>path.endsWith('.js')).map(path=>{
      const text=readFileSync(path,'utf8');
      // React embeds advice mentioning form.submit()/requestSubmit() in a string.
      // Remove only that literal, never executable tokens or other string values.
      const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const ranges:[number,number][]=[];
      const visit=(node:ts.Node)=>{
        if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)) &&
          node.text.startsWith("javascript:throw new Error('A React form was unexpectedly submitted.") &&
          node.text.includes('consider using form.requestSubmit() instead.')) ranges.push([node.getStart(ast),node.end]);
        ts.forEachChild(node,visit);
      };
      visit(ast);let stripped=text;
      for(const [start,end] of ranges.reverse())stripped=stripped.slice(0,start)+' '.repeat(end-start)+stripped.slice(end);
      return stripped;
    }).join('\n');
    expect(/requestSubmit|\.submit\s*(?:\?\.\s*)?\(/u.test(source)).toBe(false);
    const executor=readFileSync(join(root,ASSISTANT_EXECUTOR_FILE),'utf8');
    // Both Assistant flavours keep host writes off; this marker belongs to that
    // independent gate, not to runtime-bundle fetching.
    expect(executor.includes('SEMANTIC_FILL_ONLY')).toBe(false);
    const worker=ts.createSourceFile('background.js',readFileSync(join(root,'background.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    let client:ts.CallExpression|undefined,base:ts.Expression|undefined;
    const locate=(node:ts.Node)=>{
      if(ts.isCallExpression(node)){
        const options=node.arguments[0];
        if(options&&ts.isObjectLiteralExpression(options)){
          const props=options.properties.filter(ts.isPropertyAssignment);
          if(['apiBase','store','extensionVersion'].every(name=>props.some(p=>p.name.getText(worker)===name))){
            expect(client).toBeUndefined();client=node;base=props.find(p=>p.name.getText(worker)==='apiBase')!.initializer;
          }
        }
      }
      ts.forEachChild(node,locate);
    };
    locate(worker);expect(client).toBeDefined();
    const literal=base&&(ts.isStringLiteral(base)||ts.isNoSubstitutionTemplateLiteral(base))?base.text:null;
    expect(runtimeEnabled?literal:base!.kind).toBe(runtimeEnabled?'https://staging-api.career-companion.invalid':ts.SyntaxKind.NullKeyword);
    // With refresh disabled Rollup inlines the single-use client into authority.
    const binding=ts.isVariableDeclaration(client!.parent)?client!.parent.name.getText(worker):null;
    expect(binding!==null).toBe(runtimeEnabled);
    let refreshes=0;
    const calls=(node:ts.Node)=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&
        node.expression.expression.getText(worker)===binding&&node.expression.name.text==='refresh')refreshes++;
      ts.forEachChild(node,calls);
    };
    calls(worker);expect(refreshes).toBe(runtimeEnabled?1:0);
  });
  it('uses the Portal-configured development identity and limits credentials to staging', () => {
    const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
    expect(manifest.name).toBe('ArgoLand.AI Staging Preview');
    expect(manifest.version).toBe('0.0.5');
    expect(manifest.minimum_chrome_version).toBe('130');
    expect(id).toBe(DEVELOPMENT_EXTENSION_ID);
    expect(manifest.key).toBe(DEVELOPMENT_EXTENSION_PUBLIC_KEY);
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'activeTab', 'scripting', 'webNavigation']);
    expect(manifest.host_permissions).toEqual(['https://staging-api.career-companion.invalid/*']);
    expect(manifest.externally_connectable).toEqual({ matches: ['https://staging.career-companion.invalid/*'] });
    expect(manifest.content_scripts).toEqual([]); expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['assistant.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }]);
  });
  it('ships a runtime-injected host and inert executor and a UI with no fixture or credential client', () => {
    const names = files(root).map(p => p.slice(root.length + 1));
    expect(names).toContain('assistant.html'); expect(names).toContain('intake-recorder.html'); expect(names.some(n => /pcm-worklet.*\.js$/.test(n))).toBe(true); expect(names.filter(n => n.startsWith('content-scripts/'))).toEqual(['content-scripts/apply.js', 'content-scripts/assistant-host.js']);
    const renderer = names.filter(n => (n.startsWith('chunks/') || n.startsWith('content-scripts/')) && n.endsWith('.js')).map(n => readFileSync(join(root, n), 'utf8')).join('\n');
    for (const marker of ['fictional.pdf', '测试用户 A', 'Mia Chen', 'refreshToken', 'Bearer ', '/auth/refresh', 'getAccessToken', 'createPreviewPorts']) expect(renderer).not.toContain(marker);
    expect(renderer).toContain('edaix/assistant-roles-v1');
    expect(renderer).toContain('PATCH_ROLE_PREFS');
    expect(renderer).toContain('CREATE_ROLE');
    expect(renderer).toContain('PATCH_PROFILE_V2');
    const worker = readFileSync(join(root, 'background.js'), 'utf8');
    expect(worker).toContain('PATCH_PROFILE_V2');
    expect(worker).toContain('SAVE_UNCERTAIN');
    expect(worker).toContain('/profile-intake/');
    expect(renderer).toContain('assistant/voice-control-v1');
  });
});

it('serializes the actual Rollup-built probe without a closure and injects the existing packaged file', () => {
  const worker = readFileSync(join(root,'background.js'),'utf8');
  const ast = ts.createSourceFile('background.js',worker,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const functions: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.body?.getText(ast).includes('__edaixAssistantExecutorV1') && node.body.getText(ast).includes('ABSENT')) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(functions).toHaveLength(1);
  const probe = functions[0];
  for (const [value, expected] of [[undefined,'ABSENT'],['READY','READY'],['INSTALLING','INSTALLING'],['FAILED','FAILED'],['invalid','UNAVAILABLE']]) {
    expect(runInNewContext(`(${probe.getText(ast)})()`, {__edaixAssistantExecutorV1:value})).toBe(expected);
  }
  expect(worker).toContain(ASSISTANT_EXECUTOR_FILE);
  // The minifier may name the probe `$p`: a `$` (or any identifier character that is special in a
  // pattern) must be matched literally, or the assertion can never hold (2026-09-24).
  const probeName = probe.name!.text.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');
  expect(worker).toMatch(new RegExp(`func:\\s*${probeName}[,}]`));
  expect(statSync(join(root,ASSISTANT_EXECUTOR_FILE)).isFile()).toBe(true);
});
it('marks a compiled executor initialization failure and refuses a second partial installation', () => {
  const source=readFileSync(join(root,ASSISTANT_EXECUTOR_FILE),'utf8');
  const ast=ts.createSourceFile('apply.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const markers:ts.FunctionDeclaration[]=[];let main:ts.MethodDeclaration|undefined;
  const visit=(node:ts.Node)=>{
    if(ts.isFunctionDeclaration(node)&&node.body?.getText(ast).includes('__edaixAssistantExecutorV1'))markers.push(node);
    if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='main'&&node.body?.getText(ast).includes('window.top'))main=node;
    ts.forEachChild(node,visit);
  };
  visit(ast);expect(main).toBeDefined();expect(markers.length).toBeGreaterThanOrEqual(3);
  const window={};Object.assign(window,{top:window,self:window});
  const scope={window,__edaixAssistantExecutorV1:undefined as unknown};
  // Deliberately omit the first setup dependency. The emitted catch must mark FAILED,
  // so the installer requests a reload instead of retrying partially installed listeners.
  const code=markers.map(node=>node.getText(ast)).join('\n')+`;({${main!.getText(ast)}}).main()`;
  runInNewContext(code,scope);expect(scope.__edaixAssistantExecutorV1).toBe('FAILED');
  runInNewContext(code,scope);expect(scope.__edaixAssistantExecutorV1).toBe('FAILED');
});
