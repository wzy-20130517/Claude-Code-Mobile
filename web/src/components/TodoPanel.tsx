import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, ListChecks, Loader2 } from 'lucide-react';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

interface TodoPanelProps {
  todos: TodoItem[];
  running?: boolean;
}

const TodoPanel: React.FC<TodoPanelProps> = ({ todos, running }) => {
  const [collapsed, setCollapsed] = useState(false);

  const stats = useMemo(() => {
    const total = todos.length;
    const done = todos.filter(item => item.status === 'completed').length;
    const active = todos.find(item => item.status === 'in_progress');
    return { total, done, active };
  }, [todos]);

  if (!todos.length) return null;

  const progress = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="fixed bottom-[150px] right-6 z-[95] w-[300px] overflow-hidden rounded-2xl border border-claude-border bg-claude-bg/95 shadow-xl backdrop-blur">
      <button
        type="button"
        onClick={() => setCollapsed(value => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-claude-hover"
      >
        <ListChecks size={15} className="shrink-0 text-claude-accent" />
        <span className="flex-1 text-[13px] font-medium text-claude-text">任务清单</span>
        <span className="text-[11px] tabular-nums text-claude-textSecondary">{stats.done}/{stats.total}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-claude-textSecondary transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>

      <div className="px-4">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-claude-border">
          <div
            className="h-full rounded-full bg-claude-accent transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-[260px] overflow-y-auto px-2 py-2">
          {todos.map((item, index) => {
            const done = item.status === 'completed';
            const active = item.status === 'in_progress';
            return (
              <div
                key={`${index}-${item.content}`}
                className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${active ? 'bg-claude-hover' : ''}`}
              >
                <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center">
                  {done ? (
                    <Check size={13} className="text-claude-accent" />
                  ) : active ? (
                    <Loader2 size={13} className="animate-spin text-claude-accent" />
                  ) : (
                    <span className="h-[7px] w-[7px] rounded-full border border-claude-border" />
                  )}
                </span>
                <span
                  className={`text-[12.5px] leading-[18px] ${
                    done
                      ? 'text-claude-textSecondary line-through'
                      : active
                        ? 'text-claude-text'
                        : 'text-claude-textSecondary'
                  }`}
                >
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {running && stats.active && (
        <div className="border-t border-claude-border px-4 py-2 text-[11px] text-claude-textSecondary">
          正在进行：{stats.active.content}
        </div>
      )}
    </div>
  );
};

export default React.memo(TodoPanel);
