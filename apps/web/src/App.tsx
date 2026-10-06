import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ChatMarkdown from './ChatMarkdown';
import { ArrowDown, ArrowRight, ArrowUp, AudioLines, BookOpen, Check, ChevronDown, ChevronRight, Circle, CircleStop, ClipboardCheck, Compass, Copy, Feather, Globe2, Image, Layers3, Leaf, Loader2, LogOut, Link2, Menu, MessageCircle, MoreHorizontal, PanelRightClose, Paperclip, Plus, Settings2, ShieldCheck, Sparkles, TerminalSquare, Trash2, X } from 'lucide-react';
import { ApiError, capturePlatformClient, collection, entity, errorText, post as platformPost, remove as platformRemove, request as platformRequest, streamMessage as platformStreamMessage } from './api';
import { platformAccountContext } from './account-context';
import { PlatformAccountClientProvider } from './account-client';
import { notifySessionChanged } from './session-events';
import { AccountPollingController } from './account-polling';
import { AccountOperationScope, executeAccountOperation, executeAccountSelection, refreshAccountData, requireAccountResult, StaleAccountOperation, transitionAccount, type AccountOperationToken } from './account-operations';
import AuthView from './AuthView';
import AccountActionView, { AccountGate, EmailVerificationControls } from './AccountActionView';
import { AccountActionInbox, canOpenPrivateWorkspace, parseAuthOptions, takeAccountActionLink, type AccountActionLink, type AuthOptions } from './account-actions';
import SettingsPanel from './SettingsPanel';
import KnowledgePanel from './KnowledgePanel';
import TaskPanel from './TaskPanel';
import McpToolPanel from './McpToolPanel';
import ConversationTasksPanel from './ConversationTasksPanel';
import { applyConversationTaskDraft, type ConversationTaskReference } from './conversation-task-draft';
import { mcpResultAgentDraft, ownedMcpResultJob } from './mcp-editor';
import CreativePanel from './CreativePanel';
import WorkflowPanel from './WorkflowPanel';
import BrowserPanel from './BrowserPanel';
import ApprovalDetails from './ApprovalDetails';
import VoicePanel from './VoicePanel';
import VoiceRecords from './VoiceRecords';
import PrivateFileLink from './PrivateFileLink';
import { PublicConnectionView } from './PwaStatus';
import { pwaRuntime, readWorkspaceBootstrap } from './pwa-runtime';
import { openVoiceDraft, VoiceDraftStore, type VoiceDraftHandle } from './voice-draft';
import { applyAgentDraftHandoff, artifactAgentDraft, ownedTextArtifactReference } from './agent-handoff';
import { agentToolStatusText, appendAgentApprovalStatus, finishAgentToolStatuses, upsertAgentToolStatus, type AgentToolStatus } from './agent-tool-status';
import type { ConversationTask, VoiceRecord, VoiceRecordInput } from '@companion/platform-contracts';
import { Badge, Brand, isJobActive, isProviderReady, jobLabel, providerModels, ProviderSelect, statusLabel } from './ui';
import type { Approval, Artifact, ChatMode, Conversation, Job, JobKind, Memory, Message, PlatformState, Upload, User, View } from './types';
const navigation = [
  { id: 'chat', label: '一起思考', english: 'CHAT', icon: MessageCircle },
  { id: 'companion', label: '陪伴与练习', english: 'COMPANION', icon: Leaf },
  { id: 'voice', label: '语音交流', english: 'VOICE', icon: AudioLines },
  { id: 'create', label: '创作工作室', english: 'CREATE', icon: Image },
  { id: 'browser', label: '浏览器 Agent', english: 'BROWSER', icon: Globe2 },
  { id: 'cli', label: '终端工作区', english: 'TERMINAL', icon: TerminalSquare },
  { id: 'mcp', label: '外部工具', english: 'EXTERNAL TOOLS', icon: Link2 },
  { id: 'knowledge', label: '我的资料库', english: 'KNOWLEDGE', icon: BookOpen },
  { id: 'workflow', label: '工作流', english: 'WORKFLOWS', icon: Layers3 },
] as const;
const personas = [
  { id: 'warm', name: '温暖的同行者', description: '耐心倾听，用小步行动帮你向前。', prompt: 'Be a warm, thoughtful companion. Listen carefully, ask one useful question at a time, and help the user make small practical progress. Avoid excessive praise.' },
  { id: 'coach', name: '表达练习伙伴', description: '一起演练对话，给出具体反馈。', prompt: 'Be a supportive practice partner for communication, interviews and real life conversations. Agree on a scenario, role-play, then give specific actionable feedback.' },
  { id: 'curious', name: '好奇的合伙人', description: '挑战假设，陪你探索新的可能。', prompt: 'Be a curious brainstorming partner. Help examine assumptions, compare possibilities and turn ideas into experiments. Be candid and concrete.' },
];
const accountActionInbox = new AccountActionInbox(typeof window === 'undefined' ? null : takeAccountActionLink(window.location, window.history));

