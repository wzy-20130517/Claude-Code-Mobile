import React from 'react';
import { ExternalLink } from 'lucide-react';

import {
  getConnectorCapabilities,
  getConnectorInstallMethodLabel,
  getConnectorSetupSteps,
  getConnectorStatusMeta,
  type ConnectorCatalogEntry,
  type ConnectorRuntimeStatus,
} from './connectorCatalog';

interface GithubUser {
  avatar_url: string;
  login: string;
  name?: string;
}

interface ConnectorDetailsPanelProps {
  connector: ConnectorCatalogEntry;
  githubUser: GithubUser | null;
  mcpConfigPath: string | null;
  mcpBusy?: boolean;
  onConnectConnector: () => void;
  onGithubConnect: () => void;
  onGithubDisconnect: () => void;
  onInstallConnector: () => void;
  onOpenWebsite: (url: string) => void;
  onUninstallConnector: () => void;
  runtimeStatus: ConnectorRuntimeStatus;
}

const statusToneClasses: Record<ReturnType<typeof getConnectorStatusMeta>['tone'], string> = {
  connected:
    'border border-[rgba(18,107,56,0.16)] bg-[rgba(22,163,74,0.1)] text-[#126b38] dark:border-[rgba(74,222,128,0.22)] dark:bg-[rgba(22,163,74,0.16)] dark:text-[#86efac]',
  ready:
    'border border-[rgba(64,88,255,0.16)] bg-[rgba(64,88,255,0.08)] text-[#3340b0] dark:border-[rgba(129,140,248,0.24)] dark:bg-[rgba(79,70,229,0.16)] dark:text-[#c7d2fe]',
  manual:
    'border border-[rgba(31,31,30,0.1)] bg-[#f1f0ed] text-[#5f5b52] dark:border-[#4A4A48] dark:bg-[#2f2f2d] dark:text-[#d5d1c8]',
  preview:
    'border border-[rgba(147,110,43,0.14)] bg-[rgba(201,162,39,0.1)] text-[#7a5d17] dark:border-[rgba(250,204,21,0.16)] dark:bg-[rgba(161,98,7,0.18)] dark:text-[#fde68a]',
};

