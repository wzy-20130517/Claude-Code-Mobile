// 连接器目录测试
//
// 【2026-09-19 重写】原测试断言的是旧行为：
//   · connectorCatalog.length >= 20（原来是 28 个上游商业版连接器）
//   · 必须包含 google-drive / slack / notion / jira / linear
//   · 状态标签是英文（'Connected' / 'Ready to connect' / 'Manual setup'）
//
// 用户要求「把里面无用的删掉，换成我们支持的 github 和 QQ」，
// 目录精简为 2 个**真的有实现**的连接器，所以这些断言全部作废。
//
// 新测试锁住的是「精简后的正确性」：
//   1. 目录里只有真的能用的（防止有人手滑加回摆设）
//   2. 每个条目都有配置命令（用户知道去哪儿配）
//   3. 状态判定按 statusSource 分流（GitHub 和 QQ 各读各的）

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectorCatalog,
  getConnectorRuntimeStatus,
  getConnectorCapabilities,
  getConnectorSetupSteps,
  getConnectorStatusMeta,
} from './connectorCatalog.ts';

test('目录只含真正有实现的连接器（GitHub + QQ）', () => {
  const ids = connectorCatalog.map(c => c.id).sort();
  assert.deepEqual(ids, ['github', 'qq'], `目录被改动了，实际是: ${ids.join(', ')}`);

  // 防止有人把上游那批摆设加回来 —— 它们点了没反应，比没有更糟。
  const banned = ['slack', 'notion', 'jira', 'linear', 'google-drive', 'figma', 'airtable'];
  for (const id of banned) {
    assert.ok(
      !connectorCatalog.some(c => c.id === id),
      `${id} 是上游商业版连接器，本机连不上，不该出现在目录里`
    );
  }
});

test('每个条目字段完整（渲染详情面板需要）', () => {
  const ids = new Set<string>();
  for (const connector of connectorCatalog) {
    assert.ok(connector.title.length > 0, `missing title for ${connector.id}`);
    assert.ok(connector.description.length > 0, `missing description for ${connector.id}`);
    assert.ok(connector.logo.endsWith('.svg'), `expected local svg logo for ${connector.id}`);
    assert.ok(connector.website.startsWith('https://'), `missing website for ${connector.id}`);
    assert.ok(!ids.has(connector.id), `duplicate connector id ${connector.id}`);
    ids.add(connector.id);
  }
});

test('每个条目都给了配置命令和状态来源', () => {
  // 这两个字段是精简时加的：用户点「待连接」要知道去哪儿配，
  // 状态判定要知道读哪份配置。
  for (const connector of connectorCatalog) {
    assert.ok(
      typeof connector.configCommand === 'string' && connector.configCommand.startsWith('/'),
      `${connector.id} 缺少 configCommand（用户不知道去哪儿配置）`
    );
    assert.ok(
      ['github', 'qq'].includes(connector.statusSource),
      `${connector.id} 的 statusSource 非法: ${connector.statusSource}`
    );
  }
});

test('能力与配置步骤都够写满详情面板', () => {
  for (const connector of connectorCatalog) {
    const capabilities = getConnectorCapabilities(connector);
    const setupSteps = getConnectorSetupSteps(connector);
    assert.ok(capabilities.length >= 2, `${connector.id} 至少要有 2 条能力说明`);
    assert.ok(setupSteps.length >= 2, `${connector.id} 至少要有 2 步配置说明`);
  }
});

test('GitHub 连接状态跟随 githubConnected', () => {
  const github = connectorCatalog.find(c => c.id === 'github')!;

  const connected = getConnectorStatusMeta(
    github,
    getConnectorRuntimeStatus({ connector: github, githubConnected: true }),
  );
  assert.equal(connected.label, '已连接');

  const disconnected = getConnectorStatusMeta(
    github,
    getConnectorRuntimeStatus({ connector: github, githubConnected: false }),
  );
  assert.equal(disconnected.label, '待连接');
  // 未连接时要告诉用户去哪儿配
  assert.ok(disconnected.description.includes(github.configCommand), '提示里应包含配置命令');
});

test('QQ 连接状态跟随 qqConnected（不串到 GitHub）', () => {
  const qq = connectorCatalog.find(c => c.id === 'qq')!;

  // 关键：GitHub 连上了，QQ 也该显示未连接 —— 两者状态互不影响。
  const qqWithGithubOn = getConnectorStatusMeta(
    qq,
    getConnectorRuntimeStatus({ connector: qq, githubConnected: true, qqConnected: false }),
  );
  assert.equal(qqWithGithubOn.label, '待连接', 'QQ 状态不该被 githubConnected 影响');

  const qqOn = getConnectorStatusMeta(
    qq,
    getConnectorRuntimeStatus({ connector: qq, qqConnected: true }),
  );
  assert.equal(qqOn.label, '已连接');
});

test('运行时状态一律是 native（没有 composio/mcp 来源了）', () => {
  for (const connector of connectorCatalog) {
    const status = getConnectorRuntimeStatus({ connector });
    assert.equal(status.kind, 'native', `${connector.id} 应该是原生连接器`);
    assert.equal(status.available, true);
  }
});

test('安装方式标签对两个连接器都返回原生', () => {
  for (const connector of connectorCatalog) {
    const status = getConnectorRuntimeStatus({ connector });
    assert.equal(status.kind, 'native');
  }
});