export default function App() {
  const [accountAction, setAccountAction] = useState<AccountActionLink | null>(() => accountActionInbox.peek());
  const [authOptions, setAuthOptions] = useState<AuthOptions | null>(null);
  const [authNotice, setAuthNotice] = useState('');
  const [forceLogin, setForceLogin] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const requestAccount = useSyncExternalStore(platformAccountContext.subscribe, platformAccountContext.getSnapshot, platformAccountContext.getSnapshot);
  const accountClient = useMemo(() => requestAccount.accountId ? capturePlatformClient({ accountId: requestAccount.accountId, generation: requestAccount.generation }) : null, [requestAccount]);
  const request = accountClient?.request ?? platformRequest, post = accountClient?.post ?? platformPost, remove = accountClient?.remove ?? platformRemove, streamMessage = accountClient?.streamMessage ?? platformStreamMessage;
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [state, setState] = useState<PlatformState>({ providers: [] });
  const [view, setView] = useState<View>('chat');
  const [drawer, setDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [voiceRecordsByConversation, setVoiceRecordsByConversation] = useState<Record<string, VoiceRecord[]>>({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState(false);
  const [persona, setPersona] = useState('warm');
  const [draft, setDraft] = useState('');
  const [draftNotice, setDraftNotice] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<AgentToolStatus[]>([]);
  const [conversationTaskRefresh, setConversationTaskRefresh] = useState(0);
  const [error, setError] = useState('');
  const { online } = useSyncExternalStore(pwaRuntime.subscribe, pwaRuntime.getSnapshot, pwaRuntime.getSnapshot);
  const [memoryDraft, setMemoryDraft] = useState<string | null>(null);
  const [savingMemory, setSavingMemory] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const initializationAbort = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messageLoadSequence = useRef(0);
  const accountScope = useRef(new AccountOperationScope());
  const accountPolling = useRef<AccountPollingController | null>(null);
  const voiceDrafts = useRef(new VoiceDraftStore());
  const renderSession = accountScope.current.snapshot();
  const currentUser = useRef(user); currentUser.current = user;
  const privateAllowed = canOpenPrivateWorkspace(authOptions, user, accountAction);
  const privateAccess = useRef(privateAllowed); privateAccess.current = privateAllowed;
  const activeConversationId = useRef(activeId); activeConversationId.current = activeId;
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const voiceRecords = activeId ? voiceRecordsByConversation[activeId] || [] : [];
  const mode: ChatMode = view === 'companion' ? 'companion' : agent ? 'agent' : 'chat';
  const chosenProvider = state.providers.find((provider) => provider.id === providerId);
  const activeJobs = jobs.filter(isJobActive);
  const pendingApprovals = approvals.filter((approval) => ['pending', 'awaiting_approval', 'requested'].includes(approval.status));
  const showChat = view === 'chat' || view === 'companion';
  const title = navigation.find((item) => item.id === view)?.label || '工作台设置';

  const resetPrivateData = useCallback(() => {
    initializationAbort.current?.abort(); initializationAbort.current = null;
    accountPolling.current?.stop(); accountPolling.current = null;
    abort.current?.abort(); abort.current = null; ++messageLoadSequence.current;
    accountScope.current.invalidate('messages'); activeConversationId.current = null;
    voiceDrafts.current.changeSession(accountScope.current.snapshot());
    setConversations([]); setActiveId(null); setMessages([]); setVoiceRecordsByConversation({});
    setJobs([]); setMemories([]); setApprovals([]); setDraft(''); setDraftNotice(''); setUploads([]); setToolStatus([]);
    setLoadingMessages(false); setUploading(false); setStreaming(false); setSavingMemory(false);
    setMemoryDraft(null); setError(''); setAgent(false); setPersona('warm'); setProviderId(''); setModel('');
    setView('chat'); setDrawer(false); setRightDrawer(false); setContextOpen(true);
    if (file.current) file.current.value = '';
  }, []);
  const switchAuthentication = useCallback((next: User | null) => {
    platformAccountContext.changeSession(next?.id || null);
    transitionAccount(accountScope.current, next, resetPrivateData, setUser); setInitializing(false);
  }, [resetPrivateData]);
  useEffect(() => platformAccountContext.subscribeInvalidation((reason) => {
    privateAccess.current = false; accountScope.current.changeSession(null);
    resetPrivateData(); currentUser.current = null; setUser(null);
    accountActionInbox.clear(); setAccountAction(null); setAuthOptions(null); setForceLogin(true);
    setAuthNotice(reason === 'external-auth-change' ? '另一个窗口更新了登录状态。请重新确认账号，再继续。' : '登录状态已变化。请重新确认账号，再继续。');
    setConnectionUnavailable(true); setInitializing(false);
  }), [resetPrivateData]);
  const accountError = useCallback((token: AccountOperationToken, failure: unknown) => {
    if (!accountScope.current.isCurrent(token) || failure instanceof StaleAccountOperation) return;
    if (failure instanceof ApiError && failure.status === 401) { switchAuthentication(null); setError('登录已失效，请重新登录。'); }
    else if (failure instanceof ApiError && failure.code === 'EMAIL_VERIFICATION_REQUIRED') {
      const current = currentUser.current; if (current) switchAuthentication({ ...current, emailVerified: false });
      setAuthOptions((previous) => previous ? { ...previous, requireVerifiedEmail: true } : previous);
    }
    else setError(errorText(failure));
  }, [switchAuthentication]);
  function privateToken(lane?: string): AccountOperationToken {
    if (!user || !privateAllowed || !accountScope.current.isCurrent(renderSession)) throw new StaleAccountOperation();
    const token = accountScope.current.begin(lane); if (!token) throw new StaleAccountOperation(); return token;
  }
  function reportPanelError(message: string) { if (accountScope.current.isCurrent(renderSession)) setError(message); }

  const refreshCapabilities = useCallback(async (throwOnFailure = false) => {
    const results = await Promise.allSettled([platformRequest<Record<string, unknown>>('/health'), platformRequest<unknown>('/capabilities')]);
    const health = results[0].status === 'fulfilled' ? results[0].value : null;
    const capabilityResult = results[1];
    if (capabilityResult.status === 'fulfilled') {
      const data = capabilityResult.value as any;
      const providers = collection<any>(data, 'providers').map((provider) => ({ ...provider, keyConfigured: !!provider.keyConfigured, capabilities: Array.isArray(provider.capabilities) ? provider.capabilities : [], models: Array.isArray(provider.models) ? provider.models : [] }));
      setState({ providers, status: typeof health?.status === 'string' ? health.status : 'connected' });
    } else { setState({ providers: [], error: errorText(capabilityResult.reason), status: 'unavailable' }); if (throwOnFailure) throw capabilityResult.reason; }
  }, []);
  const refreshPrivateData = useCallback(() => privateAccess.current ? refreshAccountData(accountScope.current, request, { conversations: setConversations, jobs: setJobs, memories: setMemories, approvals: setApprovals, onError: (failure, token) => accountError(token, failure) }) : Promise.resolve({ status: 'discarded' as const }), [accountError, request]);
  const refreshUserData = useCallback(async () => { await accountPolling.current?.refreshNow(); }, []);
  const connectWorkspace = useCallback(async (explicitRetry = false) => {
    const token = accountScope.current.begin('initialization', false); if (!token) return;
    initializationAbort.current?.abort();
    if (!explicitRetry && !pwaRuntime.getSnapshot().online) { setConnectionUnavailable(true); setInitializing(false); return; }
    const controller = new AbortController(); initializationAbort.current = controller;
    setInitializing(true); setConnectionUnavailable(false); setError(''); setAuthNotice('');
    await executeAccountOperation(accountScope.current, token, () => readWorkspaceBootstrap(
      (path, signal) => platformRequest(path, { signal }), controller.signal, parseAuthOptions,
      (failure) => failure instanceof ApiError && failure.status === 401,
    ), {
      apply({ options, account, health, capabilities }) {
        const next = account === null ? null : entity<User>(account, 'user');
        if (account !== null && !next?.id) throw new Error('服务没有返回有效的用户。');
        const status = health.status === 'fulfilled' && health.value && typeof health.value === 'object' ? (health.value as Record<string, unknown>).status : undefined;
        const providers = capabilities.status === 'fulfilled' ? collection<any>(capabilities.value, 'providers').map((provider) => ({ ...provider, keyConfigured: !!provider.keyConfigured, capabilities: Array.isArray(provider.capabilities) ? provider.capabilities : [], models: Array.isArray(provider.models) ? provider.models : [] })) : [];
        setState({ providers, status: typeof status === 'string' ? status : capabilities.status === 'fulfilled' ? 'connected' : 'unavailable', ...(capabilities.status === 'rejected' ? { error: errorText(capabilities.reason) } : {}) });
        setAuthOptions(options); setConnectionUnavailable(false); switchAuthentication(next);
      },
      onError() { setConnectionUnavailable(true); },
      finally: () => setInitializing(false),
    });
    if (initializationAbort.current === controller) { controller.abort(); initializationAbort.current = null; }
  }, [switchAuthentication]);
  useEffect(() => {
    accountActionInbox.clear();
    accountScope.current.activate();
    voiceDrafts.current.changeSession(accountScope.current.snapshot());
    void connectWorkspace();
    return () => { accountScope.current.dispose(); platformAccountContext.changeSession(null); voiceDrafts.current.clear(); initializationAbort.current?.abort(); initializationAbort.current = null; abort.current?.abort(); };
  }, [connectWorkspace]);
  useEffect(() => {
    if (!user || !privateAllowed) return;
    const session = accountScope.current.snapshot();
    const polling = new AccountPollingController(refreshPrivateData, {
      now: () => Date.now(), isVisible: () => document.visibilityState === 'visible', isOnline: () => navigator.onLine,
      isCurrent: () => accountScope.current.isCurrent(session),
      setTimer: (run, delay) => window.setTimeout(run, delay), clearTimer: (timer) => window.clearTimeout(timer as number),
    });
    accountPolling.current = polling;
    const resume = () => polling.resume();
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume);
    polling.start();
    return () => {
      polling.stop(); if (accountPolling.current === polling) accountPolling.current = null;
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', resume);
    };
  }, [user, privateAllowed, refreshPrivateData]);
  useEffect(() => {
    if (!user || !privateAllowed || !activeId) return;
    let cancelled = false;
    const id = activeId;
    const token = accountScope.current.begin('voice-records'); if (!token) return;
    void executeAccountOperation(accountScope.current, token, () => request(`/conversations/${encodeURIComponent(id)}/voice-records`), {
      apply(data) {
        if (cancelled) return;
        const loaded = collection<VoiceRecord>(data, 'records');
        setVoiceRecordsByConversation((prior) => ({ ...prior, [id]: [...new Map([...loaded, ...(prior[id] || [])].map((record) => [record.id, record])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
      },
      onError: (failure) => { if (!cancelled) accountError(token, failure); },
    });
    return () => { cancelled = true; };
  }, [user, privateAllowed, activeId, accountError]);
  useEffect(() => { if (!chosenProvider || !(chosenProvider.capabilities.some((capability) => capability === mode) || chosenProvider.capabilities.includes('chat'))) { const next = state.providers.find((provider) => isProviderReady(provider, mode) && provider.capabilities.includes('chat')) || state.providers.find((provider) => provider.capabilities.includes('chat')); setProviderId(next?.id || ''); setModel(providerModels(next, mode)[0] || ''); } }, [state.providers, mode, chosenProvider]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth', block: 'end' }); }, [messages, streaming, toolStatus]);
  useEffect(() => { if (composer.current) { composer.current.style.height = 'auto'; composer.current.style.height = `${Math.min(composer.current.scrollHeight, 160)}px`; } }, [draft]);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && user && privateAllowed && !streaming) { event.preventDefault(); void newConversation(); } if (event.key === 'Escape') { setDrawer(false); setRightDrawer(false); if (!savingMemory) setMemoryDraft(null); } }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, [user, privateAllowed, streaming, view, savingMemory]);

  useEffect(() => {
    const receiveAction = () => {
      const incoming = takeAccountActionLink(window.location, window.history); if (!incoming) return;
      privateAccess.current = false; platformAccountContext.changeSession(currentUser.current?.id || null); accountScope.current.changeSession(currentUser.current?.id || null);
      resetPrivateData(); setAccountAction(incoming); setAuthNotice(''); setInitializing(false);
    };
    window.addEventListener('hashchange', receiveAction); return () => window.removeEventListener('hashchange', receiveAction);
  }, [resetPrivateData]);

  function verifiedAccount(next: User) {
    if (!accountScope.current.isCurrent(renderSession) || next.id !== user?.id) return;
    setAccountAction(null); setAuthNotice('邮箱已验证。'); switchAuthentication(next);
  }
  function resetCompleted() {
    if (!accountScope.current.isCurrent(renderSession)) return;
    setAccountAction(null); setForceLogin(true); switchAuthentication(null); setAuthNotice('密码已更新。请使用新密码重新登录，其他设备也需要重新登录。');
  }
  function leaveAccountAction() {
    setAccountAction(null); setForceLogin(true); setAuthNotice('');
    // Invalidate pending private data and drafts before returning to the account entry.
    switchAuthentication(user);
  }

  function selectConversation(id: string | null) { accountScope.current.invalidate('conversation-selection'); activeConversationId.current = id; setActiveId(id); }
  function invalidateMessages() { ++messageLoadSequence.current; accountScope.current.invalidate('messages'); setLoadingMessages(false); }
  function chooseView(next: View) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    accountScope.current.invalidate('conversation-selection'); invalidateMessages();
    if ((next === 'chat' || next === 'companion') && next !== view) {
      const compatible = activeConversation && (next === 'companion' ? activeConversation.mode === 'companion' : activeConversation.mode !== 'companion');
      if (!compatible) { selectConversation(null); setMessages([]); setToolStatus([]); setAgent(false); }
      else setAgent(activeConversation.mode === 'agent');
    }
    setView(next); setDrawer(false); setRightDrawer(false);
  }
  async function loadConversation(conversation: Conversation) {
    if (streaming || !user || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken('messages'); ++messageLoadSequence.current;
    selectConversation(conversation.id); setView(conversation.mode === 'companion' ? 'companion' : 'chat'); setAgent(conversation.mode === 'agent'); setPersona(personas.find((entry) => entry.prompt === conversation.persona)?.id || 'warm'); setDrawer(false); setMessages([]); setLoadingMessages(true); setToolStatus([]);
    await executeAccountOperation(accountScope.current, token, () => request(`/conversations/${encodeURIComponent(conversation.id)}`), {
      apply: (data) => setMessages(collection<Message>(data, 'messages')),
      onError: (failure) => accountError(token, failure), finally: () => setLoadingMessages(false),
    });
  }
  async function newConversation() {
    if (streaming || !user || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken(), selection = privateToken('conversation-selection'); invalidateMessages();
    await executeAccountSelection(accountScope.current, token, selection, async () => {
      const conversation = entity<Conversation>(await post('/conversations', { title: '新会话', mode: view === 'companion' ? 'companion' : 'chat', ...(view === 'companion' ? { persona: personas.find((entry) => entry.id === persona)?.prompt } : {}) }), 'conversation');
      if (!conversation?.id) throw new Error('服务没有返回会话记录。'); return conversation;
    }, {
      remember(conversation) {
        accountScope.current.invalidate('private-refresh');
        setConversations((prior) => [conversation, ...prior.filter((entry) => entry.id !== conversation.id)]);
      },
      select(conversation) {
        invalidateMessages(); selectConversation(conversation.id); setMessages([]); setToolStatus([]); if (!showChat) setView('chat'); setDrawer(false); composer.current?.focus();
      }, onError: (failure) => accountError(token, failure),
    });
  }
  async function deleteConversation(conversation: Conversation) {
    if (!user || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken();
    await executeAccountOperation(accountScope.current, token, () => remove(`/conversations/${encodeURIComponent(conversation.id)}`), {
      apply() {
        voiceDrafts.current.delete(conversation.id);
        accountScope.current.invalidate('private-refresh'); setConversations((prior) => prior.filter((entry) => entry.id !== conversation.id));
        setVoiceRecordsByConversation((prior) => { const next = { ...prior }; delete next[conversation.id]; return next; });
        if (activeConversationId.current === conversation.id) { invalidateMessages(); selectConversation(null); setMessages([]); setToolStatus([]); }
      }, onError: (failure) => accountError(token, failure),
    });
  }
  async function ensureVoiceConversation(voiceDraft: VoiceDraftHandle): Promise<string> {
    const token = privateToken();
    return voiceDraft.ensureConversation(async () => {
      const selection = privateToken('conversation-selection'); invalidateMessages();
      const result = await executeAccountSelection(accountScope.current, token, selection, async () => {
        const conversation = entity<Conversation>(await post('/conversations', { title: '语音笔记', mode: 'chat' }), 'conversation');
        if (!conversation?.id) throw new Error('服务没有返回会话记录。'); return conversation;
      }, {
        remember(conversation) {
          if (!voiceDrafts.current.bind(voiceDraft, conversation.id)) throw new StaleAccountOperation();
          accountScope.current.invalidate('private-refresh');
          setConversations((prior) => [conversation, ...prior.filter((entry) => entry.id !== conversation.id)]);
        },
        select(conversation) {
          invalidateMessages();
          selectConversation(conversation.id); setMessages([]); setToolStatus([]);
        }, onError: (failure) => accountError(token, failure),
      });
      return requireAccountResult(result).id;
    });
  }
  async function saveVoiceRecord(conversationId: string, input: VoiceRecordInput): Promise<VoiceRecord> {
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, async () => {
      const record = entity<VoiceRecord>(await post(`/conversations/${encodeURIComponent(conversationId)}/voice-records`, input), 'record');
      if (!record?.id) throw new Error('服务没有返回保存的语音摘录。'); return record;
    }, {
      apply: (record) => setVoiceRecordsByConversation((prior) => ({ ...prior, [conversationId]: [...(prior[conversationId] || []).filter((entry) => entry.id !== record.id), record].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })),
      onError: (failure) => accountError(token, failure),
    });
    return requireAccountResult(result);
  }
  function bringVoiceToChat(content: string) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    accountScope.current.invalidate('conversation-selection');
    setView(activeConversation?.mode === 'companion' ? 'companion' : 'chat');
    setAgent(activeConversation?.mode === 'agent'); setDraft(content); setDrawer(false); setRightDrawer(false);
    if (content.length > 20000) setError('这份摘录超过单条聊天的 20,000 字限制，请在草稿中选择需要讨论的部分再发送。');
    requestAnimationFrame(() => { if (accountScope.current.isCurrent(renderSession)) composer.current?.focus(); });
  }
  async function refreshVoiceConversation(id: string) {
    if (!accountScope.current.isCurrent(renderSession)) return;
    await executeAccountOperation(accountScope.current, privateToken('voice-thread-refresh'), () => request(`/conversations/${encodeURIComponent(id)}`), {
      apply(data) {
        const conversation = entity<Conversation>(data, 'conversation');
        if (!conversation?.id || conversation.id !== id) throw new Error('服务没有返回对应的会话。');
        accountScope.current.invalidate('private-refresh');
        setConversations((prior) => [conversation, ...prior.filter((entry) => entry.id !== id)]);
        if (activeConversationId.current === id) setMessages(collection<Message>(data, 'messages'));
      }, onError: (failure) => accountError(renderSession, failure),
    });
  }
  async function openVoiceConversation(id: string) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken('conversation-selection');
    await executeAccountOperation(accountScope.current, token, () => request(`/conversations/${encodeURIComponent(id)}`), {
      apply(data) {
        const conversation = entity<Conversation>(data, 'conversation');
        if (!conversation?.id || conversation.id !== id) throw new Error('服务没有返回对应的会话。');
        invalidateMessages(); selectConversation(id);
        setConversations((prior) => [conversation, ...prior.filter((entry) => entry.id !== id)]);
        setMessages(collection<Message>(data, 'messages')); setToolStatus([]);
        setView(conversation.mode === 'companion' ? 'companion' : 'chat'); setAgent(conversation.mode === 'agent');
        setDrawer(false); setRightDrawer(false);
      }, onError: (failure) => accountError(token, failure),
    });
  }
  function bringBrowserToAgent(content: string) {
    bringToAgent(content);
  }
  function bringArtifactToAgent(job: Job, artifact: Artifact) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    const reference = ownedTextArtifactReference(jobs, job.id, artifact.id);
    if (!reference) { setError('这份成果尚不能作为文字引用，请查看或下载已有结果。'); return; }
    bringToAgent(artifactAgentDraft(reference));
  }
  function bringMcpToAgent(job: Job) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    const source = ownedMcpResultJob(jobs, job.id);
    if (!source) { setError('请重新选择账号中已保存的外部工具任务。'); return; }
    bringToAgent(mcpResultAgentDraft(source.id));
  }
  function bringToAgent(content: string) {
    if (streaming || !accountScope.current.isCurrent(renderSession)) return;
    const result = applyAgentDraftHandoff(accountScope.current, renderSession, { draft, uploads }, content, (plan) => {
      invalidateMessages();
      if (activeConversation?.mode !== 'agent') { selectConversation(null); setMessages([]); setToolStatus([]); }
      setView('chat'); setAgent(true); setDraft(plan.draft); setUploads(plan.uploads); setDrawer(false); setRightDrawer(false);
      setDraftNotice(`${plan.duplicate ? '这份引用已在草稿中。' : '成果引用已追加到 Agent 草稿。'}原有文字${plan.uploads.length ? `和 ${plan.uploads.length} 个附件` : ''}已保留，尚未发送。${plan.exceedsLimit ? '草稿超过单条消息的 20,000 字限制，请编辑后再发送。' : '请补充你想继续完成的目标，再发送。'}`);
    });
    if (!result) return;
    requestAnimationFrame(() => { if (accountScope.current.isCurrent(result.selection)) composer.current?.focus(); });
  }
  function bringConversationTaskToDraft(task: ConversationTask, reference: ConversationTaskReference, enableAgent: boolean) {
    if (streaming || !activeId || !accountScope.current.isCurrent(renderSession) || !accountClient?.isCurrent()) return;
    if (mode !== 'agent' && !enableAgent) { setError('请明确在本对话启用 Agent 后，再追加需要工具读取的引用。'); return; }
    try {
      const applied = applyConversationTaskDraft(accountScope.current, renderSession, activeId, () => activeConversationId.current, task, reference, { draft, uploads }, (plan) => {
        // Keep this exact conversation and its messages; the user explicitly enables the tool mode.
        if (enableAgent) { setView('chat'); setAgent(true); }
        setDraft(plan.draft); setUploads(plan.uploads);
        setDraftNotice(`${plan.duplicate ? '这份引用已在本对话草稿中。' : '成果引用已追加到本对话草稿。'}原有文字${plan.uploads.length ? `和 ${plan.uploads.length} 个附件` : ''}已保留，尚未发送。${enableAgent ? '已明确在本对话启用 Agent；' : ''}${plan.exceedsLimit ? '草稿超过单条消息的 20,000 字限制，请编辑后再发送。' : '请检查草稿，再点击发送。'}`);
      });
      if (applied) requestAnimationFrame(() => { if (accountScope.current.isCurrent(renderSession) && activeConversationId.current === task.origin.conversationId) composer.current?.focus(); });
    } catch (failure) { accountError(renderSession, failure); }
  }
  function locateConversationTaskReply(messageId: string) {
    if (!accountScope.current.isCurrent(renderSession) || activeConversationId.current !== activeId) return;
    const reply = document.getElementById(`message-${messageId}`);
    if (reply) { reply.scrollIntoView({ behavior: 'smooth', block: 'start' }); reply.focus({ preventScroll: true }); }
    else setError('原回复暂未载入，请重新打开本会话；任务的来源记录仍已保存。');
  }
  async function uploadFile(selected: File): Promise<Upload> {
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, async () => {
      const form = new FormData(); form.append('file', selected);
      const upload = entity<Upload>(await request('/uploads', { method: 'POST', body: form }), 'attachment');
      if (!upload?.id) throw new Error('上传没有返回文件记录。'); return upload;
    }, { onError: (failure) => accountError(token, failure) });
    return requireAccountResult(result);
  }
  async function attach(files: FileList | null) {
    if (!files || !user || uploading || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken('chat-uploads'); setUploading(true);
    await executeAccountOperation(accountScope.current, token, async () => {
      for (const selected of Array.from(files)) {
        const result = await executeAccountOperation(accountScope.current, token, () => uploadFile(selected), { apply: (upload) => setUploads((prior) => [...prior, upload]) });
        requireAccountResult(result);
      }
    }, { onError: (failure) => accountError(token, failure), finally() { setUploading(false); if (file.current) file.current.value = ''; } });
  }
  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (!user || !accountScope.current.isCurrent(renderSession)) return;
    const content = draft.trim(); if (!content || streaming || uploading) return;
    if (content.length > 20000) { setError('单条消息最多 20,000 字，请编辑草稿后发送。'); return; }
    if (!isProviderReady(chosenProvider, mode)) { setError(chosenProvider?.reason || '这个模型服务待配置或已停用。请打开设置查看服务端配置；会话和文件仍可保存。'); return; }
    accountScope.current.invalidate('conversation-selection');
    const token = privateToken('messages'), localUploads = uploads;
    setStreaming(true); setError(''); setToolStatus([]); setLoadingMessages(false);
    let id = activeConversationId.current, assistantId = `pending-${Date.now()}`;
    const controller = new AbortController(); abort.current = controller;
    try {
      if (!id) {
        const result = await executeAccountOperation(accountScope.current, token, async () => {
          const conversation = entity<Conversation>(await post('/conversations', { title: content.slice(0, 45), mode, ...(mode === 'companion' ? { persona: personas.find((entry) => entry.id === persona)?.prompt } : {}) }), 'conversation');
          if (!conversation?.id) throw new Error('服务没有返回会话记录。'); return conversation;
        }, { apply(conversation) { accountScope.current.invalidate('private-refresh'); selectConversation(conversation.id); setConversations((prior) => [conversation, ...prior.filter((entry) => entry.id !== conversation.id)]); } });
        id = requireAccountResult(result).id;
      }
      if (!accountScope.current.isCurrent(token)) return;
      setDraft(''); setDraftNotice(''); setUploads([]);
      setMessages((prior) => [...prior, { id: `sending-${Date.now()}`, role: 'user', content, attachments: localUploads }, { id: assistantId, role: 'assistant', content: '' }]);
      await streamMessage(id, { content, mode, provider: providerId, ...(model ? { model } : {}), attachmentIds: localUploads.map((upload) => upload.id), ...(mode === 'companion' ? { persona: activeConversation?.persona || personas.find((entry) => entry.id === persona)?.prompt } : {}) }, controller.signal, ({ event: eventName, data }) => {
        if (!accountScope.current.isCurrent(token)) return;
        if (eventName === 'start' && data.messageId) { const old = assistantId; assistantId = data.messageId; setMessages((prior) => prior.map((message) => message.id === old ? { ...message, id: assistantId } : message)); }
        if (eventName === 'delta' && typeof data.text === 'string') setMessages((prior) => prior.map((message) => message.id === assistantId ? { ...message, content: message.content + data.text } : message));
        if (eventName === 'tool') { setToolStatus((prior) => upsertAgentToolStatus(prior, data)); if (['create_job', 'prepare_browser_task', 'prepare_mcp_task'].includes(data.name) && Object.hasOwn(data, 'result')) setConversationTaskRefresh((value) => value + 1); }
        if (eventName === 'approval' && data.id) { accountScope.current.invalidate('private-refresh'); setApprovals((prior) => [data, ...prior.filter((entry) => entry.id !== data.id)]); setToolStatus((prior) => appendAgentApprovalStatus(prior, data)); setConversationTaskRefresh((value) => value + 1); }
        if (eventName === 'done' && data.message) setMessages((prior) => prior.map((message) => message.id === assistantId ? { ...message, ...data.message } : message));
        if (eventName === 'error') throw new Error(data.message || data.error?.message || '模型调用失败。');
      });
    } catch (failure) {
      if (accountScope.current.isCurrent(token)) {
        if (failure instanceof DOMException && failure.name === 'AbortError') setError('已停止接收响应。服务端是否完成执行，请查看已保存的会话和任务状态。');
        else accountError(token, failure);
      }
    } finally {
      if (accountScope.current.isCurrent(token)) {
        setStreaming(false); setToolStatus((prior) => finishAgentToolStatuses(prior)); setConversationTaskRefresh((value) => value + 1); if (abort.current === controller) abort.current = null;
        if (id) await executeAccountOperation(accountScope.current, token, () => request(`/conversations/${encodeURIComponent(id!)}`), { apply: (data) => setMessages(collection<Message>(data, 'messages')), onError: (failure) => { if (failure instanceof ApiError && failure.status === 401) accountError(token, failure); } });
        if (accountScope.current.isCurrent(token)) void refreshUserData();
      }
    }
  }
  function rememberJobResult({ job, approval }: { job: Job; approval?: Approval }) {
    accountScope.current.invalidate('private-refresh');
    setJobs((prior) => [job, ...prior.filter((entry) => entry.id !== job.id)]);
    if (approval?.id) setApprovals((prior) => [approval, ...prior.filter((entry) => entry.id !== approval.id)]);
  }
  function preparedMcp(result: { job: Job; approval: Approval }) {
    if (!accountScope.current.isCurrent(renderSession) || !accountClient?.isCurrent()) throw new StaleAccountOperation();
    rememberJobResult(result);
  }
  async function createJob(body: { kind: JobKind; provider: string; prompt: string; model?: string; options?: Record<string, unknown>; attachmentIds?: string[] }) {
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, async () => {
      const response = await post<{ job: Job; approval?: Approval }>('/jobs', body), job = entity<Job>(response, 'job');
      if (!job?.id) throw new Error('服务没有返回任务记录。'); return { job, approval: response.approval };
    }, {
      apply: rememberJobResult,
      onError: (failure) => accountError(token, failure),
    });
    requireAccountResult(result);
  }
  async function jobAction(job: Job, action: 'cancel' | 'retry') {
    if (!user || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken();
    await executeAccountOperation(accountScope.current, token, () => post(`/jobs/${encodeURIComponent(job.id)}/${action}`), { apply() { accountScope.current.invalidate('private-refresh'); void refreshUserData(); }, onError: (failure) => accountError(token, failure) });
  }
  const cancelJob = (job: Job) => jobAction(job, 'cancel');
  const retryJob = (job: Job) => jobAction(job, 'retry');
  async function saveMemory(content: string) {
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, async () => { const memory = entity<Memory>(await post('/memories', { content }), 'memory'); if (!memory?.id) throw new Error('服务没有返回记忆记录。'); return memory; }, {
      apply(memory) { accountScope.current.invalidate('private-refresh'); setMemories((prior) => [memory, ...prior.filter((entry) => entry.id !== memory.id)]); }, onError: (failure) => accountError(token, failure),
    }); requireAccountResult(result);
  }
  async function deleteMemory(id: string) {
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, () => remove(`/memories/${encodeURIComponent(id)}`), { apply() { accountScope.current.invalidate('private-refresh'); setMemories((prior) => prior.filter((memory) => memory.id !== id)); }, onError: (failure) => accountError(token, failure) });
    requireAccountResult(result);
  }
  async function saveMemoryDraft() {
    if (memoryDraft === null || savingMemory || !accountScope.current.isCurrent(renderSession)) return;
    const token = privateToken('memory-dialog'); setSavingMemory(true);
    await executeAccountOperation(accountScope.current, token, () => saveMemory(memoryDraft.trim()), { apply: () => setMemoryDraft(null), onError: (failure) => accountError(token, failure), finally: () => setSavingMemory(false) });
  }
  async function decision(approval: Approval, value: 'approve' | 'reject', expectedConversationId?: string) {
    if (!user || !accountScope.current.isCurrent(renderSession)) return;
    if (expectedConversationId && activeConversationId.current !== expectedConversationId) throw new StaleAccountOperation();
    const token = privateToken();
    const result = await executeAccountOperation(accountScope.current, token, () => post(`/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: value === 'approve' ? 'approved' : 'rejected' }), {
      apply() { if (expectedConversationId && activeConversationId.current !== expectedConversationId) return; accountScope.current.invalidate('private-refresh'); setConversationTaskRefresh((value) => value + 1); void refreshUserData(); },
      onError: (failure) => { if (!expectedConversationId || activeConversationId.current === expectedConversationId) accountError(token, failure); },
    });
    if (expectedConversationId && activeConversationId.current !== expectedConversationId) throw new StaleAccountOperation();
    requireAccountResult(result);
  }
  async function logout() {
    if (!user || !accountScope.current.isCurrent(renderSession)) return;
    const cleanupClient = accountClient; if (!cleanupClient) return;
    switchAuthentication(null); setInitializing(true);
    const token = accountScope.current.begin('logout', false)!;
    try {
      await cleanupClient.cleanup('/auth/logout', { method: 'POST', body: '{}' });
      // A completed logout changes the shared cookie even if this page's state changed meanwhile.
      if (!accountScope.current.isCurrent(token)) platformAccountContext.invalidate('local-auth-change');
      notifySessionChanged();
    } catch (failure) {
      if (accountScope.current.isCurrent(token)) { setAuthOptions(null); setConnectionUnavailable(true); setAuthNotice('退出登录未能确认。请重新检查账号状态。'); }
    } finally { if (accountScope.current.isCurrent(token)) setInitializing(false); }
  }
  async function copyMessage(message: Message) {
    if (!accountScope.current.isCurrent(renderSession)) return;
    await executeAccountOperation(accountScope.current, privateToken(), () => navigator.clipboard.writeText(message.content), { onError: () => setError('浏览器无法复制内容，请手动选取文本。') });
  }
  const suggested = view === 'companion' ? [
    { icon: Leaf, title: '先聊聊我最近的状态', text: '我最近有点不知道该从哪里开始。请先听我说，帮我一起理清。' },
    { icon: MessageCircle, title: '陪我练习一次交流', text: '我想练习向一个不熟悉的从业者请教。先帮我设定场景，再和我演练。' },
    { icon: Compass, title: '找到一个小小的下一步', text: '我有一个一直没有开始的目标。帮我把它拆成今天能做的一小步。' },
  ] : [
    { icon: Compass, title: '一起研究一个问题', text: '我有一个想深入了解的问题。请先帮我界定问题，再制定研究步骤。' },
    { icon: Feather, title: '把灵感变成一个计划', text: '我想把一个模糊的想法做成作品。和我一起梳理目标、受众和第一步。' },
    { icon: Sparkles, title: '探索新的创作可能', text: '帮我为一个主题构思几种文字、图片、视频和语音的组合形式。' },
  ];

  if (initializing || connectionUnavailable || !authOptions || user && (!accountClient?.isCurrent() || accountClient.account.accountId !== user.id)) return <PublicConnectionView online={online} connecting={initializing} notice={authNotice || undefined} onRetry={() => void connectWorkspace(true)} />;
  if (accountAction && (accountAction.kind !== 'verify-email' || user)) return <PlatformAccountClientProvider value={accountClient}><AccountActionView key={`${accountScope.current.revision}-${accountAction.kind}`} action={accountAction} user={user} options={authOptions} onVerified={verifiedAccount} onReset={resetCompleted} onBack={leaveAccountAction} onDiscardToken={() => setAccountAction({ kind: 'invalid', purpose: accountAction.kind === 'invalid' ? accountAction.purpose : accountAction.kind })} onLogout={() => void logout()}  /></PlatformAccountClientProvider>;
  if (!user) return <AuthView key={`auth-${accountScope.current.revision}`} onUser={(next) => { if (accountScope.current.isCurrent(renderSession)) { switchAuthentication(next); } }} serverError={error || state.error} options={authOptions} initialLogin={forceLogin || accountAction?.kind === 'verify-email'} onCancelAction={accountAction?.kind === 'verify-email' ? leaveAccountAction : undefined} notice={accountAction?.kind === 'verify-email' ? '请先登录收到验证邮件的账号。登录后还需手动点击完成验证。' : authNotice} />;
  if (!privateAllowed) return <PlatformAccountClientProvider value={accountClient}><AccountGate key={accountScope.current.revision} user={user} options={authOptions} onVerified={verifiedAccount} onLogout={() => void logout()} serverError={error}  /></PlatformAccountClientProvider>;
  const { draft: voiceDraft, error: voiceDraftError } = openVoiceDraft(voiceDrafts.current, activeId, view === 'voice');
  return <PlatformAccountClientProvider key={`${requestAccount.accountId}-${requestAccount.generation}`} value={accountClient}><div className="workspace"><button className={`drawer-scrim ${drawer || rightDrawer ? 'visible' : ''}`} aria-label="关闭面板" onClick={() => { setDrawer(false); setRightDrawer(false); }} /><aside className={`sidebar ${drawer ? 'mobile-open' : ''}`}><div className="sidebar-brand"><Brand /><button className="icon-button mobile-only" aria-label="关闭侧栏" onClick={() => setDrawer(false)}><X size={19} /></button></div><button className="new-chat" onClick={newConversation} disabled={streaming}><Plus size={17} />开启新会话<span>⌘ K</span></button><div className="sidebar-label">YOUR SPACE</div><nav>{navigation.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'selected' : ''}`} onClick={() => chooseView(item.id)} disabled={streaming}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>{view === item.id && <span className="nav-selected-dot" />}</button>)}</nav><div className="sidebar-section-title"><span>最近的会话</span><MessageCircle size={13} /></div><div className="conversation-list">{conversations.length ? conversations.map((conversation) => <div className={`conversation-item ${activeId === conversation.id && showChat ? 'selected' : ''}`} key={conversation.id}><button onClick={() => loadConversation(conversation)} disabled={streaming}><span>{conversation.mode === 'companion' ? <Leaf size={13} /> : <MessageCircle size={13} />}</span>{conversation.title || '新会话'}</button><button className="conversation-delete" aria-label={`删除会话 ${conversation.title}`} disabled={streaming} onClick={() => deleteConversation(conversation)}><Trash2 size={12} /></button></div>) : <p className="sidebar-empty">好想法，从第一句开始。</p>}</div><div className="sidebar-bottom"><div className="workspace-hint"><div><span className="small-leaf" />MAKE ROOM FOR POSSIBILITY</div><p>从思考到行动，<br />留一点空间给新的可能。</p></div><button className={`nav-item ${view === 'settings' ? 'selected' : ''}`} onClick={() => chooseView('settings')} disabled={streaming}><Settings2 size={17} /><span>工作台设置</span><ChevronRight size={14} /></button><div className="user-card"><button onClick={() => chooseView('settings')} disabled={streaming}><span className="avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</span><span><strong>{user.name || '我的工作台'}</strong><small>Personal workspace</small></span></button><button className="icon-button" aria-label="退出登录" onClick={logout} disabled={streaming}><LogOut size={15} /></button></div></div></aside><div className="main-shell"><header className="topbar"><div><button className="icon-button mobile-only" aria-label="打开导航" onClick={() => setDrawer(true)}><Menu size={20} /></button><span className="breadcrumb">我的工作台</span><ChevronRight size={13} /><strong>{title}</strong></div><div><span className={`service-status ${!online || state.error ? 'offline' : ''}`}><span className={`connection-dot ${online && !state.error ? 'online' : ''}`} />{!online ? '当前离线' : state.error ? '服务未连接' : '工作台已连接'}</span><button className="icon-button" title="任务与能力" aria-label="打开任务与能力面板" onClick={() => window.matchMedia('(min-width: 1240px)').matches ? setContextOpen(!contextOpen) : setRightDrawer(!rightDrawer)}><ClipboardCheck size={18} />{pendingApprovals.length > 0 && <span className="notification-dot" />}</button></div></header>{error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭提示" className="icon-button" onClick={() => setError('')}><X size={15} /></button></div>}<div className={`main-columns ${contextOpen ? '' : 'context-hidden'}`}><main className={`main-content ${showChat ? 'chat-main' : ''}`}>{showChat ? <><div className="chat-topline"><div className="chat-context"><span className="mini-mark">of</span><span>{activeConversation?.title || (view === 'companion' ? '陪伴与练习' : '新的可能')}<small>{mode === 'agent' ? 'Agent 可以使用服务端授权的工具' : view === 'companion' ? '你的节奏，你的下一步' : 'THINK · CREATE · DO'}</small></span></div><div className="chat-top-actions">{view === 'chat' && <button className={`agent-toggle ${agent ? 'active' : ''}`} onClick={() => { if (activeId && messages.length) { setError('请开启一个新会话来选择 Agent 模式，保持已有会话的执行记录一致。'); return; } setAgent(!agent); }} disabled={streaming}><Sparkles size={13} />Agent<span className="toggle-knob" /></button>}<ProviderSelect providers={state.providers} value={providerId} onChange={(id) => { setProviderId(id); setModel(providerModels(state.providers.find((entry) => entry.id === id), mode)[0] || ''); }} capability={mode} disabled={streaming} /></div></div>{view === 'companion' && <div className="persona-bar"><span><Leaf size={14} />今天的伙伴</span><select aria-label="陪伴风格" value={persona} onChange={(event) => setPersona(event.target.value)} disabled={streaming || !!messages.length}>{personas.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select><small>{personas.find((entry) => entry.id === persona)?.description}</small></div>}<div className="chat-scroll">{loadingMessages ? <div className="loading-content"><Loader2 size={19} className="spin" />加载会话中…</div> : messages.length || voiceRecords.length ? <div className="messages">{messages.map((message) => <article className={`message ${message.role}`} key={message.id} id={`message-${message.id}`} tabIndex={-1}><div className="message-avatar">{message.role === 'user' ? (user.name || user.email).slice(0, 1).toUpperCase() : message.role === 'assistant' ? <span>of</span> : <TerminalSquare size={15} />}</div><div className="message-body"><div className="message-label">{message.role === 'user' ? user.name || '你' : message.role === 'assistant' ? 'Openfield' : '工具'}{message.role === 'assistant' && <span>YOUR THINKING PARTNER</span>}</div>{message.content ? <div className="markdown">{message.role === 'user' ? <p>{message.content}</p> : <ChatMarkdown>{message.content}</ChatMarkdown>}</div> : streaming ? <div className="thinking"><span /><span /><span />正在思考…</div> : <p className="helper-text">没有返回文本。请查看任务状态或错误提示。</p>}{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => <PrivateFileLink key={attachment.id} url={attachment.url}><Paperclip size={12} />{attachment.name}</PrivateFileLink>)}</div> : null}{message.role === 'assistant' && message.content && <div className="message-actions"><button aria-label="复制回复" onClick={() => copyMessage(message)}><Copy size={13} /></button><button onClick={() => setMemoryDraft(message.content)}><Leaf size={13} />选择内容存为记忆</button></div>}</div></article>)}{toolStatus.length > 0 && <div className="tool-timeline">{toolStatus.map((status) => <span key={status.key}><Circle size={10} />{agentToolStatusText(status)}</span>)}</div>}<VoiceRecords records={voiceRecords} onBringToChat={bringVoiceToChat} compact /></div> : <div className="chat-welcome"><div className="welcome-decoration"><span className="deco-line" /><span className="welcome-flower"><Sparkles size={26} strokeWidth={1.2} /></span><span className="deco-line" /></div><div className="eyebrow">A FRESH PAGE, A NEW POSSIBILITY</div><h1>{view === 'companion' ? <>不必想好，<br /><span>我们慢慢聊。</span></> : <>{user.name ? `${user.name}，` : ''}今天，<br /><span>想探索什么？</span></>}</h1><p>{view === 'companion' ? '说说你的近况，练习一次交流，或一起找到下一步。' : '从一句话开始。一起思考、创造，做成点什么。'}</p><div className="suggestion-grid">{suggested.map((suggestion) => <button key={suggestion.title} onClick={() => { setDraft(suggestion.text); composer.current?.focus(); }}><suggestion.icon size={21} strokeWidth={1.4} /><strong>{suggestion.title}</strong><span>{view === 'companion' ? '一起慢慢开始' : '给想法一点空间'}<ArrowRight size={14} /></span></button>)}</div><div className="welcome-footnote"><span className="connection-dot" />{isProviderReady(chosenProvider, mode) ? '模型已配置，首次调用确认可用性。' : '先在设置中配置模型，也可以先创建会话、上传资料。'}</div></div>}<div ref={messagesEnd} />{activeId && !loadingMessages && <ConversationTasksPanel key={`conversation-tasks-${requestAccount.accountId}-${requestAccount.generation}-${activeId}`} conversationId={activeId} mode={mode} providers={state.providers} refreshVersion={conversationTaskRefresh} handoffDisabled={streaming} onDecision={(approval, value) => decision(approval, value, activeId)} onBringToDraft={bringConversationTaskToDraft} onLocateReply={locateConversationTaskReply} />}</div><div className="composer-wrap">{draftNotice && <div className="agent-handoff-notice" role="status"><span>{draftNotice}</span><button className="icon-button" type="button" aria-label="关闭成果草稿提示" onClick={() => setDraftNotice('')}><X size={14} /></button></div>}<form className="chat-composer" onSubmit={send}>{uploads.length > 0 && <div className="attachments">{uploads.map((upload) => <span className="attachment-chip" key={upload.id}><Paperclip size={12} />{upload.name}<button type="button" aria-label={`移除 ${upload.name}`} onClick={() => setUploads((prior) => prior.filter((entry) => entry.id !== upload.id))}><X size={12} /></button></span>)}</div>}<textarea aria-label="消息" ref={composer} value={draft} onChange={(event) => { setDraft(event.target.value); setDraftNotice(''); }} placeholder={view === 'companion' ? '想从哪里说起？' : '写下一个问题、想法，或你想做的事…'} rows={2} maxLength={20000} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} disabled={streaming} /><div className="composer-footer"><div><input hidden ref={file} type="file" multiple onChange={(event) => attach(event.target.files)} /><button className="icon-button" type="button" aria-label="上传文件" title="上传文件" disabled={streaming || uploading} onClick={() => file.current?.click()}><Paperclip size={18} /></button><button className="icon-button" type="button" aria-label="进入语音交流" title="语音交流" onClick={() => chooseView('voice')} disabled={streaming}><AudioLines size={18} /></button><span className="composer-divider" /><label className="composer-model"><span>模型</span><input aria-label="对话模型" value={model} onChange={(event) => setModel(event.target.value)} placeholder="服务端默认" list="chat-models" disabled={streaming} /><datalist id="chat-models">{providerModels(chosenProvider, mode).map((entry) => <option key={entry} value={entry} />)}</datalist></label></div>{streaming ? <button className="send-button stop" type="button" aria-label="停止接收回复" onClick={() => abort.current?.abort()}><CircleStop size={20} /></button> : <button className="send-button" type="submit" aria-label="发送消息" disabled={!draft.trim() || uploading}>{uploading ? <Loader2 size={19} className="spin" /> : <ArrowUp size={20} />}</button>}</div></form><div className="composer-note"><span>{uploading ? '文件正在上传…' : mode === 'agent' ? '工具操作会按服务端策略请求批准。' : 'AI 的判断也需要你的思考。'}</span><span>Enter 发送 · Shift Enter 换行</span></div></div></> : view === 'voice' ? voiceDraft ? <VoicePanel key={voiceDraft.id} draft={voiceDraft} providers={state.providers} conversation={activeConversation} records={voiceRecords} onEnsureConversation={() => ensureVoiceConversation(voiceDraft)} onSaveRecord={saveVoiceRecord} onBringToChat={bringVoiceToChat} onOpenConversation={openVoiceConversation} onConversationChanged={refreshVoiceConversation} onError={reportPanelError} /> : <section className="feature-page voice-page"><h1>语音草稿</h1><p role="alert">{voiceDraftError}</p></section> : view === 'settings' ? <SettingsPanel onOpenTools={() => chooseView('mcp')} user={user} accountVerification={<EmailVerificationControls user={user} options={authOptions} onVerified={verifiedAccount} />} state={state} memories={memories} onSaveMemory={saveMemory} onDeleteMemory={deleteMemory} onRefresh={refreshCapabilities} onError={reportPanelError} /> : view === 'knowledge' ? <KnowledgePanel key={`knowledge-${user.id}-${renderSession.generation}`} accountId={user.id} onBringToAgent={bringToAgent} handoffDisabled={streaming} onError={(failure) => accountError(renderSession, failure)} /> : view === 'mcp' ? <McpToolPanel jobs={jobs} onPrepared={preparedMcp} onCancel={cancelJob} onRetry={retryJob} onBringToAgent={bringMcpToAgent} handoffDisabled={streaming} onOpenApprovals={() => { setContextOpen(true); if (!window.matchMedia('(min-width: 1240px)').matches) setRightDrawer(true); }} /> : view === 'workflow' ? <WorkflowPanel key={`workflow-${user.id}`} onRefreshCapabilities={() => refreshCapabilities(true)} providers={state.providers} jobs={jobs} onCreate={createJob} onBringArtifactToAgent={bringArtifactToAgent} handoffDisabled={streaming} onCancel={cancelJob} onRetry={retryJob} onError={reportPanelError} /> : view === 'browser' ? <BrowserPanel providers={state.providers} jobs={jobs} onCreate={createJob} onCancel={cancelJob} onRetry={retryJob} onBringToAgent={bringBrowserToAgent} onError={reportPanelError} /> : view === 'create' ? <CreativePanel onRefreshCapabilities={() => refreshCapabilities(true)} key={`create-${user.id}`} accountId={user.id} providers={state.providers} jobs={jobs} onCreate={createJob} onBringArtifactToAgent={bringArtifactToAgent} handoffDisabled={streaming} onCancel={cancelJob} onRetry={retryJob} onUpload={uploadFile} onError={reportPanelError} /> : <TaskPanel key={view} view={view} providers={state.providers} jobs={jobs} onCreate={createJob} onBringArtifactToAgent={bringArtifactToAgent} handoffDisabled={streaming} onCancel={cancelJob} onRetry={retryJob} onUpload={uploadFile} onError={reportPanelError} />}</main><aside className={`context-panel ${rightDrawer ? 'mobile-open' : ''}`}><div className="context-title"><span>在这里，继续向前</span><button className="icon-button" aria-label="关闭任务面板" onClick={() => { setRightDrawer(false); setContextOpen(false); }}><PanelRightClose size={15} /></button></div><div className="context-section"><div className="context-section-title"><h3><ClipboardCheck size={15} />进行中的任务</h3><span>{activeJobs.length}</span></div>{activeJobs.length ? <div className="small-jobs">{activeJobs.map((job) => <button key={job.id} onClick={() => { chooseView(['image', 'video', 'speech'].includes(job.kind) ? job.kind === 'speech' ? 'voice' : 'create' : job.kind as View); }}><span className="task-status-icon"><Loader2 size={15} className="spin" /></span><span><strong>{job.prompt.slice(0, 52)}</strong><small>{jobLabel(job.kind)} · {statusLabel(job.status)}</small></span><ChevronRight size={13} /></button>)}</div> : <div className="quiet-state"><div className="quiet-lines"><span /><span /><span /></div><p>暂时没有进行中的任务</p><small>灵感来了，随时开始。</small></div>}</div>{pendingApprovals.length > 0 && <div className="context-section approvals-section"><div className="context-section-title"><h3><ShieldCheck size={15} />需要你的决定</h3><Badge tone="amber">{pendingApprovals.length}</Badge></div>{pendingApprovals.map((approval) => <ApprovalDetails key={approval.id} approval={approval} providers={state.providers} onDecision={decision} />)}</div>}<div className="context-section"><div className="context-section-title"><h3><Sparkles size={15} />能力配置</h3><button className="text-button" onClick={() => chooseView('settings')}>管理<ChevronRight size={12} /></button></div><div className="capability-overview">{[{ id: 'chat', label: '思考与对话', icon: MessageCircle }, { id: 'realtime', label: '实时语音', icon: AudioLines }, { id: 'image', label: '图片创作', icon: Image }, { id: 'video', label: '视频创作', icon: Layers3 }, { id: 'browser', label: '浏览器执行', icon: Globe2 }, { id: 'cli', label: '终端执行', icon: TerminalSquare }].map((capability) => { const available = state.providers.some((provider) => isProviderReady(provider, capability.id) && provider.capabilities.some((value) => value === capability.id)); return <div key={capability.id}><capability.icon size={14} /><span>{capability.label}</span><span className={`capability-state ${available ? 'available' : ''}`}>{available ? '已配置' : '待配置'}</span></div>; })}</div></div><div className="context-section memory-preview"><div className="context-section-title"><h3><Leaf size={15} />你选择的记忆</h3><span>{memories.length}</span></div>{memories.length ? <>{memories.slice(0, 2).map((memory) => <p key={memory.id}>{memory.content}</p>)}<button className="text-button" onClick={() => chooseView('settings')}>查看全部<ChevronRight size={12} /></button></> : <p>喜欢的表达方式，正在追求的目标。<br />由你选择，才会记住。</p>}</div><div className="context-bottom"><div className="field-illustration" aria-hidden="true"><span /><span /><span /><span /><span /></div><span>GOOD THINGS TAKE SHAPE.</span><p>留一点空间给可能。</p></div></aside></div></div>{memoryDraft !== null && <div className="modal-scrim" onClick={() => !savingMemory && setMemoryDraft(null)}><section className="memory-modal" role="dialog" aria-modal="true" aria-labelledby="memory-modal-title" onClick={(event) => event.stopPropagation()}><button className="icon-button close-modal" aria-label="关闭记忆编辑" onClick={() => setMemoryDraft(null)} disabled={savingMemory}><X size={18} /></button><div className="empty-icon"><Leaf size={24} /></div><h2 id="memory-modal-title">选择值得记住的内容</h2><p>编辑成你希望后续陪伴对话使用的事实或偏好，再明确保存。</p><textarea aria-label="编辑记忆内容" rows={6} value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={4000} /><button className="primary full" disabled={!memoryDraft.trim() || savingMemory} onClick={saveMemoryDraft}><Leaf size={15} />{savingMemory ? '保存中…' : '明确保存这条记忆'}</button></section></div>}</div></PlatformAccountClientProvider>;
}
