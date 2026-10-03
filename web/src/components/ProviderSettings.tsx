import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Check, Eye, EyeOff, RefreshCw, ChevronDown, ChevronRight, X, Globe, Image, Brain } from 'lucide-react';
import { getProviders, createProvider, updateProvider, deleteProvider, testProviderWebSearch, getWebConfig, saveChatModelConfig, Provider, ProviderModel } from '../api';

// Auto-detect provider info from URL.
// `webSearch: 'native'` means the bridge has a dedicated native search handler for this provider.
// Anthropic-format providers implicitly support web search via the upstream API's server tool.
const KNOWN_PROVIDERS: Array<{
  match: (url: string) => boolean;
  name: string;
  format: 'anthropic' | 'openai';
  color: string;
  letter: string;
  defaultModels?: ProviderModel[];
  webSearch?: 'native';
}> = [
    {
      match: u => /anthropic\.com/i.test(u), name: 'Anthropic', format: 'anthropic', color: '#D97757', letter: 'A',
      webSearch: 'native',
      defaultModels: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }]
    },
    {
      match: u => /openai\.com/i.test(u), name: 'OpenAI', format: 'openai', color: '#10A37F', letter: 'O',
      defaultModels: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o Mini' }, { id: 'o3-mini', name: 'o3-mini' }]
    },
    {
      match: u => /deepseek\.com/i.test(u), name: 'DeepSeek', format: 'openai', color: '#4D6BFE', letter: 'D',
      defaultModels: [{ id: 'deepseek-chat', name: 'DeepSeek V3' }, { id: 'deepseek-reasoner', name: 'DeepSeek R1' }]
    },
    {
      match: u => /bigmodel\.cn/i.test(u), name: 'GLM (Zhipu)', format: 'openai', color: '#3B68FF', letter: 'G',
      webSearch: 'native',
      defaultModels: [{ id: 'glm-5-plus', name: 'GLM-5 Plus' }, { id: 'glm-4-plus', name: 'GLM-4 Plus' }]
    },
    { match: u => /siliconflow/i.test(u), name: 'SiliconFlow', format: 'openai', color: '#7C3AED', letter: 'S' },
    {
      match: u => /minimax/i.test(u), name: 'MiniMax', format: 'openai', color: '#FF6B35', letter: 'M',
      defaultModels: [{ id: 'MiniMax-M1', name: 'MiniMax M1' }]
    },
    {
      match: u => /generativelanguage\.googleapis|gemini/i.test(u), name: 'Google Gemini', format: 'openai', color: '#4285F4', letter: 'G',
      defaultModels: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }]
    },
    {
      match: u => /dashscope\.aliyuncs/i.test(u), name: 'Qwen (Aliyun)', format: 'openai', color: '#FF6A00', letter: 'Q',
      webSearch: 'native',
    },
    {
      match: u => /api-cn\.jiazhuang/i.test(u), name: 'Clawparrot', format: 'anthropic', color: '#C6613F', letter: 'C',
      webSearch: 'native',
      defaultModels: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }]
    },
  ];


function detectProvider(url: string) {
  for (const kp of KNOWN_PROVIDERS) {
    if (kp.match(url)) return kp;
  }
  return null;
}

