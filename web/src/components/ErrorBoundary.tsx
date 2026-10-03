import React from 'react';

interface Props {
  children: React.ReactNode;
  /** 出错区域名，显示在标题里方便定位（如 "设置页"） */
  label?: string;
  /** true 时只占据局部区域（不铺满屏），用于包裹页面内的子模块 */
  inline?: boolean;
}

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
  showDetail: boolean;
}

/**
 * React 渲染期抛出未捕获异常时，React 18 会卸载整棵组件树 → #root 变空 → 白屏，
 * 且控制台之外没有任何提示。ErrorBoundary 把这种情况兜成可读的错误卡片，
 * 保留错误消息 + 组件栈，并提供「重试 / 重新加载」两个出口。
 */
class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null, showDetail: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info });
    // 保留一份到控制台，方便用 remote devtools 或日志排查
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`, error, info?.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null, info: null, showDetail: false });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, info, showDetail } = this.state;
    if (!error) return this.props.children;

    const { label, inline } = this.props;
    const title = label ? `${label}出错了` : '页面出错了';

    return (
      <div
        className={`${inline ? 'w-full py-8' : 'flex-1 min-h-full'} flex items-center justify-center p-6 bg-claude-bg text-claude-text`}
        role="alert"
      >
        <div className="max-w-xl w-full rounded-[14px] border border-red-500/30 bg-red-500/[0.04] p-5">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-full bg-red-500/15 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[15px] font-semibold mb-1">{title}</h2>
              <p className="text-[12.5px] text-claude-textSecondary leading-relaxed mb-3">
                界面渲染时抛出了异常，这一块内容已被隔离，其余功能仍可使用。
              </p>

              <div className="rounded-[10px] bg-black/[0.04] dark:bg-white/[0.05] px-3 py-2 mb-3">
                <code className="text-[12px] font-mono text-red-600 dark:text-red-400 break-all">
                  {error.name}: {error.message || '(无错误消息)'}
                </code>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={this.handleRetry}
                  className="px-3 py-1.5 text-[12px] font-medium rounded-lg bg-claude-text text-claude-bg hover:opacity-85 transition-opacity"
                >
                  重试
                </button>
                <button
                  onClick={this.handleReload}
                  className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-claude-border text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover transition-colors"
                >
                  重新加载页面
                </button>
                {(error.stack || info?.componentStack) && (
                  <button
                    onClick={() => this.setState({ showDetail: !showDetail })}
                    className="px-3 py-1.5 text-[12px] font-medium rounded-lg text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover transition-colors"
                  >
                    {showDetail ? '收起详情' : '查看详情'}
                  </button>
                )}
              </div>

              {showDetail && (
                <pre className="mt-3 max-h-[240px] overflow-auto rounded-[10px] bg-black/[0.05] dark:bg-white/[0.05] p-3 text-[11px] font-mono leading-relaxed text-claude-textSecondary whitespace-pre-wrap break-all">
                  {error.stack || ''}
                  {info?.componentStack ? `\n--- 组件栈 ---${info.componentStack}` : ''}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
