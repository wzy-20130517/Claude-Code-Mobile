import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Download, Loader2, Package,
  Power, PowerOff, RefreshCw, Trash2, X,
} from 'lucide-react';
import {
  getPluginsStatus,
  getPluginProviders,
  getPluginBundles,
  setPluginEnabled,
  installPlugin,
  removePlugin,
  type DshPluginStatus,
  type DshProvider,
  type DshBundle,
} from '../../api';

/**
 * 插件面板（DSH 插件宿主）
 *
 * 【2026-10-05 新增】对齐 CLI 的 /plugin 命令。
 *
 * 背景：CLI 侧 10-04 接入了 DSH 插件宿主（DeepSeek Harness 生态，
 * 116 个官方包 + 28 个服务类 + 31 个官方插件实测活跃），但 Web 端
 * **一个入口都没有** —— 用户指出「web 端其实有点落后了」。
 *
 * 数据来自服务端 /api/plugins（代理宿主的 /control/* API，含自愈拉起）。
 *
 * 【与「连接器」的区别】
 *   · 连接器（Connectors）= MCP 服务器（协议级工具接入，如 GitHub / QQ）
 *   · 插件（Plugins）    = Cordis 插件（常驻宿主进程，如账号池 / 免费额度聚合）
 * 两者是不同层次的扩展机制，不要混。
 */