// Real provider SVG logos
const PROVIDER_LOGOS: Record<string, (size: number) => React.ReactNode> = {
  'Anthropic': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.767l-1.932-5.147H4.836L2.904 20.48H-.863L6.57 3.52zm.846 8.832h4.47L9.65 6.36l-2.236 5.992z" fill="#D97757" /></svg>,
  'OpenAI': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" fill="#10A37F" /></svg>,
  'DeepSeek': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#4D6BFE" /><text x="12" y="16" textAnchor="middle" fill="white" fontSize="12" fontWeight="700" fontFamily="sans-serif">D</text></svg>,
  'GLM (Zhipu)': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#3B68FF" /><text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="11" fontWeight="700" fontFamily="sans-serif">GLM</text></svg>,
  'SiliconFlow': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#7C3AED" /><text x="12" y="16" textAnchor="middle" fill="white" fontSize="12" fontWeight="700" fontFamily="sans-serif">Si</text></svg>,
  'MiniMax': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF6B35" /><text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="sans-serif">MM</text></svg>,
  'Google Gemini': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><path d="M12 24C12 24 24 17.5 24 12S12 0 12 0 0 6.5 0 12s12 12 12 12z" fill="url(#gem)" /><defs><linearGradient id="gem" x1="0" y1="0" x2="24" y2="24"><stop offset="0%" stopColor="#4285F4" /><stop offset="50%" stopColor="#9B72CB" /><stop offset="100%" stopColor="#D96570" /></linearGradient></defs></svg>,
  'Qwen (Aliyun)': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF6A00" /><text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="sans-serif">Qw</text></svg>,
  'Clawparrot': (s) => <svg width={s} height={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#C6613F" /><text x="12" y="16" textAnchor="middle" fill="white" fontSize="12" fontWeight="700" fontFamily="sans-serif">C</text></svg>,
};

const ProviderIcon: React.FC<{ name: string; color: string; letter: string; size?: number }> = ({ name, color, letter, size = 32 }) => {
  const logo = PROVIDER_LOGOS[name];
  if (logo) return <div className="flex-shrink-0">{logo(size)}</div>;
  return (
    <div className="rounded-lg flex items-center justify-center font-bold text-white flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.38 }}>
      {letter}
    </div>
  );
};

const API_BASE = 'http://127.0.0.1:30080/api';

// Chat models: the subset of models shown in the conversation model selector
interface ChatModel { id: string; name: string; providerId: string; providerName: string; thinkingId?: string; tier?: 'opus' | 'sonnet' | 'haiku' | 'extra'; }

const FALLBACK_PROVIDER_NAME = 'Custom provider';

function getProviderDisplayName(name?: string | null): string {
  return typeof name === 'string' && name.trim() ? name.trim() : FALLBACK_PROVIDER_NAME;
}

function normalizeChatModel(input: Partial<ChatModel> | null | undefined): ChatModel | null {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  const providerId = typeof input?.providerId === 'string' ? input.providerId.trim() : '';
  if (!id || !providerId) return null;

  const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id;
  const providerName = getProviderDisplayName(input?.providerName);
  const thinkingId = typeof input?.thinkingId === 'string' && input.thinkingId.trim() ? input.thinkingId.trim() : undefined;
  const tier = input?.tier === 'opus' || input?.tier === 'sonnet' || input?.tier === 'haiku' || input?.tier === 'extra'
    ? input.tier
    : 'extra';

  return {
    id,
    name,
    providerId,
    providerName,
    ...(thinkingId ? { thinkingId } : {}),
    tier,
  };
}

// Composite key that uniquely identifies a model across providers.
// Two providers can expose the same model id (e.g. claude-opus-4-6);
// uid = "providerId:modelId" prevents them from colliding in the UI.
const modelUid = (m: { id: string; providerId: string }) => `${m.providerId}:${m.id}`;

// 【档位不再写死成 Opus/Sonnet/Haiku】那三档是 Anthropic 的模型线名，
// 用户用第三方（NVIDIA / 中转站）时完全对不上 —— 界面上一堆「Opus 档」
// 却一个 Opus 模型都没有，看着莫名其妙。改成中性档位：
/**
 * 设置分组卡片：统一的标题 + 内容样式。
 * 用于把原来平铺的字段按用途分块（连接信息 / 模型行为 / 能力开关 / 模型清单），
 * 避免十几个 label 挤成一长条看不出结构。
 */
function SettingGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-claude-border/60 bg-black/[0.012] dark:bg-white/[0.015] p-4 space-y-3.5">
      <div>
        <div className="text-[13px] font-semibold text-claude-text">{title}</div>
        {hint && <div className="text-[11px] text-claude-textSecondary/70 mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// 主力 / 日常 / 快速，任何供应商的模型都能往里放。
// key 保持 opus/sonnet/haiku 不变（已存的配置不用迁移，只是标签换了）。
const TIER_DEFS: { key: 'opus' | 'sonnet' | 'haiku'; label: string; description: string }[] = [
  { key: 'opus', label: '主力档', description: '能力最强，用于复杂任务' },
  { key: 'sonnet', label: '日常档', description: '均衡，日常使用' },
  { key: 'haiku', label: '快速档', description: '响应最快，简单问题' },
];

function loadChatModels(): ChatModel[] {
  try {
    const raw = JSON.parse(localStorage.getItem('chat_models') || '[]');
    const normalized = (Array.isArray(raw) ? raw : [])
      .map((model) => normalizeChatModel(model))
      .filter((model): model is ChatModel => !!model);

    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
      localStorage.setItem('chat_models', JSON.stringify(normalized));
    }

    return normalized;
  } catch { return []; }
}
function saveChatModels(models: ChatModel[]) {
  localStorage.setItem('chat_models', JSON.stringify(models));
}

/** 双写：本地立即生效（首屏快），服务端持久化（换设备也在）。
 *  不能只写本地 —— 那正是「配置经常不显示」的根因。 */
function persistChatModels(models: ChatModel[]) {
  saveChatModels(models);
  saveChatModelConfig({ chatModels: models.map(m => ({ id: m.id, name: m.name, providerId: m.providerId, providerName: m.providerName, thinkingId: m.thinkingId, tier: m.tier })) })
    .catch(e => console.warn('[config] 保存对话模型失败', e));
}

const SearchableModelSelect = ({
  value,
  onChange,
  options,
  placeholder,
  emptyLabel,
  dashed
}: {
  value: string;
  onChange: (val: string) => void;
  options: { id: string, providerId: string, name: string, providerName: string }[];
  placeholder: string;
  emptyLabel?: string;
  dashed?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const ref = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) {
      document.addEventListener('mousedown', handleClick);
      setSearch(''); // Reset search when opening
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const filteredOptions = options.filter(o =>
    o.id.toLowerCase().includes(search.toLowerCase()) ||
    (o.name || '').toLowerCase().includes(search.toLowerCase()) ||
    o.providerName.toLowerCase().includes(search.toLowerCase())
  );

  const optUid = (o: typeof options[0]) => `${o.providerId}:${o.id}`;
  const selectedOption = options.find(o => optUid(o) === value);

  return (
    <div className="relative w-full" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full ${dashed ? 'px-3 py-2 border-dashed rounded-[10px] text-claude-textSecondary' : 'px-3 py-1.5 rounded-lg text-claude-text'} bg-transparent border ${dashed ? 'border-claude-border/40' : 'border-claude-border/60'} text-[13px] text-left outline-none hover:border-[#387ee0]/40 focus:border-[#387ee0]/60 transition-colors flex items-center justify-between`}
      >
        <span className="truncate">{selectedOption ? `${selectedOption.name} (${selectedOption.providerName})` : placeholder}</span>
        <ChevronDown size={12} className="text-claude-textSecondary flex-shrink-0 ml-2" />
      </button>

      {open && (
        <div className="absolute z-[100] mt-1 w-[360px] max-w-[80vw] bg-[#ffffff] dark:bg-[#202020] border border-claude-border rounded-[10px] shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] overflow-hidden flex flex-col max-h-[380px]">
          <div className="p-2 border-b border-claude-border/50 bg-black/5 dark:bg-white/5">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索模型名称或供应商..."
              className="w-full px-3 py-1.5 bg-claude-input border border-claude-border rounded-[6px] text-[13px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors"
            />
          </div>
          <div className="overflow-y-auto flex-1 p-1 relative">
            {emptyLabel && (
              <button
                onClick={() => { onChange(''); setOpen(false); }}
                className={`w-full text-left px-3 py-2 rounded-[6px] text-[13px] mb-0.5 transition-colors hover:bg-claude-hover ${value === '' ? 'bg-claude-hover text-[#387ee0]' : 'text-claude-textSecondary'}`}
              >
                {emptyLabel}
              </button>
            )}
            {filteredOptions.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-claude-textSecondary">未找到匹配模型</div>}
            {filteredOptions.map(o => {
              const uid = optUid(o);
              const selected = value === uid;
              return (
              <button
                key={uid}
                onClick={() => { onChange(uid); setOpen(false); }}
                className={`w-full text-left px-3 py-2 rounded-[6px] text-[13px] mb-0.5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] flex flex-col gap-0.5 ${selected ? 'bg-[#387ee0]/10 text-[#387ee0]' : 'text-claude-text'}`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className={`font-semibold truncate pr-2 ${selected ? 'text-[#387ee0]' : 'text-claude-text'}`}>{o.name}</span>
                  {selected && <Check size={14} className="flex-shrink-0 text-[#387ee0]" />}
                </div>
                <div className={`text-[11px] truncate ${selected ? 'text-[#387ee0]/70' : 'text-claude-textSecondary/60'}`}>
                  {o.providerName} &bull; <span className="font-mono">{o.id}</span>
                </div>
              </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const ProviderSettings: React.FC = () => {
  const [providerList, setProviderList] = useState<Provider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showKeyMap, setShowKeyMap] = useState<Record<string, boolean>>({});
  // API Key 的本地编辑草稿。undefined = 没在编辑（显示服务端下发的脱敏值）；
  // 有值 = 用户正在输入（显示草稿）。见下面 API 密钥输入框的注释。
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  // Tavily key 的显示/隐藏开关（与供应商 key 的 showKeyMap 分开，两者互不影响）
  const [showTavilyKey, setShowTavilyKey] = useState<Record<string, boolean>>({});
  const [fetchingModels, setFetchingModels] = useState(false);
  // 「获取模型列表」弹窗：拉到的候选模型让用户勾选后再保存，
  // 而不是一股脑全部写入（有些供应商返回上百个模型，含 embedding/tts 等无关项）。
  const [modelPickerFor, setModelPickerFor] = useState<Provider | null>(null);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [modelPicked, setModelPicked] = useState<Set<string>>(new Set());
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const [modelPickerError, setModelPickerError] = useState<string | null>(null);
  const [modelPage, setModelPage] = useState(0);
  const MODELS_PER_PAGE = 10;
  const [defaultModel, setDefaultModel] = useState(localStorage.getItem('default_model') || '');
  const [chatModels, setChatModels] = useState<ChatModel[]>(loadChatModels());
  // 【服务端是配置真值源】原来 chatModels / defaultModel 只存 localStorage：
  // 换设备、清缓存、换浏览器就全丢 —— 用户反馈的「配置经常不显示」「选了不保存」
  // 都是这个原因。挂载时从服务端拉，之后每次改动双写（服务端 + localStorage 兜底首屏）。
  const [configLoaded, setConfigLoaded] = useState(false);

  // Per-provider web-search probe state. Valid values: 'testing' | 'success' | 'failed'.
  // Absence means "never tested" (show as not supported).
  const [webSearchTestState, setWebSearchTestState] = useState<Record<string, 'testing' | 'success' | 'failed'>>({});

  // New provider form
  const [showAdd, setShowAdd] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newKey, setNewKey] = useState('');
  // 用户要求：添加配置时能自己填 ID、名称、选协议，不要全自动猜。
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newFormat, setNewFormat] = useState<'openai' | 'anthropic' | 'responses' | 'auto'>('auto');
  // 【2026-09-19】默认模型输入框。原来向导里根本没这个字段，创建出来的 Provider
  // model 一律是空字符串 —— 用户看到「web 里添加的配置 model 字段都是空着的」。
  const [newModel, setNewModel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [providerActionError, setProviderActionError] = useState<string | null>(null);
  // 兜底识图 Provider（全局配置，存 web-config.json 顶层 visionProviderId）
  const [visionProviderId, setVisionProviderId] = useState('');

  useEffect(() => {
    loadProviders();
    // 兜底识图 Provider 是全局字段，单独拉一次
    getWebConfig().then(cfg => {
      if (cfg && cfg.visionProviderId) setVisionProviderId(cfg.visionProviderId);
    }).catch(() => {});
  }, []);
  useEffect(() => { setProviderActionError(null); }, [selectedId]);

  // 挂载时从服务端同步对话模型配置（服务端优先，localStorage 只是首屏兜底）
  useEffect(() => {
    let cancelled = false;
    getWebConfig().then((cfg: any) => {
      if (cancelled) return;
      if (Array.isArray(cfg?.chatModels) && cfg.chatModels.length) {
        setChatModels(cfg.chatModels);
        saveChatModels(cfg.chatModels);   // 同步回 localStorage 作首屏缓存
      }
      if (cfg?.defaultModelId) {
        setDefaultModel(cfg.defaultModelId);
        localStorage.setItem('default_model', cfg.defaultModelId);
      }
      setConfigLoaded(true);
    }).catch(() => { setConfigLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const loadProviders = async () => {
    try {
      const list = await getProviders();
      setProviderList(list);
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
    } catch (_) { }
  };

  // Run the web-search probe for a provider and reflect the result in UI state.
  // Kicked off automatically after import and also from the manual "Retest" button.
  const handleTestWebSearch = async (id: string) => {
    setWebSearchTestState(prev => ({ ...prev, [id]: 'testing' }));
    try {
      const result = await testProviderWebSearch(id);
      setWebSearchTestState(prev => ({ ...prev, [id]: result.ok ? 'success' : 'failed' }));
      // Bridge has already persisted supportsWebSearch/webSearchStrategy; pull the fresh record.
      const list = await getProviders();
      setProviderList(list);
    } catch (_) {
      setWebSearchTestState(prev => ({ ...prev, [id]: 'failed' }));
    }
  };

  const handleQuickAdd = async () => {
    if (!newUrl.trim() && !newKey.trim()) return;
    const url = newUrl.trim();
    const key = newKey.trim();
    if (!url) {
      setAddError('请输入 API 地址');
      return;
    }
    const detected = detectProvider(url);
    // 用户选的协议优先；选「自动探测」时才用识别结果，最后才兜底 openai
    const format = newFormat !== 'auto' ? newFormat : (detected?.format || 'openai');

    try {
      setAddError(null);

      // 【不要擅自勾选模型】原来这里把 `detected.defaultModels` 全部塞进 models 且
      // enabled:true —— 用户看到的是一堆自己没选过的模型被勾上。
      // 现在留空：模型由用户在「获取模型列表」弹窗里自己挑。
      const p = await createProvider({
        id: newId.trim() || undefined,
        name: newName.trim() || detected?.name || extractDomainName(url),
        baseUrl: url,
        format,
        apiKey: key,
        model: newModel.trim(),
        models: [],
        enabled: true,
        supportsWebSearch: false,
      });
      setProviderList(prev => [...prev, p]);
      setSelectedId(p.id);
      setShowAdd(false);
      setNewUrl('');
      setNewKey('');
      setNewId('');
      setNewName('');
      setNewModel('');
      setNewFormat('auto');

      // Auto-probe: fetch models from /v1/models endpoint for all providers
      if (key) {
        try {
          let endpoint = url.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '').replace(/\/+$/, '');
          if (!endpoint.endsWith('/v1')) endpoint += '/v1';
          const res = await fetch(endpoint + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
          if (res.ok) {
            const data = await res.json();
            const models = (data.data || [])
              .filter((m: any) => m.id && typeof m.id === 'string')
              .map((m: any) => ({ id: m.id, name: m.id, enabled: true }));
            if (models.length > 0) {
              await updateProvider(p.id, { models });
              setProviderList(prev => prev.map(x => x.id === p.id ? { ...x, models } : x));
            }
          }
          // Also try Anthropic format if OpenAI fails
        } catch (_) { }
      }

      // Kick off the web-search capability test automatically after import.
      // Wait a tick so the user sees the provider card before the spinner appears.
      setTimeout(() => { handleTestWebSearch(p.id); }, 300);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : '添加供应商失败');
    }
  };

  // Extract a readable name from domain
  function extractDomainName(url: string): string {
    try {
      const host = new URL(url).hostname;
      const parts = host.split('.');
      // e.g. api.penguinsaichat.dpdns.org → penguinsaichat
      if (parts.length >= 3) return parts[parts.length - 3].charAt(0).toUpperCase() + parts[parts.length - 3].slice(1);
      if (parts.length >= 2) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      return host;
    } catch (_) { return 'Custom'; }
  }

  const handleUpdate = async (id: string, updates: Partial<Provider>) => {
    try {
      setProviderActionError(null);
      const updated = await updateProvider(id, updates);
      // 后端 PATCH 找不到记录时可能返回空体：回落到本地 updates，避免把 undefined 展开成脏状态
      const patch = (updated && typeof updated === 'object') ? updated : updates;
      setProviderList(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : '更新供应商失败');
    }
  };

  /**
   * 文本框专用更新：**本地立即生效，服务端延迟提交**。
   *
   * 【为什么不能直接用 handleUpdate】原来每个 onChange 都直接发 PATCH，
   * 请求回来后又 setProviderList 回填 —— 用户敲得快时，正在输入的字符会被
   * 上一次请求的旧值覆盖，表现就是「退格退不掉 / 打进去的字弹回来」。
   * 现在：输入即刻反映在本地 state（受控 input 永远跟手），
   * 停止输入 600ms 后才落服务端。
   */
  const updateTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const handleTextUpdate = (id: string, updates: Partial<Provider>) => {
    // 1) 本地立即改：不清空 providers 列表回填，输入框保持跟手
    setProviderList(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    // 2) 防抖落盘
    const key = `${id}:${Object.keys(updates).join(',')}`;
    if (updateTimerRef.current[key]) clearTimeout(updateTimerRef.current[key]);
    updateTimerRef.current[key] = setTimeout(async () => {
      delete updateTimerRef.current[key];
      try {
        setProviderActionError(null);
        await updateProvider(id, updates);
      } catch (error) {
        setProviderActionError(error instanceof Error ? error.message : '更新供应商失败');
      }
    }, 600);
  };

  /** 改 ID：立即提交（涉及 key 迁移，不能防抖），成功后刷新选中项 */
  const handleRenameId = async (oldId: string, nextId: string) => {
    const clean = nextId.replace(/[^A-Za-z0-9_-]/g, '');
    if (!clean || clean === oldId) return;
    try {
      setProviderActionError(null);
      const updated = await updateProvider(oldId, { newId: clean } as any);
      const finalId = updated?.id || clean;
      setProviderList(prev => prev.map(p => p.id === oldId ? { ...p, ...updated, id: finalId } : p));
      setSelectedId(finalId);
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : '修改 ID 失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      setProviderActionError(null);
      await deleteProvider(id);
      setProviderList(prev => prev.filter(p => p.id !== id));
      if (selectedId === id) setSelectedId(providerList.find(p => p.id !== id)?.id || null);
    } catch (error) {
      setProviderActionError(error instanceof Error ? error.message : '删除供应商失败');
    }
  };

  // 从 /v1/models 拉取模型清单，拉到后开弹窗让用户勾选（不直接写入配置）
  const handleFetchModels = async (p: Provider) => {
    // 地址与 Key 的校验交给后端：/api/providers 出于安全不会下发 apiKey，
    // 在前端判断 p.apiKey 会把"配了 key 的 Provider"误报成未配置。
    setFetchingModels(true);
    setModelPickerError(null);
    setModelPickerSearch('');
    setModelPickerFor(p);
    setModelCandidates([]);
    try {
      // 走后端代理：浏览器直连第三方 API 基本都会被 CORS 拦掉，
      // 而且这样 API Key 不必出现在前端请求里。
      const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}/fetch-models`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        setModelPickerError(data?.error || `请求失败：HTTP ${res.status}`);
      } else {
        const unique: string[] = Array.isArray(data.models) ? data.models : [];
        if (!unique.length) {
          setModelPickerError('接口返回成功，但没有解析到任何模型');
        } else {
          setModelCandidates(unique);
          // 默认勾选已配置过的模型，方便对照增删
          const existing = new Set<string>((data.configured || (p.models || []).map(m => m.id)) as string[]);
          setModelPicked(new Set(unique.filter(id => existing.has(id))));
        }
      }
    } catch (e: any) {
      setModelPickerError(`请求出错：${e?.message || '网络异常'}`);
    }
    setFetchingModels(false);
  };

  // 把弹窗里勾选的模型写入该 Provider
  const handleConfirmModelPick = async () => {
    const p = modelPickerFor;
    if (!p) return;
    const prevById = new Map((p.models || []).map(m => [m.id, m]));
    const models: ProviderModel[] = [...modelPicked].map(id => {
      const prev = prevById.get(id);
      // 保留原有的显示名与档位设置，新增项用 id 作为名称
      return prev ? { ...prev, enabled: true } : { id, name: id, enabled: true };
    });
    await handleUpdate(p.id, { models });
    await loadProviders();
    setModelPickerFor(null);
    setModelCandidates([]);
    setModelPicked(new Set());
  };

  const selected = providerList.find(p => p.id === selectedId);

  const getProviderMeta = (p: Provider) => {
    const detected = detectProvider(p.baseUrl || '');
    const providerName = getProviderDisplayName(p.name);
    return {
      color: detected?.color || '#6B7280',
      letter: detected?.letter || providerName.charAt(0).toUpperCase(),
    };
  };

  // All models across all providers (for the "add to chat" dropdown)
  const allAvailableModels: ChatModel[] = [];
  // 【同一模型名只保留一条】同一个模型挂在多个 Provider 上是常见的
  // （实测 deepseek-v4.1-flash 同时在 Provider 6 和 hebox），
  // 不去重的话「其他模型 / 添加模型」的下拉里会并排两条一模一样的名字 ——
  // 用户看到的就是「模型列表显示两个一样的名字」。
  // 保留策略：主字段 model 匹配的那个 Provider 优先（那才是用户当前在用的），
  // 否则用先遍历到的那个。
  const seenModelIds = new Set<string>();
  for (const p of providerList) {
    if (!p.enabled) continue;
    const providerName = getProviderDisplayName(p.name);
    for (const m of (p.models || [])) {
      if (m.enabled === false) continue;
      const modelId = typeof m.id === 'string' ? m.id.trim() : '';
      if (!modelId) continue;
      if (seenModelIds.has(modelId)) continue;
      seenModelIds.add(modelId);
      allAvailableModels.push({
        id: modelId,
        name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : modelId,
        providerId: p.id,
        providerName,
      });
    }
  }

  // Detect thinking variant for a model ID across all providers
  const detectThinkingId = (modelId: string): string | undefined => {
    for (const p of providerList) {
      if ((p.models || []).some(pm => pm.id === modelId + '-thinking')) {
        return modelId + '-thinking';
      }
    }
    return undefined;
  };

  const handleSetTierModel = (tier: 'opus' | 'sonnet' | 'haiku', uid: string) => {
    // Remove any existing model in this tier
    let updated = chatModels.filter(cm => cm.tier !== tier);
    if (uid) {
      const src = allAvailableModels.find(m => modelUid(m) === uid);
      if (src) {
        const thinkingId = detectThinkingId(src.id);
        updated = [...updated, { ...src, tier, thinkingId }];
      }
    }
    setChatModels(updated);
    persistChatModels(updated);
    // Auto-set default to first tier model
    if (!updated.some(cm => cm.id === defaultModel)) {
      const first = updated.find(cm => cm.tier === 'opus') || updated[0];
      if (first) { setDefaultModel(first.id); localStorage.setItem('default_model', first.id); }
    }
  };

  const handleAddExtraModel = (m: ChatModel) => {
    if (chatModels.some(cm => modelUid(cm) === modelUid(m))) return;
    const thinkingId = detectThinkingId(m.id);
    const updated = [...chatModels, { ...m, tier: 'extra' as const, thinkingId }];
    setChatModels(updated);
    persistChatModels(updated);
  };

  const handleRemoveChatModel = (uid: string) => {
    const removed = chatModels.find(cm => modelUid(cm) === uid);
    const updated = chatModels.filter(cm => modelUid(cm) !== uid);
    setChatModels(updated);
    persistChatModels(updated);
    if (removed && defaultModel === removed.id) {
      const newDefault = updated[0]?.id || '';
      setDefaultModel(newDefault);
      localStorage.setItem('default_model', newDefault);
    }
  };

  const handleSetDefault = (id: string) => {
    setDefaultModel(id);
    localStorage.setItem('default_model', id);
    // 双写服务端：localStorage 只是个首屏缓存，真值以服务端为准
    saveChatModelConfig({ defaultModelId: id }).catch(e => console.warn('[config] 保存默认模型失败', e));
  };

  return (
    <div>
      {/* ===== 对话模型区块已删除（2026-09-19 用户要求）=====
          原来这里是为 Opus/Sonnet/Haiku 三档分配模型的界面。用户只用第三方
          Provider，档位概念没有意义，且该区块占了大半屏。模型选择改在对话
          输入栏的模型下拉里做（那里会列出所有 Provider 的模型）。
          若将来要恢复档位分组，从 git 历史找回这一段。 */}

      <hr className="border-claude-border/40 mb-6" />

      {/* ===== Provider Management ===== */}
      <h3 className="text-[16px] font-semibold text-claude-text mb-4">模型供应商</h3>
      <div className="provider-split flex gap-6 min-h-[400px] animate-fade-in">
        {/* Left: Provider list */}
        <div className="provider-list w-[240px] flex-shrink-0 flex flex-col gap-2">
          {/* 【2026-09-19】原来只有一个孤零零的 `+` 图标，用户看不出是「添加供应商」。
              改成带文字的按钮，语义明确。 */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-claude-textSecondary">供应商</span>
            <button
              onClick={() => { setAddError(null); setShowAdd(true); }}
              className="flex items-center gap-1 px-2 py-1 -mr-1 text-[12px] text-claude-textSecondary hover:text-claude-text transition-colors rounded-md hover:bg-claude-hover"
            >
              <Plus size={13} />
              <span>添加</span>
            </button>
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto">
            {providerList.map(p => {
              const meta = getProviderMeta(p);
              const providerName = getProviderDisplayName(p.name);
              const isActive = selectedId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => { setSelectedId(p.id); setModelPage(0); }}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-[12px] transition-colors text-left border ${isActive ? 'bg-claude-input border-claude-border shadow-sm' : 'border-transparent hover:bg-claude-hover/80'
                    }`}
                >
                  <ProviderIcon name={providerName} color={meta.color} letter={meta.letter} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] truncate ${isActive ? 'text-claude-text font-medium' : 'text-claude-textSecondary'}`}>
                      {providerName}
                    </div>
                    <div className="text-[10px] text-claude-textSecondary/50 flex items-center gap-1.5">
                      <span>{(p.models || []).length} models</span>
                      {webSearchTestState[p.id] === 'testing' ? (
                        <span className="flex items-center gap-1 text-[#387ee0] font-medium" title="正在测试网页搜索能力">
                          <RefreshCw size={9} className="animate-spin" />
                          <span>测试中</span>
                        </span>
                      ) : p.supportsWebSearch ? (
                        <span className="flex items-center gap-0.5 text-[#387ee0]" title="已验证支持网页搜索">
                          <Globe size={9} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {!p.enabled && (
                    <div className="w-1.5 h-1.5 rounded-full bg-claude-textSecondary/30 flex-shrink-0" title="Disabled" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Provider detail */}
        <div className="provider-detail flex-1 overflow-y-auto">
          {/* Quick add dialog */}
          {showAdd && (
            <div className="mb-6 p-5 rounded-[16px] border border-claude-border bg-claude-input shadow-sm">
              <div className="text-[15px] font-medium text-claude-text mb-4">添加模型供应商</div>
              <div className="space-y-3">
                <input
                  type="text"
                  value={newUrl}
                  onChange={e => { setNewUrl(e.target.value); if (addError) setAddError(null); }}
                  placeholder="API 地址（如 https://api.openai.com）"
                  className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2.5 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40"
                  autoFocus
                />
                <input
                  type="text"
                  value={newId}
                  onChange={e => { setNewId(e.target.value.replace(/[^A-Za-z0-9_-]/g, '')); if (addError) setAddError(null); }}
                  placeholder="ID（可选，字母数字，用于命令行引用；留空自动生成）"
                  className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2.5 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40 font-mono"
                />
                <input
                  type="text"
                  value={newName}
                  onChange={e => { setNewName(e.target.value); if (addError) setAddError(null); }}
                  placeholder="显示名称（可选，如 我的中转站）"
                  className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2.5 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40"
                />
                {/* 协议：用户要求能自己选，而不是全靠自动探测 */}
                <div>
                  <div className="text-[12px] text-claude-textSecondary mb-1.5">API 格式</div>
                  <div className="flex gap-2">
                    {([['auto', '自动探测'], ['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic'], ['responses', 'Responses']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setNewFormat(val)}
                        className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all border ${newFormat === val ? 'bg-black/[0.05] dark:bg-white/[0.1] text-claude-text border-claude-textSecondary/50' : 'border-claude-border/40 text-claude-textSecondary hover:text-claude-text hover:border-claude-textSecondary/30'}`}
                      >{label}</button>
                    ))}
                  </div>
                </div>
                <input
                  type="password"
                  value={newKey}
                  onChange={e => { setNewKey(e.target.value); if (addError) setAddError(null); }}
                  placeholder="API Key"
                  className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2.5 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40"
                />
                {/* 默认模型：原来缺这个字段，创建出来的 Provider model 为空 */}
                <input
                  type="text"
                  value={newModel}
                  onChange={e => { setNewModel(e.target.value); if (addError) setAddError(null); }}
                  placeholder="默认模型（可选，如 deepseek-chat；也可稍后从下方列表勾选）"
                  className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2.5 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40 font-mono"
                  onKeyDown={e => { if (e.key === 'Enter') handleQuickAdd(); }}
                />
                {newUrl.trim() && (() => {
                  const det = detectProvider(newUrl.trim());
                  return det ? (
                    <div className="flex items-center gap-2 text-[12px] text-claude-textSecondary">
                      <ProviderIcon name={det.name} color={det.color} letter={det.letter} size={20} />
                      <span>已识别：<strong className="text-claude-text">{det.name}</strong>（{det.format === 'openai' ? 'OpenAI 兼容格式' : 'Anthropic 格式'}）</span>
                    </div>
                  ) : (
                    <div className="text-[12px] text-claude-textSecondary/60">未识别的供应商，添加后将自动探测格式和可用模型</div>
                  );
                })()}
                {addError && (
                  <div className="text-[12px] text-red-400/90">{addError}</div>
                )}
                <div className="flex gap-2 pt-2">
                  <button onClick={handleQuickAdd} className="px-4 py-2 text-[14px] font-medium text-claude-bg bg-claude-text rounded-lg transition-colors hover:opacity-90">
                    添加
                  </button>
                  <button onClick={() => { setShowAdd(false); setNewUrl(''); setNewKey(''); setNewId(''); setNewName(''); setNewFormat('auto'); setAddError(null); }} className="px-4 py-2 text-[14px] font-medium text-claude-text border border-claude-border hover:bg-claude-hover rounded-lg transition-colors">
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Selected provider detail */}
          {selected ? (() => {
            const meta = getProviderMeta(selected);
            const providerName = getProviderDisplayName(selected.name);
            return (
              <div className="flex-1 space-y-4 bg-claude-input border border-claude-border rounded-[16px] p-6 shadow-sm">
                {/**
                 * 【2026-09-19 重新分组】原来十几个字段平铺在一个 space-y-6 里，没有分组
                 * （密钥/地址 → 思考强度 → 识图 → 格式 → 网页搜索 → 搜索key → 识图能力 → 模型列表），
                 * 用户反馈「自定义配置的页面显得很杂乱」。现在按用途切成 4 组，
                 * 每组有标题和说明，视觉上一眼能扫到「连接 / 模型行为 / 能力 / 模型清单」。
                 */}
                {/* Header */}
                <div className="flex items-center gap-3">
                  <ProviderIcon name={providerName} color={meta.color} letter={meta.letter} size={36} />
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={selected.name || ''}
                      onChange={e => handleTextUpdate(selected.id, { name: e.target.value })}
                      placeholder={providerName}
                      className="text-[18px] font-semibold text-claude-text bg-transparent outline-none w-full"
                    />
                    {/* ID 输入框：命令行 /config <ID> 引用的就是它。
                        原来详情页只有显示名，ID 建好就改不了 —— 用户没法自己命名。 */}
                    {/* 【2026-09-19】去掉「改完按 Enter」那行小字：它把 ID 输入框挤到换行，
                        而 Enter 保存是通用习惯，hover 提示里已经写了。 */}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[11px] text-claude-textSecondary/50 flex-shrink-0">ID</span>
                      <input
                        type="text"
                        defaultValue={selected.id}
                        key={selected.id}
                        onBlur={e => handleRenameId(selected.id, e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                          if (e.key === 'Escape') { (e.target as HTMLInputElement).value = selected.id; (e.target as HTMLInputElement).blur(); }
                        }}
                        placeholder="provider-id"
                        className="text-[11px] text-claude-textSecondary bg-transparent outline-none w-[110px] min-w-0 font-mono border-b border-transparent hover:border-claude-border/40 focus:border-[#387ee0]/60 transition-colors"
                        title="命令行 /config <ID> 引用的就是它。改 ID 会同步更新会话与模型配置的引用，改完按 Enter 保存。"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(selected.id)}
                    className="p-1.5 text-claude-textSecondary/30 hover:text-red-400 transition-colors rounded-lg hover:bg-red-400/10"
                    title="Delete provider"
                  >
                    <Trash2 size={15} />
                  </button>
                  <button
                    onClick={() => handleUpdate(selected.id, { enabled: !selected.enabled })}
                    className={`w-10 h-6 rounded-full relative transition-colors ${selected.enabled ? 'bg-[#387ee0]' : 'bg-claude-border'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${selected.enabled ? 'left-5' : 'left-1'}`} />
                  </button>
                </div>
                {providerActionError && (
                  <div className="mt-[-10px] text-[12px] text-red-400/90">{providerActionError}</div>
                )}

                <SettingGroup title="连接信息" hint="这个供应商怎么连、用什么身份">
                {/* API Key */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium">API 密钥</label>
                  <div className="flex items-center gap-2">
                    {/* 【2026-09-20 用户要求：不脱敏，直接显示明文】
                        原话「那其他配置的key也都显示，不要脱敏」。
                        这是自部署 + 本机访问的单用户界面，与 CLI 的 /config list
                        显示明文一致（用户明确说过不介意）。脱敏反而让人困惑 ——
                        「点了眼睛也看不到真 key，那这个按钮是干嘛的」。
                        现在：未编辑时显示真 key；聚焦自动全选，想改直接打字覆盖。 */}
                    <input
                      type={showKeyMap[selected.id] ? 'text' : 'password'}
                      value={keyDraft[selected.id] !== undefined
                        ? keyDraft[selected.id]
                        : ((selected as any).apiKey || (selected as any).apiKeyMasked || '')}
                      onFocus={e => {
                        setKeyDraft(prev => ({ ...prev, [selected.id]: e.currentTarget.value }));
                        requestAnimationFrame(() => e.target.select());
                      }}
                      onChange={e => {
                        setKeyDraft(prev => ({ ...prev, [selected.id]: e.target.value }));
                        handleTextUpdate(selected.id, { apiKey: e.target.value });
                      }}
                      onBlur={() => {
                        // 失焦清掉本地草稿，回到「读服务端值」的状态 ——
                        // 否则 draft 会一直压着服务端值（比如别处改了 key，这里还显示旧的）。
                        // 不提交任何东西：真 key 已经在服务端了，没改动就不该重写。
                        setKeyDraft(prev => {
                          const next = { ...prev };
                          delete next[selected.id];
                          return next;
                        });
                      }}
                      placeholder={(selected as any).hasApiKey ? '已配置' : 'sk-...'}
                      className="flex-1 bg-transparent border border-claude-border rounded-[8px] px-3 py-2 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40 font-mono"
                    />
                    {(selected as any).keyCount > 1 && (
                      <span className="text-[11px] text-claude-textSecondary whitespace-nowrap shrink-0">
                        池 · {(selected as any).keyCount} 个
                      </span>
                    )}
                    <button
                      onClick={() => setShowKeyMap(prev => ({ ...prev, [selected.id]: !prev[selected.id] }))}
                      className="p-2 text-claude-textSecondary hover:text-claude-text transition-colors rounded-lg hover:bg-claude-hover"
                    >
                      {showKeyMap[selected.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                {/* Base URL */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium">API 地址</label>
                  <input
                    type="text"
                    value={(selected as any).baseUrl || selected.url || ''}
                    onChange={e => {
                      const newUrl = e.target.value;
                      const det = detectProvider(newUrl);
                      const patch: Partial<Provider> = { baseUrl: newUrl };
                      if (det && det.format !== selected.format) patch.format = det.format;
                      // URL change invalidates any previous test result — user must retest
                      patch.supportsWebSearch = false;
                      patch.webSearchStrategy = null;
                      patch.webSearchTestedAt = undefined;
                      // 防抖：原来每敲一个字就发 PATCH + 回填，退格会被旧值顶回去
                      handleTextUpdate(selected.id, patch);
                    }}
                    className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40 font-mono"
                  />
                </div>

                </SettingGroup>

                <SettingGroup title="模型行为" hint="这个供应商的默认模型怎么工作">
                {/* 思考强度（每 Provider 独立） */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium flex items-center gap-1.5">
                    <Brain size={12} /> 思考强度
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={(selected as any).thinking?.effort || ''}
                      onChange={e => {
                        const v = e.target.value;
                        if (!v) handleUpdate(selected.id, { thinking: null });
                        else handleUpdate(selected.id, { thinking: { ...((selected as any).thinking || {}), enabled: true, effort: v } });
                      }}
                      className="flex-1 bg-transparent border border-claude-border rounded-[8px] px-3 py-2 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors"
                    >
                      <option value="">继承全局</option>
                      <option value="none">none</option>
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                    {(selected as any).thinking && (
                      <button
                        onClick={() => handleUpdate(selected.id, { thinking: { ...(selected as any).thinking, enabled: !(selected as any).thinking?.enabled } })}
                        className={`flex-shrink-0 px-2.5 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${(selected as any).thinking?.enabled === false ? 'text-red-400 border-red-400/30' : 'text-[#387ee0] border-[#387ee0]/30'}`}
                      >
                        {(selected as any).thinking?.enabled === false ? '已关闭' : '已开启'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Format */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium">API 格式</label>
                  <div className="flex gap-2">
                    {(['openai', 'anthropic'] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => handleUpdate(selected.id, { format: f })}
                        className={`px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-all ${selected.format === f
                          ? 'bg-black/[0.05] dark:bg-white/[0.1] text-claude-text border border-claude-textSecondary/50'
                          : 'border border-claude-border/40 text-claude-textSecondary hover:text-claude-text hover:border-claude-textSecondary/30'
                          }`}
                      >
                        {f === 'openai' ? 'OpenAI 兼容' : 'Anthropic'}
                      </button>
                    ))}
                  </div>
                </div>

                </SettingGroup>

                <SettingGroup title="能力开关" hint="联网搜索与图片识别，决定模型能做什么">
                {/* Web search capability — determined solely by the probe result */}
                {(() => {
                  const state = webSearchTestState[selected.id];
                  const isTesting = state === 'testing';
                  const hasTested = !!selected.webSearchTestedAt;
                  const supported = selected.supportsWebSearch === true;
                  const strategy = selected.webSearchStrategy;
                  const testedAt = selected.webSearchTestedAt ? new Date(selected.webSearchTestedAt).toLocaleString() : null;
                  return (
                    <div>
                      <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium flex items-center gap-1.5">
                        <Globe size={12} /> 网页搜索能力
                      </label>
                      <div className={`rounded-[10px] border p-3 flex items-start gap-3 transition-colors ${
                        isTesting ? 'border-[#387ee0]/40 bg-[#387ee0]/[0.06]' :
                        supported ? 'border-[#387ee0]/40 bg-[#387ee0]/[0.04]' :
                        hasTested ? 'border-claude-border/60 bg-claude-hover/30' :
                        'border-claude-border/60'
                      }`}>
                        <div className="flex-shrink-0 mt-0.5">
                          {isTesting ? (
                            <RefreshCw size={16} className="text-[#387ee0] animate-spin" />
                          ) : supported ? (
                            <Check size={16} className="text-[#387ee0]" strokeWidth={2.5} />
                          ) : hasTested ? (
                            <X size={16} className="text-claude-textSecondary/60" />
                          ) : (
                            <Globe size={16} className="text-claude-textSecondary/50" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-[12.5px] font-medium mb-0.5 ${isTesting || supported ? 'text-claude-text' : 'text-claude-textSecondary'}`}>
                            {isTesting ? '正在测试网页搜索能力...' :
                             supported ? '已验证支持网页搜索' :
                             hasTested ? '此供应商不支持网页搜索' :
                             '尚未测试'}
                          </div>
                          <div className="text-[11px] text-claude-textSecondary/80 leading-relaxed">
                            {isTesting ? '正在向供应商发送一次带 web_search 工具的探测请求（最长 45 秒）' :
                             supported ? (
                               <>
                                 策略：<span className="font-mono text-claude-text">{strategy || '—'}</span>
                                 {testedAt && <span className="ml-2 opacity-60">· {testedAt}</span>}
                               </>
                             ) :
                             hasTested ? (
                               <>
                                 {selected.webSearchTestReason || '探测未返回有效搜索结果'}
                                 <div className="mt-0.5 opacity-70">对话中模型请求的 web_search 工具会被自动剥除，不会虚假搜索</div>
                               </>
                             ) :
                             '新导入的供应商默认不启用网页搜索。点击右侧"测试"按钮验证。'}
                          </div>
                        </div>
                        <button
                          onClick={() => handleTestWebSearch(selected.id)}
                          disabled={isTesting || !selected.apiKey || !selected.baseUrl}
                          className="flex-shrink-0 px-3 py-1.5 text-[11.5px] font-medium rounded-lg border border-claude-border/60 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {isTesting ? '测试中...' : hasTested ? '重新测试' : '测试'}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* 搜索 API Key（Tavily）：Web Agent 的 WebSearch 工具用它。
                    原来服务端 PATCH 支持 tavilyApiKey 字段，但设置页没有输入框 ——
                    用户反馈「搜索 API 还是没有地方填」。 */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium flex items-center gap-1.5">
                    <Globe size={12} /> 搜索 API Key（Tavily）
                  </label>
                  <div className="flex items-center gap-2">
                    {/* 与 API 密钥同样：直接显示明文（用户要求不脱敏）。
                        key 实际来自 .env 的 TAVILY_API_KEY，服务端用 getTavilyKey()
                        取值回显 —— 保证「界面看到的」= 「WebSearch 实际用的」。 */}
                    <input
                      type={showTavilyKey[selected.id] ? 'text' : 'password'}
                      value={keyDraft[`tavily-${selected.id}`] !== undefined
                        ? keyDraft[`tavily-${selected.id}`]
                        : ((selected as any).tavilyApiKey || (selected as any).tavilyApiKeyMasked || '')}
                      onFocus={e => {
                        setKeyDraft(prev => ({ ...prev, [`tavily-${selected.id}`]: e.currentTarget.value }));
                        requestAnimationFrame(() => e.target.select());
                      }}
                      onChange={e => setKeyDraft(prev => ({ ...prev, [`tavily-${selected.id}`]: e.target.value }))}
                      onBlur={e => {
                        const v = e.target.value.trim();
                        setKeyDraft(prev => {
                          const next = { ...prev };
                          delete next[`tavily-${selected.id}`];
                          return next;
                        });
                        if (!v) return;
                        handleUpdate(selected.id, { tavilyApiKey: v } as any);
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      placeholder={(selected as any).hasTavilyKey ? '已配置' : 'tvly-... （留空表示不配）'}
                      className="flex-1 bg-transparent border border-claude-border rounded-[8px] px-3 py-2 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors placeholder:text-claude-textSecondary/40 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTavilyKey(prev => ({ ...prev, [selected.id]: !prev[selected.id] }))}
                      className="p-2 text-claude-textSecondary hover:text-claude-text transition-colors rounded-lg hover:bg-claude-hover"
                      title={showTavilyKey[selected.id] ? '隐藏' : '显示'}
                    >
                      {showTavilyKey[selected.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    {(selected as any).hasTavilyKey && (
                      <button
                        onClick={() => handleUpdate(selected.id, { tavilyApiKey: '' } as any)}
                        className="px-3 py-2 text-[12px] text-claude-textSecondary hover:text-red-400 border border-claude-border rounded-lg transition-colors"
                        title="清除该 key"
                      >清除</button>
                    )}
                  </div>
                  <div className="text-[11px] text-claude-textSecondary/70 mt-1">
                    用于 WebSearch 工具的联网检索（<span className="font-mono">tavily.com</span> 注册，每月 1000 次免费）。
                    留空则回退到供应商自带的搜索能力。
                  </div>
                </div>

                {/* 兜底识图 Provider */}
                <div>
                  <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium flex items-center gap-1.5">
                    <Image size={12} /> 兜底识图 Provider
                  </label>
                  <select
                    value={visionProviderId || '6'}
                    onChange={e => {
                      const v = e.target.value || '';
                      setVisionProviderId(v);
                      updateProvider(selected.id, { visionProviderId: v || null }).catch(err =>
                        setProviderActionError(err instanceof Error ? err.message : '保存兜底识图失败')
                      );
                    }}
                    className="w-full bg-transparent border border-claude-border rounded-[8px] px-3 py-2 text-[14px] text-claude-text outline-none focus:border-[#387ee0]/60 transition-colors"
                  >
                    <option value="">不指定（用配置 6）</option>
                    {providerList.map(p => (
                      <option key={p.id} value={p.id}>{p.id} · {p.name}</option>
                    ))}
                  </select>
                  <div className="text-[11px] text-claude-textSecondary/80 mt-1">当前模型不支持识图时，图片交给这个 Provider 处理。</div>
                </div>

                {/* 识图能力：决定 ViewImage / 图片附件是否直接交给当前 Provider */}
                {(() => {
                  const visionOn = selected.vision === true;
                  return (
                    <div>
                      <label className="text-[12px] text-claude-textSecondary mb-1.5 block font-medium flex items-center gap-1.5">
                        <Image size={12} /> 识图能力
                      </label>
                      <div className={`rounded-[10px] border p-3 flex items-start gap-3 transition-colors ${visionOn ? 'border-[#387ee0]/40 bg-[#387ee0]/[0.04]' : 'border-claude-border/60'}`}>
                        <div className="flex-shrink-0 mt-0.5">
                          {visionOn ? <Check size={16} className="text-[#387ee0]" strokeWidth={2.5} /> : <Image size={16} className="text-claude-textSecondary/50" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-[12.5px] font-medium mb-0.5 ${visionOn ? 'text-claude-text' : 'text-claude-textSecondary'}`}>
                            {visionOn ? '使用当前模型识图' : '使用备用识图通道'}
                          </div>
                          <div className="text-[11px] text-claude-textSecondary/80 leading-relaxed">
                            {visionOn
                              ? '图片附件与 ViewImage 直接发给该 Provider 的模型。模型不支持图片时会自动回退。'
                              : '识图交给备用多模态通道，失败时再降级本地 OCR。模型确认支持视觉时建议开启。'}
                          </div>
                        </div>
                        {/* 【改成文字按钮】原来是个没有任何标签的开关（一眼看不出干嘛的），
                            用户反馈「识图能力不知道怎么关」。现在直接写「开启 / 关闭」。 */}
                        <button
                          onClick={() => handleTextUpdate(selected.id, { vision: !visionOn })}
                          className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors border ${visionOn
                            ? 'bg-[#387ee0] text-white border-transparent hover:opacity-90'
                            : 'border-claude-border text-claude-textSecondary hover:text-claude-text hover:border-claude-textSecondary/40'}`}
                        >
                          {visionOn ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                </SettingGroup>

                <SettingGroup title="模型清单" hint="下拉框里能选到哪些模型（不勾选的不出现）">
                {/* Models */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[12px] text-claude-textSecondary font-medium">模型列表</label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleFetchModels(selected)}
                        disabled={fetchingModels}
                        className="text-[11px] text-claude-textSecondary hover:text-claude-text transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-claude-hover"
                      >
                        <RefreshCw size={11} className={fetchingModels ? 'animate-spin' : ''} />
                        获取模型列表
                      </button>
                      <button
                        onClick={() => {
                          const models = [...(selected.models || []), { id: '', name: '', enabled: true }];
                          handleUpdate(selected.id, { models });
                        }}
                        className="text-[11px] text-claude-textSecondary hover:text-claude-text transition-colors flex items-center gap-1 px-2 py-1 rounded hover:bg-claude-hover"
                      >
                        <Plus size={11} /> 添加
                      </button>
                    </div>
                  </div>
                  <div className="space-y-0.5 pr-2 -mr-2">
                    {(selected.models || []).slice(modelPage * MODELS_PER_PAGE, (modelPage + 1) * MODELS_PER_PAGE).map((m, _pi) => {
                      const mi = modelPage * MODELS_PER_PAGE + _pi; // real index in full array
                      const hasThinking = (selected.models || []).some(x => x.id === m.id + '-thinking') || m.id.endsWith('-thinking');
                      return (
                        <div key={mi} className="flex items-center gap-2 group rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-claude-hover/50">
                          <button
                            onClick={() => {
                              const models = [...(selected.models || [])];
                              models[mi] = { ...models[mi], enabled: models[mi].enabled === false ? true : false };
                              handleUpdate(selected.id, { models });
                            }}
                            className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${m.enabled !== false ? 'bg-claude-text border-claude-text' : 'border-claude-border'
                              }`}
                          >
                            {m.enabled !== false && <Check size={10} className="text-claude-bg" strokeWidth={3} />}
                          </button>
                          <div className="flex-1 min-w-0">
                            {/* 【2026-09-20 用户反馈「模型列表里显示了两个一样的模型，
                                但实际只选了一个」—— 根因就在这里】
                                原来两个 input 是**并排**且都没有标签：
                                  上面是 m.name（显示名），下面是 m.id（模型 id）
                                而 name 为空时 placeholder 用 m.id 兜底，
                                于是两行文字长得一模一样 —— 看着就像同一个模型出现了两次。
                                修法：① 改成上下两行（本来就是两个不同字段，不该并排）
                                      ② 各加一个小标签写明是什么
                                      ③ name 为空时 placeholder 改成语义提示，不再回显 id */}
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-claude-textSecondary/40 shrink-0 w-[42px]">显示名</span>
                              <input
                                type="text"
                                value={m.name || ''}
                                onChange={e => {
                                  const models = [...(selected.models || [])];
                                  models[mi] = { ...models[mi], name: e.target.value };
                                  handleUpdate(selected.id, { models });
                                }}
                                placeholder="留空则显示模型 ID"
                                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-claude-text outline-none py-0.5 placeholder:text-claude-textSecondary/30 truncate"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-claude-textSecondary/40 shrink-0 w-[42px]">模型ID</span>
                              <input
                                type="text"
                                value={m.id}
                                onChange={e => {
                                  const models = [...(selected.models || [])];
                                  models[mi] = { ...models[mi], id: e.target.value };
                                  // 防抖：模型 id 是逐字输入的，直接 PATCH 会打断输入
                                  handleTextUpdate(selected.id, { models });
                                }}
                                placeholder="model-id"
                                className="min-w-0 flex-1 bg-transparent text-[11px] text-claude-textSecondary/50 font-mono outline-none py-0.5 placeholder:text-claude-textSecondary/25 truncate"
                              />
                            </div>
                          </div>
                          {hasThinking && !m.id.endsWith('-thinking') && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 flex-shrink-0" title="支持扩展思考">Thinking</span>
                          )}
                          <button
                            onClick={() => {
                              const models = (selected.models || []).filter((_, i) => i !== mi);
                              handleUpdate(selected.id, { models });
                            }}
                            className="p-0.5 text-claude-textSecondary/0 group-hover:text-claude-textSecondary/30 hover:!text-red-400 transition-colors flex-shrink-0"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                    {(!selected.models || selected.models.length === 0) && (
                      <div className="text-[12px] text-claude-textSecondary/40 py-2">暂无模型 — 点击「获取模型列表」自动拉取，或手动添加。</div>
                    )}
                    {(selected.models || []).length > MODELS_PER_PAGE && (
                      <div className="flex items-center justify-between pt-2 mt-1 border-t border-claude-border/30">
                        <button
                          onClick={() => setModelPage(p => Math.max(0, p - 1))}
                          disabled={modelPage === 0}
                          className="text-[11px] px-2 py-1 rounded text-claude-textSecondary hover:bg-claude-hover disabled:opacity-30 disabled:cursor-default transition-colors"
                        >← 上一页</button>
                        <span className="text-[11px] text-claude-textSecondary/50">
                          {modelPage + 1} / {Math.ceil((selected.models || []).length / MODELS_PER_PAGE)}
                        </span>
                        <button
                          onClick={() => setModelPage(p => Math.min(Math.ceil((selected.models || []).length / MODELS_PER_PAGE) - 1, p + 1))}
                          disabled={modelPage >= Math.ceil((selected.models || []).length / MODELS_PER_PAGE) - 1}
                          className="text-[11px] px-2 py-1 rounded text-claude-textSecondary hover:bg-claude-hover disabled:opacity-30 disabled:cursor-default transition-colors"
                        >下一页 →</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Default model display */}
                {defaultModel && (
                  <div className="text-[11px] text-claude-textSecondary/50 flex items-center gap-1.5 pt-1">
                    <span>默认对话模型：</span>
                    <span className="text-claude-text font-medium">{
                      (() => {
                        for (const p of providerList) {
                          const m = (p.models || []).find(x => x.id === defaultModel);
                          if (m) return m.name || m.id;
                        }
                        return defaultModel;
                      })()
                    }</span>
                  </div>
                )}
                </SettingGroup>

              </div>
            );
          })() : !showAdd && (
            <div className="flex flex-col items-center justify-center h-full text-claude-textSecondary/40">
              <div className="text-[14px] mb-2">还没有配置供应商</div>
              <button
                onClick={() => { setAddError(null); setShowAdd(true); }}
                className="text-[13px] text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                + 添加第一个供应商
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 获取模型列表 → 勾选弹窗 */}
      {modelPickerFor && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-3"
          onClick={() => { if (!fetchingModels) { setModelPickerFor(null); setModelCandidates([]); } }}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[16px] border border-claude-border bg-claude-bg shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-claude-border px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-claude-text">选择模型</div>
                <div className="truncate text-[12px] text-claude-textSecondary">
                  {getProviderDisplayName(modelPickerFor.name)}
                  {modelCandidates.length > 0 && ` · 共 ${modelCandidates.length} 个`}
                </div>
              </div>
              <button
                onClick={() => { setModelPickerFor(null); setModelCandidates([]); }}
                className="ml-2 shrink-0 rounded-md p-1.5 text-claude-textSecondary transition-colors hover:bg-claude-hover hover:text-claude-text"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            {fetchingModels ? (
              <div className="px-4 py-10 text-center text-[13px] text-claude-textSecondary">正在获取模型列表…</div>
            ) : modelPickerError ? (
              <div className="px-4 py-8">
                <div className="rounded-[10px] bg-red-50 px-3 py-2.5 text-[13px] text-red-600 dark:bg-red-500/10 dark:text-red-400">
                  {modelPickerError}
                </div>
                <button
                  onClick={() => handleFetchModels(modelPickerFor)}
                  className="mt-3 rounded-[8px] border border-claude-border px-3 py-1.5 text-[13px] text-claude-text transition-colors hover:bg-claude-hover"
                >
                  重试
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-claude-border px-4 py-2.5">
                  <input
                    type="text"
                    value={modelPickerSearch}
                    onChange={e => setModelPickerSearch(e.target.value)}
                    placeholder="搜索模型…"
                    className="min-w-0 flex-1 rounded-[8px] border border-claude-border bg-transparent px-2.5 py-1.5 text-[13px] text-claude-text outline-none transition-colors placeholder:text-claude-textSecondary/40 focus:border-[#387ee0]/60"
                  />
                  <button
                    onClick={() => {
                      const visible = modelCandidates.filter(id => id.toLowerCase().includes(modelPickerSearch.toLowerCase()));
                      const allPicked = visible.every(id => modelPicked.has(id));
                      const next = new Set(modelPicked);
                      visible.forEach(id => { if (allPicked) next.delete(id); else next.add(id); });
                      setModelPicked(next);
                    }}
                    className="shrink-0 rounded-[8px] border border-claude-border px-2.5 py-1.5 text-[12px] text-claude-textSecondary transition-colors hover:bg-claude-hover hover:text-claude-text"
                  >
                    全选/反选
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-2 py-1.5">
                  {modelCandidates
                    .filter(id => id.toLowerCase().includes(modelPickerSearch.toLowerCase()))
                    .map(id => {
                      const checked = modelPicked.has(id);
                      return (
                        <label
                          key={id}
                          className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-2 transition-colors hover:bg-claude-hover"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = new Set(modelPicked);
                              if (checked) next.delete(id); else next.add(id);
                              setModelPicked(next);
                            }}
                            className="size-[15px] shrink-0 accent-[#387ee0]"
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-claude-text">{id}</span>
                        </label>
                      );
                    })}
                  {modelCandidates.filter(id => id.toLowerCase().includes(modelPickerSearch.toLowerCase())).length === 0 && (
                    <div className="px-2 py-8 text-center text-[13px] text-claude-textSecondary">没有匹配的模型</div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-claude-border px-4 py-3">
                  <span className="text-[12px] text-claude-textSecondary">已选 {modelPicked.size} 个</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setModelPickerFor(null); setModelCandidates([]); }}
                      className="rounded-[8px] border border-claude-border px-3 py-1.5 text-[13px] text-claude-text transition-colors hover:bg-claude-hover"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleConfirmModelPick}
                      disabled={modelPicked.size === 0}
                      className="rounded-[8px] bg-[#387ee0] px-3.5 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      保存
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProviderSettings;