function DetailCard({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-[18px] border border-claude-border bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#30302E]">
      <h3 className="text-[15px] font-medium text-claude-text">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function ConnectorDetailsPanel({
  connector,
  githubUser,
  mcpConfigPath,
  mcpBusy = false,
  onConnectConnector,
  onGithubConnect,
  onGithubDisconnect,
  onInstallConnector,
  onOpenWebsite,
  onUninstallConnector,
  runtimeStatus,
}: ConnectorDetailsPanelProps) {
  const status = getConnectorStatusMeta(connector, runtimeStatus);
  const capabilities = getConnectorCapabilities(connector);
  const setupSteps = getConnectorSetupSteps(connector);
  // 【2026-09-19 修】原来用 `kind === 'native'` 判 GitHub —— 但连接器精简后
  // QQ 也是 native，于是打开 QQ 会显示 GitHub 的详情（断开按钮、OAuth 文案全串了）。
  // 改成按 id 判，语义准确。
  const isGithubConnector = connector.id === 'github';
  const isQqConnector = connector.id === 'qq';
  const isComposioConnector = runtimeStatus.kind === 'composio';
  const supportsInAppInstall = runtimeStatus.kind === 'mcp';

  return (
    <div className="flex h-full flex-col bg-claude-bg">
      <div className="border-b border-claude-border px-8 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-[68px] w-[68px] flex-shrink-0 items-center justify-center rounded-[18px] border border-claude-border bg-white shadow-sm dark:bg-[#30302E]">
              <img src={connector.logo} alt="" aria-hidden="true" className="h-9 w-9 object-contain" />
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="truncate text-[24px] font-semibold tracking-[-0.24px] text-claude-text">
                  {connector.title}
                </h2>
                <span className={`rounded-full px-3 py-1 text-[12px] font-medium ${statusToneClasses[status.tone]}`}>
                  {status.label}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-claude-textSecondary">
                <span>{connector.provider}</span>
                <span aria-hidden="true">•</span>
                <span>{getConnectorInstallMethodLabel(connector)}</span>
                <span aria-hidden="true">•</span>
                <span className="capitalize">{connector.category.replace('-', ' ')}</span>
              </div>

              <p className="mt-4 max-w-[720px] text-[14px] leading-6 text-claude-textSecondary">
                {connector.description}
              </p>
            </div>
          </div>

          {!isGithubConnector && (
            <button
              type="button"
              onClick={() => onOpenWebsite(connector.website)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-claude-border px-4 text-[14px] font-medium text-claude-text transition-colors hover:bg-claude-hover"
            >
              <ExternalLink size={16} />
              打开官网
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <DetailCard title="连接状态">
            <p className="text-[14px] leading-6 text-claude-textSecondary">{status.description}</p>
            {isGithubConnector && runtimeStatus.connected && githubUser && (
              <div className="mt-4 flex items-center gap-3 rounded-[14px] border border-claude-border bg-claude-hover/60 p-3 dark:bg-[#262624]">
                <img
                  src={githubUser.avatar_url}
                  alt={githubUser.login}
                  className="h-10 w-10 rounded-full border border-claude-border object-cover"
                />
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-claude-text">
                    {githubUser.name || githubUser.login}
                  </div>
                  <div className="truncate text-[13px] text-claude-textSecondary">@{githubUser.login}</div>
                </div>
              </div>
            )}
            {isComposioConnector && (
              <div className="mt-4 rounded-[14px] border border-claude-border bg-claude-hover/60 p-3 dark:bg-[#262624]">
                <div className="text-[13px] font-medium text-claude-text">
                  {runtimeStatus.connected
                    ? `Connected via ${runtimeStatus.serverName || 'Composio'}`
                    : runtimeStatus.installed
                      ? `Composio server installed as ${runtimeStatus.serverName || 'composio'}`
                      : 'Shared Composio connector flow available'}
                </div>
                <div className="mt-1 text-[13px] leading-5 text-claude-textSecondary">
                  {mcpConfigPath
                    ? `Claude config: ${mcpConfigPath}`
                    : 'This connector can share a single Composio-managed MCP server with the rest of your supported app catalog.'}
                </div>
              </div>
            )}
            {!isGithubConnector && supportsInAppInstall && (
              <div className="mt-4 rounded-[14px] border border-claude-border bg-claude-hover/60 p-3 dark:bg-[#262624]">
                <div className="text-[13px] font-medium text-claude-text">
                  {runtimeStatus.installed ? `Installed as ${runtimeStatus.serverName}` : 'One-click MCP install available'}
                </div>
                <div className="mt-1 text-[13px] leading-5 text-claude-textSecondary">
                  {mcpConfigPath
                    ? `Claude config: ${mcpConfigPath}`
                    : 'Install writes this connector into your Claude MCP configuration so the connection feels native to the app.'}
                </div>
              </div>
            )}
          </DetailCard>

          <DetailCard title="推荐下一步">
            <ol className="space-y-3">
              {setupSteps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-claude-hover text-[12px] font-medium text-claude-text">
                    {index + 1}
                  </div>
                  <p className="text-[14px] leading-6 text-claude-textSecondary">{step}</p>
                </li>
              ))}
            </ol>
          </DetailCard>

          <DetailCard title="Claude 可以使用此应用完成什么">
            <ul className="space-y-3">
              {capabilities.map(capability => (
                <li key={capability} className="flex gap-3">
                  <div className="mt-[9px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-claude-textSecondary/60" />
                  <p className="text-[14px] leading-6 text-claude-textSecondary">{capability}</p>
                </li>
              ))}
            </ul>
          </DetailCard>

          <DetailCard title="当前版本支持情况">
            <p className="text-[14px] leading-6 text-claude-textSecondary">
              {isGithubConnector
                ? '本项目内置 GitHub 工具集（GitHubRepo / GitHubIssues / GitHubPRs / GitHubFile 等），直接读仓库和 Issue/PR。token 存在本地 github.json，配置在终端执行 /github login。'
                : isQqConnector
                  ? '本项目内置 QQ 桥（QQPush / QQRecall 等工具）。它连接手机上的 NapCat，主人私聊的指令会进入会话、回复自动发回。配置在终端执行 /qq setup。'
                  : '该连接器需要在终端配置。'}
            </p>

            <div className="mt-5 flex flex-wrap gap-3">
              {isGithubConnector ? (
                runtimeStatus.connected ? (
                  <button
                    type="button"
                    onClick={onGithubDisconnect}
                    className="inline-flex h-10 items-center justify-center rounded-[10px] border border-claude-border px-4 text-[14px] font-medium text-claude-text transition-colors hover:bg-claude-hover"
                  >
                    断开 GitHub
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onGithubConnect}
                    className="inline-flex h-10 items-center justify-center rounded-[10px] bg-claude-text px-4 text-[14px] font-medium text-claude-bg transition-opacity hover:opacity-90"
                  >
                    连接 GitHub
                  </button>
                )
              ) : isQqConnector ? (
                /* QQ 桥的开关在终端（/qq on|off），Web 只读状态、给指引。
                   不在这里放「连接」按钮：点了也没法真的启动本地进程，
                   假装能连比没有按钮更让人困惑。 */
                <div className="text-[13px] text-claude-textSecondary">
                  {runtimeStatus.connected
                    ? 'QQ 桥监听中。要关闭请在终端执行 /qq off。'
                    : '在终端执行 /qq setup 配置，然后 /qq on 开启监听。'}
                </div>
              ) : isComposioConnector ? (
                <>
                  <button
                    type="button"
                    disabled={mcpBusy}
                    onClick={onConnectConnector}
                    className="inline-flex h-10 items-center justify-center rounded-[10px] bg-claude-text px-4 text-[14px] font-medium text-claude-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {mcpBusy
                      ? runtimeStatus.connected
                        ? '刷新中…'
                        : '连接中…'
                      : runtimeStatus.connected
                        ? '通过 Composio 重新连接'
                        : '通过 Composio 连接'}
                  </button>
                  {runtimeStatus.installed && (
                    <button
                      type="button"
                      disabled={mcpBusy}
                      onClick={onUninstallConnector}
                      className="inline-flex h-10 items-center justify-center rounded-[10px] border border-claude-border px-4 text-[14px] font-medium text-claude-text transition-colors hover:bg-claude-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {mcpBusy ? '移除中…' : '移除 Composio 服务'}
                    </button>
                  )}
                </>
              ) : supportsInAppInstall ? (
                <>
                  {runtimeStatus.installed ? (
                    <button
                      type="button"
                      disabled={mcpBusy}
                      onClick={onUninstallConnector}
                      className="inline-flex h-10 items-center justify-center rounded-[10px] border border-claude-border px-4 text-[14px] font-medium text-claude-text transition-colors hover:bg-claude-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {mcpBusy ? '移除中…' : '移除连接器'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={mcpBusy}
                      onClick={onInstallConnector}
                      className="inline-flex h-10 items-center justify-center rounded-[10px] bg-claude-text px-4 text-[14px] font-medium text-claude-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {mcpBusy ? '安装中…' : '安装连接器'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenWebsite(connector.website)}
                    className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-claude-border px-4 text-[14px] font-medium text-claude-text transition-colors hover:bg-claude-hover"
                  >
                    <ExternalLink size={16} />
                    打开文档
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenWebsite(connector.website)}
                  className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-claude-text px-4 text-[14px] font-medium text-claude-bg transition-opacity hover:opacity-90"
                >
                  <ExternalLink size={16} />
                  打开设置指南
                </button>
              )}
            </div>
          </DetailCard>
        </div>
      </div>
    </div>
  );
}
