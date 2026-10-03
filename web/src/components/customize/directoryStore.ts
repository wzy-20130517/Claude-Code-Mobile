import {
  connectorCatalog,
  type ConnectorCatalogEntry,
  type ConnectorRuntimeStatus,
} from './connectorCatalog.ts';

export interface DirectorySkillSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isExample?: boolean;
  sourceDir?: string | null;
}

export type DirectorySkillSource = 'official' | 'community' | 'custom';
export type DirectoryConnectorSource = 'official' | 'community' | 'installed';

export interface DirectorySourceTab<TSource extends string> {
  count: number;
  id: TSource;
  label: string;
}

export type DirectorySkillCardAction =
  | 'create-with-claude'
  | 'open-skill'
  | 'upload-skill'
  | 'write-skill-instructions';

export interface DirectorySkillCard {
  action: DirectorySkillCardAction;
  badge: string;
  description: string;
  id: string;
  isEnabled: boolean;
  source: DirectorySkillSource;
  subtitle: string;
  title: string;
}

export interface DirectoryConnectorCard extends ConnectorCatalogEntry {
  isInstalled: boolean;
  source: Exclude<DirectoryConnectorSource, 'installed'>;
}

interface BuildSkillDirectoryCardsOptions {
  examples: readonly DirectorySkillSummary[];
  mySkills: readonly DirectorySkillSummary[];
}

interface FilterDirectoryCardsOptions<TSource extends string> {
  query?: string;
  source?: TSource;
}

interface BuildConnectorDirectoryCardsOptions {
  connectorStatuses: Record<string, ConnectorRuntimeStatus | null | undefined>;
}

const skillSourceLabels: Record<DirectorySkillSource, string> = {
  official: '官方',
  community: '社区',
  custom: '自定义',
};

const connectorSourceLabels: Record<DirectoryConnectorSource, string> = {
  official: '官方',
  community: '社区',
  installed: '已安装',
};

const officialSkillShortcuts: readonly DirectorySkillCard[] = [
  {
    action: 'create-with-claude',
    badge: '内置',
    description: '使用 Claude 引导创建技能草稿，准备好后返回定制工作区继续完善。',
    id: 'create-with-claude',
    isEnabled: false,
    source: 'official',
    subtitle: '引导创建',
    title: '使用 Claude 创建',
  },
  {
    action: 'write-skill-instructions',
    badge: '内置',
    description: '打开结构化编辑器，在一个地方编写本地技能包、提示词、参考资料和辅助文件。',
    id: 'write-skill-instructions',
    isEnabled: false,
    source: 'official',
    subtitle: '手动编写',
    title: '编写技能说明',
  },
  {
    action: 'upload-skill',
    badge: '内置',
    description: '导入现有技能包，并在应用内继续管理，不必离开目录页面。',
    id: 'upload-skill',
    isEnabled: false,
    source: 'official',
    subtitle: '导入包',
    title: '上传技能',
  },
] as const;

function createSkillCard(
  skill: DirectorySkillSummary,
  source: Exclude<DirectorySkillSource, 'official'>,
): DirectorySkillCard {
  return {
    action: 'open-skill',
    badge: skill.enabled ? '已启用' : source === 'custom' ? '草稿' : '可用',
    description: skill.description,
    id: skill.id,
    isEnabled: skill.enabled,
    source,
    subtitle: source === 'custom' ? '我的技能' : '示例技能',
    title: skill.name,
  };
}

function matchesQuery(query: string, fields: readonly string[]) {
  if (!query) {
    return true;
  }

  return fields.some((field) => field.toLowerCase().includes(query));
}

export function buildSkillDirectoryCards({
  examples,
  mySkills,
}: BuildSkillDirectoryCardsOptions): DirectorySkillCard[] {
  return [
    ...officialSkillShortcuts,
    ...examples.map((skill) => createSkillCard(skill, 'community')),
    ...mySkills.map((skill) => createSkillCard(skill, 'custom')),
  ];
}

export function getSkillDirectorySourceTabs(
  cards: readonly DirectorySkillCard[],
): DirectorySourceTab<DirectorySkillSource>[] {
  return (['official', 'community', 'custom'] as const).map((source) => ({
    count: cards.filter((card) => card.source === source).length,
    id: source,
    label: skillSourceLabels[source],
  }));
}

export function filterSkillDirectoryCards(
  cards: readonly DirectorySkillCard[],
  { query = '', source }: FilterDirectoryCardsOptions<DirectorySkillSource>,
): DirectorySkillCard[] {
  const normalizedQuery = query.trim().toLowerCase();

  return cards.filter((card) => {
    if (source && card.source !== source) {
      return false;
    }

    return matchesQuery(normalizedQuery, [
      card.title,
      card.description,
      card.subtitle,
      card.badge,
    ]);
  });
}

function getConnectorPrimarySource(
  _connector: ConnectorCatalogEntry,
  _status?: ConnectorRuntimeStatus | null,
): Exclude<DirectoryConnectorSource, 'installed'> {
  // 【2026-09-19 精简】目录只剩 GitHub / QQ 两个原生连接器（见 connectorCatalog.ts
  // 顶部的说明），没有 composio / mcp 来源了，一律 official。
  // 保留函数是因为 DirectoryConnectorCard 的 source 字段还要用。
  return 'official';
}

function getConnectorInstalledState(
  status?: ConnectorRuntimeStatus | null,
) {
  return Boolean(status?.installed || status?.connected);
}

export function buildConnectorDirectoryCards({
  connectorStatuses,
}: BuildConnectorDirectoryCardsOptions): DirectoryConnectorCard[] {
  return connectorCatalog.map((connector) => ({
    ...connector,
    isInstalled: getConnectorInstalledState(connectorStatuses[connector.id]),
    source: getConnectorPrimarySource(connector, connectorStatuses[connector.id]),
  }));
}

export function getConnectorDirectorySourceTabs(
  cards: readonly DirectoryConnectorCard[],
): DirectorySourceTab<DirectoryConnectorSource>[] {
  return (['official', 'community', 'installed'] as const).map((source) => ({
    count:
      source === 'installed'
        ? cards.filter((card) => card.isInstalled).length
        : cards.filter((card) => card.source === source).length,
    id: source,
    label: connectorSourceLabels[source],
  }));
}

export function filterConnectorDirectoryCards(
  cards: readonly DirectoryConnectorCard[],
  { query = '', source }: FilterDirectoryCardsOptions<DirectoryConnectorSource>,
): DirectoryConnectorCard[] {
  const normalizedQuery = query.trim().toLowerCase();

  return cards.filter((card) => {
    if (source === 'installed' && !card.isInstalled) {
      return false;
    }

    if (source && source !== 'installed' && card.source !== source) {
      return false;
    }

    return matchesQuery(normalizedQuery, [
      card.title,
      card.description,
      card.provider,
      card.label,
      card.category,
    ]);
  });
}
