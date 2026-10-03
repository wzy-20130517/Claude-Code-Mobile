import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Check, ChevronRight } from 'lucide-react';

export interface SelectableModel {
  id: string;
  name: string;
  enabled: number;
  description?: string;
  tier?: 'opus' | 'sonnet' | 'haiku' | 'extra';
  // 模型来源（哪个 Provider），下拉里显示成 `模型名(ID)` 用
  providerId?: string;
  providerName?: string;
  thinkingId?: string;
  // 主模型兜底条目（Provider 没配 models 列表时用主 model 生成的那条）
  primary?: boolean;
}

// Chat model thinking mapping from localStorage
function getChatModelMap(): Map<string, { thinkingId?: string }> {
  try {
    const models = JSON.parse(localStorage.getItem('chat_models') || '[]');
    const map = new Map<string, { thinkingId?: string }>();
    for (const m of models) {
      map.set(m.id, { thinkingId: m.thinkingId });
      if (m.thinkingId) map.set(m.thinkingId, { thinkingId: m.thinkingId });
    }
    return map;
  } catch { return new Map(); }
}

function stripThinking(modelStr: string) {
  const map = getChatModelMap();
  // Check if this is a known thinking variant — find the base model
  for (const [baseId, cfg] of map) {
    if (cfg.thinkingId === modelStr) return baseId;
  }
  return (modelStr || '').replace(/-thinking$/, '');
}

function withThinking(base: string, thinking: boolean) {
  if (!thinking) return base;
  const map = getChatModelMap();
  const cfg = map.get(base);
  if (cfg?.thinkingId) return cfg.thinkingId;
  return `${base}-thinking`;
}

function isThinking(modelStr: string) {
  const map = getChatModelMap();
  // Check if it's a known thinking variant
  for (const [, cfg] of map) {
    if (cfg.thinkingId === modelStr) return true;
  }
  return typeof modelStr === 'string' && modelStr.endsWith('-thinking');
}

function hasThinkingVariant(_modelId: string): boolean {
  // 扩展思考由会话级 thinking 参数控制，所有模型都可切。
  return true;
}

// Turn raw model ids / names into friendly labels.
// - claude-opus-4-6 → "Opus 4.6", claude-haiku-4-5-20251001 → "Haiku 4.5"
// - GLM-5 → "GLM 5", Deepseek-V3.2 → "Deepseek V3.2" (hyphens become spaces)
// - Strips provider/org prefix (e.g. "Pro/zai-org/GLM-5" → "GLM 5")
function prettifyModelName(name?: string, id?: string): string {
  for (const candidate of [id, name]) {
    if (!candidate) continue;
    const m = candidate.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
    if (m) {
      const tier = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      return `${tier} ${m[2]}.${m[3]}`;
    }
  }
  const raw = name || id || '';
  if (!raw) return 'Model';
  const lastSlash = raw.lastIndexOf('/');
  const trimmed = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
  // 【保留连字符】原来 `.replace(/-/g, ' ')` 把 `deepseek-v4-flash` 变成
  // `deepseek v4 flash` —— 用户看到的跟实际模型名对不上（复制/搜索/核对都不方便）。
  // 只做去掉组织前缀，名字保持原样。
  return trimmed;
}

/** 带来源的完整标签：`deepseek-v4-flash(cfg-2)`。
 *  同名的模型可能来自不同 Provider，只显示名字用户分不清是哪个配置里的。 */
function modelLabelWithProvider(model?: { name?: string; id?: string; providerId?: string; providerName?: string } | null): string {
  if (!model) return 'Model';
  const base = prettifyModelName(model.name, model.id);
  const src = model.providerId || model.providerName;
  return src ? `${base}(${src})` : base;
}

/**
 * 拆成 [模型名, (ID)] 两段，供按钮分开渲染。
 *
 * 【为什么拆】按钮里整串文字被 `truncate` 截断时，被截掉的恰好是**结尾的 (ID)** ——
 * 用户看到「deepseek-v4-flash-07…」，分不清是哪个配置。而 ID 正是用来区分同名
 * 模型的关键信息，不能丢。拆开后：模型名照常截断，`(ID)` 用 shrink-0 保住。
 */
function splitModelLabel(model?: { name?: string; id?: string; providerId?: string; providerName?: string } | null): { base: string; id: string } {
  if (!model) return { base: 'Model', id: '' };
  const base = prettifyModelName(model.name, model.id);
  const src = model.providerId || model.providerName;
  return { base, id: src ? `(${src})` : '' };
}

