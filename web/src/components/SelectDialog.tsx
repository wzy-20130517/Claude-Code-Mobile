/**
 * SelectDialog —— 选择列表弹窗（CLI 的 runSelect 在 Web 的对应物）
 *
 * 【为什么不用 WizardDialog】
 * WizardDialog 渲染的是「表单」（输入框 / radio 卡片），适合 `/config provider add`
 * 那种「填 URL、填 key、填模型名」的流程。
 * 而 runSelect 是「从一批里挑一个」：列表常常几十项（模型列表动辄 50+）、
 * 且是**动态拉取**的（`/model` 要先请求 `{url}/models`）。用 radio 渲染会挤成一坨，
 * 也没有搜索 —— 所以单独做一个可滚动、可搜索的列表。
 *
 * 【数据流】
 *   用户敲 /model
 *     → 服务端执行命令 → core/select.mjs 的 runSelect
 *     → 委托器抛 SelectRequired → server 转成 { kind:'select', items, ... }
 *     → SSE command_result 带 select 字段 → 这里弹出
 *     → 用户点某一项 → POST /api/command-select { action:'rerun', meta, value }
 *     → 服务端拼成等价的 `/model <id> <值>` 重新执行 → 复用 CLI 的落盘路径
 *
 * 【2026-09-20 用户反馈】「做完让你做的web slash向导，这做的啥玩意？
 *   打/model应该弹模型列表给我选，其他命令你也注意」——
 *   原来 runSelect 被实现成抛空的 WizardRequired，列表直接丢弃，什么都弹不出来。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface SelectItem {
  value: string;
  label?: string;
  hint?: string;
  desc?: string;
  disabled?: boolean;
}

export interface SelectRequest {
  title: string;
  items: SelectItem[];
  initial?: number;
  footer?: string;
  multi?: boolean;
  action?: string;
  meta?: Record<string, any>;
}

interface Props {
  request: SelectRequest | null;
  onClose: () => void;
  /** 选中一项后调用；父组件负责 POST /api/command-select */
  onPick: (value: string, request: SelectRequest) => Promise<void> | void;
}

const SelectDialog: React.FC<Props> = ({ request, onClose, onPick }) => {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = request?.items || [];

  // 过滤：按 label / value / desc 做不区分大小写的包含匹配
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const hay = `${it.label || ''} ${it.value || ''} ${it.desc || ''} ${it.hint || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  // 打开时重置状态，并把光标停在 initial 指定的项上（CLI 也是这个行为）
  useEffect(() => {
    if (!request) return;
    setQuery('');
    setError(null);
    setBusy(false);
    const init = Math.max(0, Math.min(request.initial || 0, items.length - 1));
    setCursor(init);
    // 让初始项滚进视野
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${init}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
    // 聚焦搜索框（移动端会弹键盘；用户主要靠点，不强求）
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [request]);

  // 过滤结果变化时把光标夹回范围内，避免越界点空
  useEffect(() => {
    setCursor((c) => Math.min(Math.max(0, c), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!request) return null;

  const commit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(value, request);
    } catch (e: any) {
      setError(e?.message || String(e));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => {
        const next = Math.min(c + 1, filtered.length - 1);
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const next = Math.max(c - 1, 0);
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[cursor];
      if (it && !it.disabled) commit(it.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-3"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-[#2b2b2b] shadow-2xl overflow-hidden">
        {/* 标题 */}
        <div className="px-4 pt-3.5 pb-2 shrink-0">
          <div className="text-[15px] font-medium text-claude-text truncate">{request.title}</div>
          {items.length > 8 && (
            <div className="mt-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={`搜索 ${items.length} 项…`}
                className="w-full px-3 py-2 text-[14px] rounded-lg border border-claude-border bg-transparent text-claude-text outline-none focus:border-claude-accent"
              />
            </div>
          )}
        </div>

        {/* 列表 */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2 min-h-0" onKeyDown={onKeyDown} tabIndex={-1}>
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-claude-textSecondary">没有匹配项</div>
          )}
          {filtered.map((it, i) => {
            const active = i === cursor;
            const label = it.label || it.value;
            return (
              <button
                key={`${it.value}-${i}`}
                data-idx={i}
                disabled={it.disabled || busy}
                onMouseEnter={() => setCursor(i)}
                onClick={() => commit(it.value)}
                className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2 transition-colors ${
                  active ? 'bg-claude-btn-hover' : 'hover:bg-claude-btn-hover'
                } ${it.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {/* 当前生效项打勾 —— 与 CLI 的 runSelect 一致（选中项前面有标记） */}
                <span className="w-4 shrink-0 text-claude-accent">
                  {active ? '›' : ''}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[14px] text-claude-text truncate">{label}</span>
                  {it.desc && (
                    <span className="block text-[12px] text-claude-textSecondary truncate">{it.desc}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* 底部：错误 + 提示 + 取消 */}
        <div className="px-4 py-2.5 border-t border-claude-border shrink-0">
          {error && <div className="mb-2 text-[12px] text-red-500 break-words">{error}</div>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-claude-textSecondary truncate">
              {/* 【2026-09-20 用户反馈「部分帮助文本是 CLI 的，比如 ↑↓ 这样的快捷键」】
                  request.footer 来自 core/*.mjs 的 runSelect 调用（如
                  '↑↓ 移动 · 数字键直选 · Enter 确认 · Ctrl+C 取消'）——
                  那是**给终端写的**。浏览器里用鼠标/手指点，没有"数字键直选"，
                  也没有 Ctrl+C 取消（有屏幕上的取消按钮）。
                  所以这里**忽略 CLI 的 footer**，按 Web 的实际交互给提示。 */}
              {items.length > 8 ? '可搜索 · 点选或 ↑↓ 键选择' : '点选一项'}
            </span>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[13px] rounded-lg border border-claude-border text-claude-textSecondary hover:bg-claude-btn-hover transition-colors shrink-0"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SelectDialog;