const PluginPanel: React.FC = () => {
  const [status, setStatus] = useState<DshPluginStatus | null>(null);
  const [providers, setProviders] = useState<DshProvider[]>([]);
  const [bundles, setBundles] = useState<DshBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [installTarget, setInstallTarget] = useState('');
  const [showInstall, setShowInstall] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await getPluginsStatus();
      setStatus(s);
      if (s.running) {
        // providers / bundles 依赖宿主在跑；失败不阻塞主状态展示
        const [p, b] = await Promise.all([
          getPluginProviders().catch(() => ({ providers: [] })),
          getPluginBundles().catch(() => ({ bundles: [] })),
        ]);
        setProviders(p.providers || []);
        setBundles(b.bundles || []);
      }
    } catch (err: any) {
      setError(err?.message || '读取插件状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleToggle = async (name: string, enabled: boolean) => {
    setBusy(name);
    setError('');
    try {
      await setPluginEnabled(name, enabled);
      await refresh();
    } catch (err: any) {
      setError(err?.message || '操作失败');
    } finally {
      setBusy('');
    }
  };

  const handleInstall = async () => {
    const target = installTarget.trim();
    if (!target) return;
    setBusy(target);
    setError('');
    try {
      await installPlugin(target);
      setInstallTarget('');
      setShowInstall(false);
      await refresh();
    } catch (err: any) {
      setError(err?.message || '安装失败');
    } finally {
      setBusy('');
    }
  };

  const handleRemove = async (name: string) => {
    setBusy(name);
    setError('');
    try {
      await removePlugin(name);
      await refresh();
    } catch (err: any) {
      setError(err?.message || '卸载失败');
    } finally {
      setBusy('');
    }
  };

  // bundles 列表里点「安装」——按包名直接装（与输入框那条路径共用 installPlugin）
  const handleInstallFor = async (name: string) => {
    setBusy(name);
    setError('');
    try {
      await installPlugin(name);
      await refresh();
    } catch (err: any) {
      setError(err?.message || '安装失败');
    } finally {
      setBusy('');
    }
  };

  // ── 宿主未运行 ────────────────────────────────────────────────────
  if (!loading && status && !status.running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-claude-bg px-8">
        <AlertCircle size={40} className="text-claude-textSecondary opacity-60" />
        <div className="text-center">
          <div className="text-[15px] font-medium text-claude-text">插件宿主未运行</div>
          <div className="mt-1.5 text-[13px] leading-5 text-claude-textSecondary">
            {status.error || '无法连接到 DSH 宿主'}
          </div>
          {status.hint && (
            <code className="mt-3 inline-block rounded-md bg-claude-hover px-3 py-1.5 text-[12px] text-claude-textSecondary">
              {status.hint}
            </code>
          )}
        </div>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-2 rounded-lg bg-claude-text px-4 py-2 text-[13px] font-medium text-claude-bg transition-opacity hover:opacity-90"
        >
          <RefreshCw size={15} />
          重试（会自动拉起）
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-claude-bg">
      <div className="mx-auto w-full max-w-[720px] px-6 py-8">
        {/* 头部 */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-[19px] font-semibold text-claude-text">插件</h2>
            <p className="mt-1 text-[13px] leading-5 text-claude-textSecondary">
              DSH 插件（Cordis 框架）—— 常驻宿主进程的扩展，与「连接器」不同层次。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowInstall(v => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-claude-border px-3 py-1.5 text-[13px] font-medium text-claude-text transition-colors hover:bg-claude-hover"
            >
              <Download size={14} />
              安装
            </button>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded-lg border border-claude-border p-1.5 text-claude-text transition-colors hover:bg-claude-hover disabled:opacity-50"
              title="刷新"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-red-500" />
            <span className="flex-1 text-[13px] leading-5 text-red-500">{error}</span>
            <button onClick={() => setError('')} className="text-red-500/60 hover:text-red-500">
              <X size={14} />
            </button>
          </div>
        )}

        {/* 安装输入 */}
        {showInstall && (
          <div className="mb-5 rounded-xl border border-claude-border bg-white p-4 dark:bg-[#30302E]">
            <div className="mb-2 text-[13px] font-medium text-claude-text">安装插件包</div>
            <div className="flex gap-2">
              <input
                value={installTarget}
                onChange={e => setInstallTarget(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleInstall(); }}
                placeholder="包名，如 dsh-account-pool"
                className="flex-1 rounded-lg border border-claude-border bg-claude-bg px-3 py-2 text-[13px] text-claude-text outline-none focus:border-claude-text/30"
              />
              <button
                onClick={() => void handleInstall()}
                disabled={!installTarget.trim() || !!busy}
                className="rounded-lg bg-claude-text px-4 py-2 text-[13px] font-medium text-claude-bg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy === installTarget.trim() ? '安装中…' : '安装'}
              </button>
            </div>
            <div className="mt-2 text-[12px] text-claude-textSecondary">
              npm 装包 + 热加载，通常需要十几秒。
            </div>
          </div>
        )}

        {loading && !status ? (
          <div className="flex items-center justify-center py-16 text-claude-textSecondary">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : (
          <>
            {/* 概览 */}
            {status && (
              <div className="mb-6 grid grid-cols-3 gap-3">
                <StatCard label="插件" value={status.plugins?.length ?? 0} />
                <StatCard label="服务" value={status.services?.count ?? 0} />
                <StatCard label="Provider" value={status.providers?.length ?? 0} />
              </div>
            )}

            {/* 已加载插件 */}
            <section className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <Package size={15} className="text-claude-textSecondary" />
                <span className="text-[14px] font-medium text-claude-text">已加载插件</span>
              </div>
              {status?.plugins?.length ? (
                <div className="space-y-2">
                  {status.plugins.map(name => {
                    // 宿主返回两种形态（历史兼容）：
                    //   新版：{ state: 2, active: true }（见 dsh-host/server.mjs pluginState()）
                    //   旧版：裸数字 2
                    // 两种都认，别只按一种写 —— 实测 2026-10-05 返回的是对象形态。
                    const raw = status.pluginStates?.[name];
                    const stateNum = typeof raw === 'object' && raw !== null ? raw.state : raw;
                    const active = stateNum === 2 || (typeof raw === 'object' && raw?.active === true);
                    const suspended = stateNum === 0;
                    return (
                      <div
                        key={name}
                        className="flex items-center gap-3 rounded-xl border border-claude-border bg-white px-4 py-3 dark:bg-[#30302E]"
                      >
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-claude-hover">
                          {active ? (
                            <CheckCircle2 size={16} className="text-green-500" />
                          ) : (
                            <AlertCircle size={16} className="text-yellow-500" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-claude-text">{name}</div>
                          <div className="mt-0.5 text-[12px] text-claude-textSecondary">
                            {active ? '活跃' : suspended ? '挂起（等待依赖）' : `状态 ${stateNum ?? '未知'}`}
                          </div>
                        </div>
                        <button
                          onClick={() => void handleToggle(name, false)}
                          disabled={busy === name}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-claude-textSecondary transition-colors hover:bg-claude-hover hover:text-claude-text disabled:opacity-40"
                          title="禁用"
                        >
                          {busy === name ? <Loader2 size={13} className="animate-spin" /> : <PowerOff size={13} />}
                        </button>
                        <button
                          onClick={() => void handleRemove(name)}
                          disabled={busy === name}
                          className="rounded-md p-1 text-claude-textSecondary transition-colors hover:bg-claude-hover hover:text-red-500 disabled:opacity-40"
                          title="卸载"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-claude-border py-8 text-center text-[13px] text-claude-textSecondary">
                  还没有加载任何插件
                </div>
              )}
            </section>

            {/* 可安装的插件包 */}
            {bundles.length > 0 && (
              <section className="mb-8">
                <div className="mb-3 flex items-center gap-2">
                  <Download size={15} className="text-claude-textSecondary" />
                  <span className="text-[14px] font-medium text-claude-text">可安装</span>
                </div>
                <div className="space-y-2">
                  {bundles.map(b => {
                    const installed = status?.plugins?.includes(b.name);
                    return (
                      <div
                        key={b.name}
                        className="flex items-center gap-3 rounded-xl border border-claude-border bg-white px-4 py-3 dark:bg-[#30302E]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-claude-text">{b.name}</div>
                          {b.description && (
                            <div className="mt-0.5 text-[12px] leading-4 text-claude-textSecondary">{b.description}</div>
                          )}
                        </div>
                        {installed ? (
                          <span className="flex-shrink-0 rounded-md bg-claude-hover px-2 py-1 text-[11.5px] text-claude-textSecondary">
                            已安装
                          </span>
                        ) : (
                          <button
                            onClick={() => void handleInstallFor(b.name)}
                            disabled={!!busy}
                            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-claude-border px-2.5 py-1 text-[12px] font-medium text-claude-text transition-colors hover:bg-claude-hover disabled:opacity-40"
                          >
                            {busy === b.name ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                            安装
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Provider */}
            {providers.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <Power size={15} className="text-claude-textSecondary" />
                  <span className="text-[14px] font-medium text-claude-text">Provider 接入地址</span>
                </div>
                <div className="space-y-2">
                  {providers.map(p => (
                    <div
                      key={p.id}
                      className="rounded-xl border border-claude-border bg-white px-4 py-3 dark:bg-[#30302E]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium text-claude-text">{p.name}</span>
                        <span className="rounded-md bg-claude-hover px-1.5 py-0.5 text-[11px] text-claude-textSecondary">
                          {p.id}
                        </span>
                        <span className={`ml-auto text-[11.5px] ${p.ready ? 'text-green-500' : 'text-yellow-500'}`}>
                          {p.ready ? '就绪' : '未就绪'}
                        </span>
                      </div>
                      <code className="mt-2 block truncate rounded-md bg-claude-hover px-2 py-1.5 text-[11.5px] text-claude-textSecondary">
                        {p.ccmBaseUrl}
                      </code>
                      {p.models?.length > 0 && (
                        <div className="mt-1.5 text-[11.5px] text-claude-textSecondary">
                          {p.models.length} 个模型：{p.models.slice(0, 3).join('、')}
                          {p.models.length > 3 ? ' …' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-xl border border-claude-border bg-white px-4 py-3 dark:bg-[#30302E]">
    <div className="text-[22px] font-semibold leading-none text-claude-text">{value}</div>
    <div className="mt-1.5 text-[12px] text-claude-textSecondary">{label}</div>
  </div>
);

export default PluginPanel;