interface ModelSelectorProps {
  currentModelString: string;
  models: SelectableModel[];
  onModelChange: (newModelString: string) => void;
  isNewChat?: boolean;
  dropdownPosition?: 'top' | 'bottom';
  variant?: 'default' | 'landing';
  caretIconSrc?: string;
  thinkingEffort?: string;
  onThinkingEffortChange?: (effort: string) => void;
  // 这两个一直在用（组件里读 thinkingEnabled 控制思考区），但接口漏声明了 ——
  // 类型检查因此报「属性不存在」，MainContent 的调用点也被标红。
  thinkingEnabled?: boolean;
  onThinkingChange?: (enabled: boolean) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModelString,
  models,
  onModelChange,
  dropdownPosition,
  variant = 'default',
  caretIconSrc,
  thinkingEnabled,
  onThinkingChange,
  thinkingEffort = 'xhigh',
  onThinkingEffortChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const effortOptions = [
    { id: 'low', label: '低', hint: '快速响应' },
    { id: 'medium', label: '中', hint: '日常任务' },
    { id: 'high', label: '高', hint: '复杂问题' },
    { id: 'xhigh', label: '极高', hint: '深度分析' },
    { id: 'max', label: '最大', hint: '尽可能深入' },
  ];

  const currentBase = stripThinking(currentModelString);
  const thinking = thinkingEnabled !== undefined ? thinkingEnabled : isThinking(currentModelString);
  // 【三级匹配找当前模型】精确 id → 去重前缀 → 同前缀任一（providerId 要能拿出来）。
  // 只按精确 id 找的话，会话里存的是历史模型名（比如切过 Provider 之后），
  // 匹配不上就退化成纯名字，用户看不到 `(providerId)` 后缀 —— 正是「让你加的 ID
  // 根本显示不出来」的原因。找到任一带 providerId 的条目即可
  // （同一模型在多个 Provider 都有时，取第一个，聊胜于无）。
  const currentModel = models.find(m => m && m.id === currentBase)
    || models.find(m => m && m.id && (m.id.startsWith(currentBase) || currentBase.startsWith(m.id)));
  // 当前选中项也带上 Provider 来源，用户一眼知道用的是哪个配置的模型
  const currentLabel = modelLabelWithProvider(currentModel || { id: currentBase });
  const splitLabel = splitModelLabel(currentModel || { id: currentBase });

  // Split models into main tiers and extra
  const configuredMainModels = models.filter(m => m && m.tier !== 'extra');
  const mainModels = configuredMainModels.length > 0 ? configuredMainModels : models.filter(Boolean);
  const extraModels = configuredMainModels.length > 0 ? models.filter(m => m && m.tier === 'extra') : [];
  const hasExtra = extraModels.length > 0;

  // Current model supports thinking?
  const currentHasThinking = hasThinkingVariant(currentBase);
  const isLandingVariant = variant === 'landing';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowMore(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggleOpen = () => {
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setDropUp(dropdownPosition === 'top' ? true : (dropdownPosition === 'bottom' ? false : spaceBelow < 280));
    }
    setIsOpen(!isOpen);
    setShowMore(false);
  };

  const handleSelectModel = (baseId: string, enabled: number) => {
    if (!enabled) return;
    // 模型名保持干净；扩展思考不再拼接到模型名里。
    onModelChange(onThinkingChange ? baseId : withThinking(baseId, thinking));
    setIsOpen(false);
    setShowMore(false);
  };

  const handleToggleThinking = () => {
    if (onThinkingChange) {
      onThinkingChange(!thinking);
      return;
    }
    if (!currentHasThinking) return;
    onModelChange(withThinking(currentBase, !thinking));
  };

  const renderModelItem = (m: SelectableModel) => {
    const active = currentBase === m.id;
    const disabled = Number(m.enabled) !== 1;
    return (
      <button
        key={m.id || Math.random()}
        onClick={() => handleSelectModel(m.id, m.enabled)}
        disabled={disabled}
        className={`w-full px-4 ${m.description ? 'py-2.5' : 'py-2'} flex items-center justify-between text-left ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-claude-hover cursor-pointer'}`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] font-[500] text-claude-text truncate">{modelLabelWithProvider(m)}</div>
          {m.description && <div className="text-[12.5px] text-claude-textSecondary mt-0.5">{m.description}</div>}
        </div>
        {active && <Check size={18} className="text-[#3b82f6] ml-2 shrink-0" />}
      </button>
    );
  };

