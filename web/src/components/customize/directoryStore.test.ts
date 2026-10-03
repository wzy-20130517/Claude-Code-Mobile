import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConnectorDirectoryCards,
  buildSkillDirectoryCards,
  filterConnectorDirectoryCards,
  filterSkillDirectoryCards,
  getConnectorDirectorySourceTabs,
  getSkillDirectorySourceTabs,
  type DirectorySkillSummary,
} from './directoryStore.ts';
import type { ConnectorRuntimeStatus } from './connectorCatalog.ts';

const exampleSkills: DirectorySkillSummary[] = [
  {
    id: 'skill-creator',
    name: 'Skill Creator',
    description: 'Scaffold a production-ready skill package.',
    enabled: true,
    isExample: true,
    sourceDir: 'skill-creator',
  },
  {
    id: 'research-assistant',
    name: 'Research Assistant',
    description: 'Summarize notes and extract insights.',
    enabled: false,
    isExample: true,
    sourceDir: 'research-assistant',
  },
];

const customSkills: DirectorySkillSummary[] = [
  {
    id: 'team-playbook',
    name: 'Team Playbook',
    description: 'Internal process notes for product launches.',
    enabled: true,
    sourceDir: 'team-playbook',
  },
];

test('skill directory cards expose official shortcuts plus real community/custom entries', () => {
  const cards = buildSkillDirectoryCards({
    examples: exampleSkills,
    mySkills: customSkills,
  });

  const sourceTabs = getSkillDirectorySourceTabs(cards);
  const officialCards = filterSkillDirectoryCards(cards, {
    source: 'official',
  });
  const communityCards = filterSkillDirectoryCards(cards, {
    source: 'community',
  });
  const customCards = filterSkillDirectoryCards(cards, {
    source: 'custom',
  });

  assert.equal(sourceTabs.length, 3);
  assert.deepEqual(
    sourceTabs.map((tab) => [tab.id, tab.count]),
    [
      ['official', 3],
      ['community', 2],
      ['custom', 1],
    ],
  );

  assert.deepEqual(
    officialCards.map((card) => card.id),
    ['create-with-claude', 'write-skill-instructions', 'upload-skill'],
  );
  assert.deepEqual(
    communityCards.map((card) => card.id),
    ['skill-creator', 'research-assistant'],
  );
  assert.deepEqual(customCards.map((card) => card.id), ['team-playbook']);

  const searchResults = filterSkillDirectoryCards(cards, {
    query: 'upload',
    source: 'official',
  });
  assert.deepEqual(searchResults.map((card) => card.id), ['upload-skill']);
});

test('连接器目录卡片：精简后只剩 GitHub + QQ，两者都归 official', () => {
  // 【2026-09-19 重写】原测试造了 notion / slack / figma 三个 composio 连接器的状态，
  // 断言 official 12 / community 16 / installed 3 这些数字。
  // 目录精简为 GitHub + QQ（见 connectorCatalog.ts 顶部说明）后，
  // 那些连接器不存在了，source 也只剩 official（getConnectorPrimarySource 恒返回 official）。
  const connectorStatuses: Record<string, ConnectorRuntimeStatus> = {
    github: { available: true, connected: true, installed: true, kind: 'native' },
    qq: { available: true, connected: false, installed: false, kind: 'native' },
  };

  const cards = buildConnectorDirectoryCards({ connectorStatuses });
  assert.equal(cards.length, 2, '目录应该只有 2 个连接器');

  const sourceTabs = getConnectorDirectorySourceTabs(cards);
  const officialCards = filterConnectorDirectoryCards(cards, { source: 'official' });
  const installedCards = filterConnectorDirectoryCards(cards, { source: 'installed' });

  assert.deepEqual(officialCards.map(c => c.id).sort(), ['github', 'qq']);
  // github 已连接 → installed 视图里有它；qq 未连接 → 不在
  assert.deepEqual(installedCards.map(c => c.id), ['github']);

  // official tab 计数 = 全部（精简后没有 community 来源）
  const officialTab = sourceTabs.find(t => t.id === 'official');
  assert.ok(officialTab, '应该有 official tab');
  assert.equal(officialTab.count, 2);

  // 搜索：按标题命中
  const searchResults = filterConnectorDirectoryCards(cards, { query: 'github', source: 'official' });
  assert.deepEqual(searchResults.map(c => c.id), ['github']);
});
