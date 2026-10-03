import React, { useMemo, useEffect, useRef, useState, useCallback } from 'react';

export interface SlashSuggestion {
  name: string;
  description?: string;
  kind?: 'command' | 'skill';
  passive?: boolean;
}

interface SlashCommandMenuProps {
  suggestions: SlashSuggestion[];
  activeIndex: number;
  onSelect: (item: SlashSuggestion) => void;
  onHover: (index: number) => void;
  placement?: 'above' | 'below';
  /** 未输关键词时被折叠的 skill 数量（提示用户「可搜 skill」） */
  hiddenSkills?: number;
}

const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({ suggestions, activeIndex, onSelect, onHover, placement, hiddenSkills = 0 }) => {
  // 【2026-09-20 用户反馈「新建对话打出 /，命令面板会飘到屏幕外」】
  //
  // 根因：原来固定用 `absolute bottom-full mb-2`（相对输入框容器）。
  // 新对话页的输入框**不在屏幕底部**（在中间偏上），
  // absolute 定位以输入框为基准往上展开 → 面板整个跑到视口上方之外。
  //
  // 现在改成 **fixed 定位 + 实测空间**：
  //   1. 找输入框容器（parentElement），量它的位置
  //   2. 上方空间够就往上展开，不够就往下 —— 不管输入框在屏幕哪
  //   3. 高度取上下空间的较大者，保证面板完整可见
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; maxH: number } | null>(null);

  const measure = useCallback(() => {
    const anchor = listRef.current?.parentElement;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const GAP = 8;
    const spaceAbove = r.top - GAP;
    const spaceBelow = vh - r.bottom - GAP;
    // 优先按传入的 placement，没传就按空间自动决定（上方够就上方）
    const preferBelow = placement ? placement === 'below' : spaceAbove < 160;
    const useBelow = preferBelow && spaceBelow >= 120;
    const maxH = Math.min(300, Math.max(120, useBelow ? spaceBelow : spaceAbove));
    setPos({
      left: r.left + 12,               // 与菜单原来的 left-3 对齐
      width: r.width - 24,             // 对应 right-3
      top: useBelow ? r.bottom + GAP : Math.max(GAP, r.top - GAP - maxH),
      maxH,
    });
  }, [placement]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  // 输入内容变化会让输入框高度变（textarea 自适应），重新量一次
  useEffect(() => { measure(); }, [suggestions.length, measure]);
  // 【2026-09-19 修】原来命令砍到 20、skill 砍到 8，且不再提示总数。
  // 现在全量渲染，靠容器 max-h + overflow-y-auto 滚动；用户想看哪个滚就是了。
  // 键盘上下键已经支持（activeIndex 由父组件维护），滚动容器会自动跟随高亮项。
  const visible = useMemo(() => {
    const commands = suggestions.filter(item => item.kind !== 'skill')
    const skills = suggestions.filter(item => item.kind === 'skill')
    return [...commands, ...skills]
  }, [suggestions])
  // 高亮项滚入视野：47 个命令塞进 300px 面板，光有 activeIndex 不够，
  // 上下键选到第 8 项以后必须自动滚动，否则高亮跑到可视区外，用户不知道选到哪了。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (visible.length === 0) return null;

  return (
    <div
      ref={listRef}
      style={pos ? { position: 'fixed', left: pos.left, width: pos.width, top: pos.top, maxHeight: pos.maxH } : { visibility: 'hidden' }}
      className="z-[9999] overflow-y-auto rounded-xl border border-claude-border bg-claude-input shadow-[0_8px_30px_rgba(0,0,0,0.14)]"
      role="listbox"
      aria-label="Slash command suggestions"
    >
      <div className="px-3 py-2 text-[11px] text-claude-textSecondary border-b border-claude-border/60">
        Slash 命令 / Skills
      </div>
      {visible.map((item, index) => (
        <button
          key={`${item.kind || 'command'}:${item.name}`}
          type="button"
          role="option"
          data-idx={index}
          aria-selected={index === activeIndex}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${index === activeIndex ? 'bg-claude-hover' : 'hover:bg-claude-hover/70'}`}
        >
          {/* 宽度改成 min-w 而不是死宽 88px：/compact-threshold 这种长名不再被截成 /compact-th... */}
          <span className={`min-w-[88px] flex-shrink-0 font-mono text-[13px] whitespace-nowrap ${item.kind === 'skill' ? 'text-[#8B5CF6]' : 'text-[#4B9EFA]'}`}>
            /{item.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-claude-textSecondary">
            {item.description || (item.kind === 'skill' ? 'Skill' : '命令')}
          </span>
          {item.passive && <span className="text-[10px] text-amber-600">passive</span>}
        </button>
      ))}
      {/* 全量渲染后不再有「被砍掉」的项，但列表可能超出 300px 视窗 →
          给一句滚动提示，用户知道下面还有东西。 */}
      {(visible.length > 7 || hiddenSkills > 0) && (
        <div className="sticky bottom-0 px-3 py-1.5 text-[10px] text-claude-textSecondary/60 border-t border-claude-border/60 bg-claude-input">
          共 {visible.length} 项 · 上下键选择
          {hiddenSkills > 0 ? ` · 另有 ${hiddenSkills} 个 skill，输入关键词可搜` : '，或继续输入筛选'}
        </div>
      )}
    </div>
  );
};

export default SlashCommandMenu;