  return (
    <div className="relative inline-block text-right" ref={containerRef}>
      <button
        onClick={handleToggleOpen}
        className={
          isLandingVariant
            ? 'flex h-[32px] items-center gap-[6px] rounded-[6px] px-[10px] text-[14px] font-normal tracking-[-0.1504px] text-[#373734] dark:text-claude-text transition-colors hover:bg-[#f5f4f1] dark:hover:bg-white/5'
            : 'flex items-center gap-1.5 text-[15px] font-medium text-claude-text hover:bg-claude-hover px-3 py-2 rounded-md transition-colors'
        }
      >
        {/* 【窄屏宽度】原来统一 38vw，但对话页底部一行还挤着「+」「token 计数」「发送按钮」，
            38vw（390 屏 ≈148px）会把发送按钮顶出输入框（实测溢出 8px）。
            落地页没有 token 计数，保持 38vw；对话页收窄到 30vw（≈117px）留出空间。 */}
        {/* 【分开渲染】模型名可截断，`(ID)` 必须完整保留（它是区分同名配置的唯一标识）。
            原来整串 truncate，结尾的 ID 第一个被吃掉 →「deepseek-v4-flash-07…」。 */}
        <span className={`truncate ${isLandingVariant ? 'max-w-[38vw]' : 'max-w-[30vw]'} md:max-w-none`}>{splitLabel.base}</span>
        {splitLabel.id && (
          <span className="shrink-0 text-claude-textSecondary">{splitLabel.id}</span>
        )}
        {/* 【2026-09-19 用户要求】去掉窄屏的 ✳ 扩展思考标记。
            它只占宽不传达有效信息（思考强度在设置里调，这里一个星号没人看得懂）。 */}
        {thinking && !isLandingVariant && (
          <span className="hidden md:inline text-claude-textSecondary font-normal">扩展思考</span>
        )}
        {caretIconSrc ? (
          <img
            src={caretIconSrc}
            alt=""
            aria-hidden="true"
            className={isLandingVariant ? 'h-4 w-4 opacity-75 dark:invert dark:brightness-150' : 'h-[14px] w-[14px] opacity-75 dark:invert dark:brightness-150'}
          />
        ) : (
          <ChevronDown size={isLandingVariant ? 16 : 14} className={isLandingVariant ? 'text-[#373734]/75 dark:text-claude-text/75' : 'text-claude-textSecondary'} />
        )}
      </button>

      {isOpen && !showMore && (
        <div className={`absolute ${dropUp ? 'bottom-full mb-2' : 'top-full mt-2'} right-0 w-[260px] bg-claude-input rounded-xl shadow-xl border border-claude-border z-50 overflow-hidden py-1 text-left`}>
          {/* Main tier models */}
          {mainModels.map(renderModelItem)}

          {/* Extended thinking toggle */}
          <div className="h-[1px] bg-claude-border my-1 mx-4" />
          <div className={`px-4 py-2 flex items-center justify-between text-left select-none ${currentHasThinking ? 'hover:bg-claude-hover cursor-pointer' : ''}`}>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className={`text-[14.5px] font-[500] ${currentHasThinking ? 'text-claude-text' : 'text-claude-textSecondary/50'}`}>扩展思考</div>
                {onThinkingEffortChange && (
                  <div className="relative">
                    <button type="button" onClick={(e) => { e.stopPropagation(); setShowEffortMenu(value => !value); }} className="rounded-md px-2 py-1 text-[11px] font-medium text-claude-textSecondary hover:bg-claude-hover hover:text-claude-text" title="选择扩展思考强度">
                      {effortOptions.find(item => item.id === thinkingEffort)?.label || thinkingEffort}
                    </button>
                    {showEffortMenu && (
                      <div className="absolute right-0 bottom-full mb-2 z-[70] w-[190px] rounded-xl border border-claude-border bg-claude-input p-1.5 shadow-xl">
                        <div className="px-2.5 py-1.5 text-[11px] font-medium text-claude-textSecondary">思考强度</div>
                        {effortOptions.map(option => (
                          <button key={option.id} type="button" onClick={() => { onThinkingEffortChange(option.id); setShowEffortMenu(false); }} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left ${thinkingEffort === option.id ? 'bg-claude-hover text-claude-text' : 'text-claude-textSecondary hover:bg-claude-hover hover:text-claude-text'}`}>
                            <span className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${thinkingEffort === option.id ? 'bg-claude-accent' : 'bg-claude-border'}`} />{option.label}</span>
                            <span className="text-[10px] text-claude-textSecondary">{option.hint}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className={`text-[12.5px] mt-0.5 ${currentHasThinking ? 'text-claude-textSecondary' : 'text-claude-textSecondary/30'}`}>为复杂任务进行更深入的思考</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggleThinking();
              }}
              disabled={!currentHasThinking}
              className={`w-10 h-6 rounded-full relative transition-colors duration-200 ${!currentHasThinking ? 'bg-claude-border/50 cursor-not-allowed' : thinking ? 'bg-[#3A6FE0]' : 'bg-claude-border cursor-pointer'}`}
            >
              <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${thinking && currentHasThinking ? 'left-5' : 'left-1'}`} />
            </button>
          </div>

          {/* More models button */}
          {hasExtra && (<>
            <div className="h-[1px] bg-claude-border my-1 mx-4" />
            <button
              onClick={() => setShowMore(true)}
              className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-claude-hover cursor-pointer"
            >
              <div className="text-[14.5px] font-[500] text-claude-text">更多模型</div>
              <ChevronRight size={16} className="text-claude-textSecondary" />
            </button>
          </>)}
        </div>
      )}

      {/* More models sub-panel */}
      {isOpen && showMore && (
        <div className={`absolute ${dropUp ? 'bottom-full mb-2' : 'top-full mt-2'} right-0 w-[260px] bg-claude-input rounded-xl shadow-xl border border-claude-border z-50 overflow-hidden py-1 text-left`}>
          <button
            onClick={() => setShowMore(false)}
            className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-claude-hover cursor-pointer text-claude-textSecondary"
          >
            <ChevronRight size={14} className="rotate-180" />
            <span className="text-[13px] font-medium">返回</span>
          </button>
          <div className="h-[1px] bg-claude-border my-1 mx-4" />
          {extraModels.map(renderModelItem)}
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
