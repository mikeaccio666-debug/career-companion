import { C, PRIMARY_BG, PRIMARY_SHADOW } from '../design/palette';
import type { ViewContext } from './view-context';
import type { ChatMessage, CandidateCard, Entitlement, ProfileField, UploadState } from '../state/types';
import { usageLine, uploadView, reviewView } from './profile-view';
import { deckView, atsView, batchView } from './jobs-view';
import { shortView, prepView, coverView, fillView } from './materials-view';
import { sheetView } from './sheet-view';
import { messageView } from './message-view';

export function createAssistantView(ctx: ViewContext) {
    const F = ctx.data; const S = ctx.state;
    const scene = S.scene; const d = ctx.panelDims(scene); const wide = d.wide; const p = S.profile; const nick = p.nick || (p.name || '').split(' ')[0];
    // Header
    const sessionLine = S.session === 'connected' ? (S.hasResume ? ctx.t("已连接 Portal · 使用 ") + ctx.resume().label : ctx.t("已连接 Portal · 还没有简历")) : S.session === 'expired' ? ctx.t("连接已过期 · 请重新连接") : ctx.t("未连接");
    const headerRight = { welcome: '', home: '', chat: ctx.t("第 ") + (S.chat.phase + 1) + ctx.t(" / 3 组"), profile: ctx.t("完整资料"), deck: ctx.t("第 ") + S.deck.batchNo + ctx.t(" 组"), batchend: '', shortlist: '', preparing: '', cover: 'COVER LETTER', autofill: 'AUTOFILL' }[scene] || '';
    const ui = { isWelcome: scene === 'welcome', isHome: scene === 'home', isChat: scene === 'chat', isProfile: scene === 'profile', isDeck: scene === 'deck', isBatchEnd: scene === 'batchend', isShortlist: scene === 'shortlist', isPreparing: scene === 'preparing', isCover: scene === 'cover', isAutofill: scene === 'autofill', showHeader: scene !== 'welcome', wide, narrow: !wide, heroH: ctx.heroH(d), statusLine: sessionLine, statusDot: S.session === 'connected' ? C.green : S.session === 'expired' ? C.coral : '#C9D2DF', headerRight };
    // Welcome
    const connected = S.session === 'connected'; const connecting = S.session === 'connecting';
    const welcome = connected ? { title: nick + ctx.t("，欢迎回来。\n你的下一站，我们一起找。"), sub: S.hasResume ? ctx.t("我记得你的方向：") + p.role + ctx.t("。\n今天的机会已经整理好了。") : ctx.t("先从一份简历开始，让我认识你；\n之后每一天，都能更快找到适合你的机会。"), primaryAct: 'morph-home', primaryLabel: ctx.t("发现今天的机会"), secondaryAct: 'personalize', secondaryLabel: S.hasResume ? ctx.t("先完善我的资料") : ctx.t("先上传简历，完善资料"), foot: ctx.t("已连接 Portal · 继续使用你的求职资料"), footDot: C.green, connecting: false, notConnecting: true }
      : { title: ctx.t("每一个新的开始，\n都有 ArgoLand.AI 陪你。"), sub: ctx.t("连接你的 ArgoLand 账号，\n让求职从这一刻变得轻一点。"), primaryAct: 'login', primaryLabel: S.session === 'expired' ? ctx.t("重新连接 ArgoLand") : ctx.t("登录 ArgoLand"), secondaryAct: 'signup', secondaryLabel: ctx.t("还没有账号？从这里开始"), foot: S.session === 'expired' ? ctx.t("连接已过期 · 重新登录后继续") : ctx.t("登录将前往 ArgoLand Portal"), footDot: S.session === 'expired' ? C.coral : '#C9D2DF', connecting, notConnecting: !connecting };
    const hh = ui.heroH, w = d.w;
    const k = Math.min(1, hh / 320); const compactHero = hh < 230;
    const mentorPositions = [
      { left: 26, top: hh - Math.round(108 * k), size: Math.round(68 * (0.8 + 0.2 * k)), z: 12, rot: -6, opacity: 1, blur: 0, radius: 20, innerRadius: 16, shadowY: 20, shadowBlur: 30 },
      { left: w - 96, top: hh - Math.round(98 * k), size: Math.round(60 * (0.8 + 0.2 * k)), z: 12, rot: 5, opacity: 1, blur: 0, radius: 18, innerRadius: 14, shadowY: 18, shadowBlur: 28 },
      { left: 58, top: Math.round(22 * k), size: 44, z: 5, rot: 4, opacity: compactHero ? 0 : .78, blur: .6, radius: 14, innerRadius: 11, shadowY: 10, shadowBlur: 18 },
      { left: w - 118, top: Math.round(14 * k), size: 50, z: 5, rot: -5, opacity: compactHero ? 0 : .85, blur: .4, radius: 16, innerRadius: 12, shadowY: 12, shadowBlur: 20 }];
    const mentors = F.mentors.slice(0, mentorPositions.length).map((mentor, index) => ({ src: mentor.src, ...mentorPositions[index] }));
    // Home
    const stages = F.phases.map((ph, i) => { const done = S.confirmed[ph.id] || (i === 2 && S.privacy !== 'unset'); return { title: ph.short, mark: done ? '✓' : (i + 1), bar: done ? C.green : i === 2 ? '#DDE3EC' : '#DDE3EC', color: done ? C.green : C.faint }; });
    const allDone = S.profileDone || (S.confirmed[0] && S.confirmed[1] && (S.confirmed[2] || S.privacy !== 'unset'));
    const curT = ctx.currentTarget(); const nT = S.targets.length;
    const home = { shortlistTitle:ctx.t(S.commerceEnabled?'已收藏的岗位':'我的申请清单'), targetRole: curT ? curT.role : ctx.t("还没有目标岗位"), targetChip: nT > 1 ? ctx.t("其他 ") + (nT - 1) + ctx.t(" 组") : nT === 1 ? ctx.t("添加更多") : ctx.t("去添加"), targetChipBg: nT > 1 ? '#EEF1FB' : C.peach, targetChipColor: nT > 1 ? '#3B4762' : '#8A5A2B', targetStacked: nT > 1, targetStackPad: nT > 1 ? 10 : 0,
      greeting: allDone ? ctx.t("准备好了，") + nick + ctx.t("。\n今天向新机会出发。") : nick + ctx.t("，让我更懂你一点，\n再一起出发。"), initial: (p.name || 'M')[0], name: p.name, roleLine: (curT ? curT.role : p.role) + ' · ' + (p.city || ctx.t("城市待补充")), badge: allDone ? 'READY' : S.hasResume ? 'IN PROGRESS' : 'START', badgeBg: allDone ? C.mint : C.lilac, badgeColor: allDone ? C.green : '#3B4762', stages, profileNote: allDone ? ctx.t("资料已确认 · 可选信息") + (S.privacy === 'skipped' ? ctx.t("已跳过") : S.privacy === 'declined' ? ctx.t("选择不愿回答") : ctx.t("由你决定")) : S.hasResume ? ctx.t("简历已同步 · ") + [ctx.t("称呼与联系方式"), ctx.t("工作偏好与许可"), ctx.t("可选信息")][ctx.nextPhase()] + ctx.t("待确认") : ctx.t("从一份简历开始，认识你"), resumeLine: S.hasResume ? ctx.resume().label + ctx.t(" · 另有 ") + (F.resumeVersions.length - 2) + ctx.t(" 个历史方向") : ctx.t("还没有简历 · 上传后开始"), resumeTag: S.hasResume ? ctx.t("可用") : ctx.t("待上传"), resumeTagBg: S.hasResume ? C.mint : C.peach, resumeTagColor: S.hasResume ? C.green : '#8A5A2B', lettersLine: Object.keys(S.letters).length ? Object.keys(S.letters).length + ctx.t(" 封草稿") : ctx.t("尚无草稿"), shortlistLine: S.deck.selected.length ? ctx.t("已选 ") + S.deck.selected.length + ctx.t(" 个机会 · ") + (Object.values(S.prep).filter(x => x === 'ready').length ? Object.values(S.prep).filter(x => x === 'ready').length + ctx.t(" 个已就绪") : ctx.t("待你确认准备")) : ctx.t("把心动的机会留在这里"), shortlistTag: S.deck.selected.length ? String(S.deck.selected.length) : ctx.t("空"), shortlistTagBg: S.deck.selected.length ? C.ice : C.grey, shortlistTagColor: S.deck.selected.length ? C.ink : C.faint, usageLine: usageLine(ctx), discoverNote: ctx.t("一组最多 10 个 · 按你的节奏挑选 · 示例岗位") };
    // Chat
    const chatStages = F.phases.map((ph, i) => { const cur = S.chat.phase === i; const done = S.confirmed[ph.id]; return { title: ph.short, mark: done ? '✓' : (i + 1), bg: cur ? C.ink : 'transparent', color: cur ? '#fff' : done ? C.green : C.faint, dotBg: cur ? 'rgba(255,255,255,.16)' : done ? C.mint : C.grey, dotColor: cur ? '#fff' : done ? C.green : C.faint, weight: cur ? 600 : 500 }; });
    const messages = S.chat.messages.map(m => messageView(ctx, m));
    const uploading = S.chat.messages.some(m => m.role === 'upload' && ['idle', 'uploading', 'reading', 'organizing', 'failed'].includes(m.upload.state));
    const chatEnt = ctx.ent('chat'), voiceEnt = ctx.ent('voice');
    const chat = { stages: chatStages, resumeLabel: S.hasResume ? ctx.resume().label : ctx.t("尚未上传"), messages, thinking: S.chat.stage === 'thinking' || S.chat.stage === 'extracting', thinkingLabel: S.chat.stage === 'thinking' ? ctx.t("ArgoLand.AI 正在理解…") : ctx.t("正在整理要点…"), showPrivacyActions: S.chat.privacyPrompt && S.chat.stage === 'idle' && S.chat.phase === 2 && !S.confirmed[2], showReviewCta: S.chat.reviewPrompt, showMorePrompt: S.chat.morePrompt && S.chat.stage === 'idle', showComposer: !uploading && !S.chat.reviewPrompt, input: S.chat.input, placeholder: F.phases[S.chat.phase].hint, quotaHint: chatEnt.remaining === undefined ? ctx.t("对话权益暂不可用") : chatEnt.remaining === null ? ctx.t("对话不限量（示例）") : ctx.t("对话 · 今天剩余 ") + chatEnt.remaining + ctx.t(" 轮 · 语音剩余 ") + voiceEnt.remaining + ctx.t(" 分钟（示例）"), sendDisabled: !(S.chat.input || '').trim() || S.chat.stage !== 'idle' };
    const vs = S.voice.state; const bars = Array.from({ length: 18 }, (_, i) => ({ dur: (0.7 + ((i * 37) % 10) / 14).toFixed(2), delay: (((i * 53) % 10) / 12).toFixed(2) }));
    const voice = { recording: vs === 'recording', processing: vs === 'processing', idleOrTranscript: vs === 'idle' || vs === 'transcript', transcript: vs === 'transcript', timer: '0:' + String(S.voice.secs).padStart(2, '0'), bars, notice: !!S.voice.notice, noticeText: S.voice.notice, borderColor: vs === 'recording' ? '#F3B7AE' : vs === 'transcript' ? '#BFD5C9' : C.line };
    // Review
    const review = reviewView(ctx, wide);
    // Deck
    const deck = deckView(ctx); const ats = atsView(ctx, deck.jobId);
    const batch = batchView(ctx); const short = shortView(ctx); const prep = prepView(ctx); const cover = coverView(ctx); const fill = fillView(ctx);
    const launcher = { visible: !S.launcherHidden && !S.panelOpen, hiddenNote: S.hiddenNote && !S.panelOpen, top: S.launcherTop };
    const sheet = sheetView(ctx);
    const modal = S.modal ? { open: true, title: S.modal.title, text: S.modal.text, actions: S.modal.actions.map(a => ({ id: a.id, label: a.label, bg: a.primary ? C.ink : a.ghost ? 'transparent' : '#fff', color: a.primary ? '#fff' : a.ghost ? C.ink2 : C.ink, border: a.primary || a.ghost ? 'transparent' : C.line })) } : { open: false, title: '', text: '', actions: [] };
    if (S.reads) {
      const r = S.reads;
      const resumeStatus = r.resumes === 'loading' ? ctx.t("正在读取简历") : r.resumes === 'locked' ? ctx.t("简历暂未获准读取") : r.resumes === 'unavailable' ? ctx.t("简历暂不可用") : S.hasResume ? ctx.resume().label : r.processingCount ? ctx.t("简历处理中") : ctx.t("还没有简历");
      ui.statusLine = S.session === 'connected' ? ctx.t("已连接 Portal · {v0}", { v0: resumeStatus }) : S.session === 'connecting' ? ctx.t("正在确认连接") : S.session === 'expired' ? ctx.t("连接已过期 · 请重新连接") : ctx.t("未连接");
      ui.headerRight = ctx.t(ctx.state.scene === 'chat' && ctx.state.intakeEnabled !== false ? "聊聊你的经历" : "资料与简历");
      if (connected) Object.assign(welcome, { title: p.name ? ctx.t("{v0}，欢迎回来。\n你的下一站，我们一起找。", { v0: nick || p.name }) : ctx.t("欢迎回来。\n先看看你的求职资料。"),
        sub: r.personal === 'loading' ? ctx.t("正在读取你的资料与简历。") : ctx.t("查看已保存的资料与简历，\n为下一步求职做好准备。"),
        primaryLabel: ctx.t("进入工作台"), secondaryLabel: ctx.t("查看我的资料"), foot: ui.statusLine });
      else Object.assign(welcome, { secondaryAct: 'session-refresh', secondaryLabel: ctx.t("我已在 Portal 登录，刷新连接") });
      if (S.session === 'unavailable' || S.connectionIssue?.code === 'OWNER_CHANGED') {
        ui.statusLine = S.connectionIssue?.code === 'OWNER_CHANGED' ? ctx.t("账号状态已变化 · 请刷新连接")
          : S.connectionIssue?.stage === 'CONNECTION' ? ctx.t("插件通信中断 · 刷新当前网页后重试")
          : ctx.t("连接暂不可用 · 请刷新连接重试");
        // 「从没连过」与「连过但断了」是两件事，主按钮不能都给"刷新"。
        //
        // 2026-09-16 改。在此之前这里把主按钮写死成 session-refresh，而 refresh
        // 假设已经连接过、只是去续一次会话；从没连过的人点它必然失败，提示是
        // "暂时无法更新连接，请重试"——重试多少次都一样。次按钮的动作其实是
        // `login`（打开门户建立连接），文案却写着"打开 Portal 连接设置"，于是
        // 唯一能用的入口被标成了一个看起来无关的东西，没人会去点。
        //
        // 判据用 `S.everConnected`：它只在成功连接过之后为真，正好分开这两种人。
        const firstTime = S.everConnected !== true;
        Object.assign(welcome, firstTime
          ? { primaryAct: 'login', primaryLabel: ctx.t("前往 ArgoLand Portal 登录"),
              secondaryAct: 'session-refresh', secondaryLabel: ctx.t("我已在 Portal 登录，刷新连接") }
          : { primaryAct: 'session-refresh', primaryLabel: ctx.t("刷新连接"),
              secondaryAct: 'login', secondaryLabel: ctx.t("重新连接 ArgoLand") });
        Object.assign(welcome, { foot: ui.statusLine, footDot: C.coral });
      }
      home.greeting = p.name ? ctx.t("{v0}，欢迎回来。", { v0: nick || p.name }) : ctx.t("欢迎回来。");
      home.initial = (p.name || 'A')[0]; home.name = p.name || ctx.t("求职资料"); home.roleLine = p.city || ctx.t("城市尚未提供");
      home.badge = r.personal === 'loading' ? ctx.t("读取中") : r.personal === 'ready' ? ctx.t("已同步") : ctx.t("暂不可用");
      home.profileNote = r.personal === 'ready' ? ctx.t("已保存的基本资料 · 只读") : r.personal === 'loading' ? ctx.t("正在读取基本资料") : ctx.t("资料暂不可用，可刷新重试");
      home.resumeLine = resumeStatus; home.resumeTag = r.resumes === 'ready' ? (S.hasResume ? ctx.t("可查看") : r.processingCount ? ctx.t("处理中") : ctx.t("空")) : ctx.t("待确认");
      home.discoverNote = S.commerceEnabled?ctx.t("查看这个方向的职位推荐"):ctx.t("岗位发现尚未接入"); home.usageLine = usageLine(ctx);
    }
    if(S.commerceEnabled){home.shortlistLine=ctx.t('收藏职位，随时查看详情与评估');home.discoverNote=ctx.t('查看这个方向的职位推荐');}
    return ({ locale: ctx.locale, t: ctx.t, ui, welcome: { ...welcome,
      diagnostic: S.connectionIssue ? `${S.connectionIssue.stage} / ${S.connectionIssue.code}` : '' },
      mentors, home, chat, voice, review, deck, ats, batch, short, prep, cover, fill, launcher, sheet, modal, toast: { show: !!S.toast, text: S.toast } });
  }

export type AssistantView = ReturnType<typeof createAssistantView>;
