// 连接器目录
//
// 【2026-09-19 精简】原文件是 28 个连接器（Airtable / Slack / Notion / Jira / Figma …），
// 全部来自上游 fork 的商业版目录，本机**一个都连不上** —— 它们依赖 Composio 托管鉴权
// 或第三方 MCP server，这个自部署版本两者都没有。
//
// 用户要求：「web 里有个连接器功能？把里面无用的删掉，换成我们支持的 github 和 QQ」。
//
// 现在只保留**真的能用**的两个：
//   · GitHub —— 原生流程，/github login 设 token，GitHubRepo / GitHubIssues / GitHubPRs 等工具
//   · QQ     —— 本地桥，/qq setup 配置，QQPush / QQRecall 工具 + 消息自动收发
//
// 判定「真的能用」的标准：**点了按钮有代码路径接住**。
// 原来那 26 个点进去只会显示「手动配置 / 待安装」然后什么都不发生 ——
// 比没有更糟（用户会以为是自己配错了）。

import type { ConnectorComposioStatus, ConnectorMcpStatus } from '../../api';

const connectorLogo = (fileName: string) =>
  new URL(`../../assets/customize/connectors/${fileName}`, import.meta.url).href;

const githubLogo = connectorLogo('github.svg');
const qqLogo = connectorLogo('qq.svg');

/** 连接器的实际处理路径。只有这两个值有意义，其余一律走「未实现」提示。 */
export type ConnectorAction = 'github' | 'qq';

export type ConnectorCategory = 'developer-tools' | 'communication';

/** native = 本项目内有完整实现（点按钮真的会做事）。 */
export type ConnectorInstallMethod = 'native';

export interface ConnectorCatalogEntry {
  id: string;
  title: string;
  provider: string;
  label: string;
  description: string;
  logo: string;
  category: ConnectorCategory;
  installMethod: ConnectorInstallMethod;
  action?: ConnectorAction;
  website: string;
  /** 配置用的 slash 命令（面板上直接展示，省得用户去翻帮助）。 */
  configCommand: string;
  /** 配置状态从哪读（供运行时状态判定）。 */
  statusSource: 'github' | 'qq';
}

export const connectorCatalog = [
  {
    id: 'github',
    title: 'GitHub',
    provider: 'GitHub',
    label: '已内置',
    description: '连接仓库、Pull Request、Issue。配置 token 后可用 GitHubRepo / GitHubIssues / GitHubPRs / GitHubFile 等工具读写仓库。',
    logo: githubLogo,
    category: 'developer-tools',
    installMethod: 'native',
    action: 'github',
    website: 'https://github.com/',
    configCommand: '/github login',
    statusSource: 'github',
  },
  {
    id: 'qq',
    title: 'QQ',
    provider: 'QQ 桥',
    label: '已内置',
    description: '通过本地 QQ 桥收发消息。配置后可以用 QQPush 主动推送、QQRecall 回溯群消息，主人私聊的指令会直接进入会话。',
    logo: qqLogo,
    category: 'communication',
    installMethod: 'native',
    action: 'qq',
    website: 'https://im.qq.com/',
    configCommand: '/qq setup',
    statusSource: 'qq',
  },
] as const;

export type ConnectorId = (typeof connectorCatalog)[number]['id'];

export interface ConnectorStatusMeta {
  label: string;
  description: string;
  tone: 'connected' | 'ready' | 'manual' | 'preview';
}

export interface ConnectorRuntimeStatus {
  available: boolean;
  configured?: boolean;
  connected: boolean;
  connectedAccountId?: string | null;
  installed: boolean;
  kind: 'native' | 'mcp' | 'composio' | 'manual';
  serverName?: string | null;
}

const connectorSpecificCapabilities: Record<string, readonly string[]> = {
  github: [
    '读取仓库结构、文件内容、提交历史，不用本地 clone。',
    '列出与查看 Issue、PR 及其评审意见。',
    '在 Issue / PR 下发表评论、新建 Issue。',
  ],
  qq: [
    '主人私聊的指令直接进入会话，回复自动发回。',
    'QQPush 主动推送文本、图片或文件到你的手机。',
    'QQRecall 回溯最近的群消息（含图片），用于「看下刚才群里那张图」。',
  ],
};

const connectorSpecificSetup: Record<string, readonly string[]> = {
  github: [
    '在终端执行 /github login，按提示粘贴 Personal Access Token（需要 repo 权限）。',
    '用 /github repo <owner/name> 配一个常用仓库，之后工具不传 repo 就用它。',
    '执行 /github test 验证连通性，状态变为「已连接」即完成。',
  ],
  qq: [
    '确保手机上的 NapCat 已登录，且 API 端口可访问（默认 http://127.0.0.1:5700）。',
    '在终端执行 /qq setup 走一遍向导（主人号 / 端口 / API 地址）。',
    '执行 /qq on 开启监听，/qq status 确认状态。',
  ],
};

export function getConnectorCatalogEntry(id: ConnectorId): ConnectorCatalogEntry | undefined {
  return connectorCatalog.find(connector => connector.id === id);
}

export function getConnectorRuntimeStatus({
  connector,
  githubConnected = false,
  qqConnected = false,
}: {
  connector: ConnectorCatalogEntry;
  /** 兼容旧签名保留的字段 —— 精简后不再使用，但调用方可能还在传 */
  composioConfigured?: boolean;
  composioStatus?: ConnectorComposioStatus | null;
  githubConnected?: boolean;
  mcpStatus?: ConnectorMcpStatus | null;
  qqConnected?: boolean;
}): ConnectorRuntimeStatus {
  // 两个连接器都是「原生」：本项目内有完整代码路径。
  const connected = connector.statusSource === 'github' ? githubConnected : qqConnected;
  return {
    available: true,
    configured: connected,
    connected,
    installed: connected,
    kind: 'native',
    serverName: null,
  };
}

export function getConnectorCapabilities(connector: ConnectorCatalogEntry): readonly string[] {
  return connectorSpecificCapabilities[connector.id] ?? [];
}

export function getConnectorSetupSteps(connector: ConnectorCatalogEntry): readonly string[] {
  return connectorSpecificSetup[connector.id] ?? [];
}

export function getConnectorStatusMeta(
  connector: ConnectorCatalogEntry,
  runtimeStatus?: Partial<ConnectorRuntimeStatus>,
): ConnectorStatusMeta {
  const status: ConnectorRuntimeStatus = {
    available: true,
    configured: false,
    connected: false,
    installed: false,
    kind: 'native',
    ...runtimeStatus,
  };

  if (status.connected) {
    return {
      label: '已连接',
      description: connector.id === 'github'
        ? 'GitHub token 已配置，仓库 / Issue / PR 工具可用。'
        : 'QQ 桥已开启，消息收发与推送工具可用。',
      tone: 'connected',
    };
  }

  return {
    label: '待连接',
    description: `还没配置。在终端执行 ${connector.configCommand} 即可。`,
    tone: 'ready',
  };
}

export function getConnectorInstallMethodLabel(_connector: ConnectorCatalogEntry): string {
  // 精简后只剩原生连接器，但保留函数签名（ConnectorDetailsPanel 在用）。
  return '原生连接器';
}
