import React, { useEffect, useState } from 'react';
import { Smartphone, CheckCircle2, XCircle, RefreshCw, HardDrive, Shield, Cpu } from 'lucide-react';

/**
 * CCM 环境面板 —— 只在 Android 原生外壳（CCM）里显示。
 *
 * 【数据来源】
 * 后端 `/api/ccm/status` 会转发查询 Kotlin 侧的桥接服务器（127.0.0.1:3457），
 * 拿到 Shizuku 状态、截屏授权、rootfs 状态等。
 *
 * 【为什么放在设置里】
 * 这些是「环境健康度」信息，不是日常操作。用户偶尔来看一眼
 * 「手机操作为什么不work」，或者确认环境装好了。
 */
interface CcmStatus {
  ok: boolean;
  ccm: boolean;
  env: {
    mode: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    home: string;
    workspace: string | null;
    uptimeSec: number;
    bridgePort: string;
  };
  bridge: {
    ok: boolean;
    error?: string;
    shizuku?: string;
    rootfs_installed?: boolean;
    rootfs_has_usr_bin?: boolean;
    proot_exists?: boolean;
    proot_loader_exists?: boolean;
    node_exists?: boolean;
    kernel_installed?: boolean;
    sdk?: number;
  };
  summary: {
    shizuku: string;
    rootfs: string;
    proot: string;
    node: string;
    kernel: string;
    androidSdk: string;
  } | null;
}

export default function EnvironmentPanel() {
  const [status, setStatus] = useState<CcmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    fetch('/api/ccm/status')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => setStatus(d))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-claude-textSecondary">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>读取环境状态…</span>
      </div>
    );
  }

  if (err) {
    return (
      <div className="text-red-500 text-sm">
        读取失败：{err}
      </div>
    );
  }

  if (!status?.ccm) {
    return (
      <div className="text-claude-textSecondary text-sm">
        当前不是 CCM 原生环境（Termux 或浏览器模式）。
      </div>
    );
  }

  const bridgeOk = status.bridge.ok;
  const s = status.summary;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-claude-text flex items-center gap-2">
            <Smartphone className="w-5 h-5" />
            CCM 原生环境
          </h3>
          <p className="text-sm text-claude-textSecondary mt-1">
            App 内嵌的 Linux 运行时与原生能力状态
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-lg text-sm bg-claude-btn hover:bg-claude-btn-hover text-claude-text flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </button>
      </div>

      {/* 原生桥状态（最关键） */}
      <Section title="原生能力桥" icon={<Shield className="w-4 h-4" />}>
        {bridgeOk ? (
          <>
            <Row label="Shizuku" ok={!!s?.shizuku && !/未/.test(s.shizuku)}
                 value={s?.shizuku || '?'} />
            <Row label="Linux 环境" ok={!!status.bridge.rootfs_installed}
                 value={s?.rootfs || '?'} />
            <Row label="proot 运行时" ok={!!status.bridge.proot_exists && status.bridge.proot_loader_exists !== false}
                 value={s?.proot || '?'} />
            <Row label="Node 运行时" ok={!!status.bridge.node_exists}
                 value={s?.node || '?'} />
            <Row label="CCM 内核" ok={!!status.bridge.kernel_installed}
                 value={s?.kernel || '?'} />
            <Row label="Android SDK" ok={true} value={s?.androidSdk || '?'} />
          </>
        ) : (
          <div className="text-sm text-amber-500">
            未连接（{status.bridge.error || '未知原因'}）
            <div className="text-xs text-claude-textSecondary mt-1">
              可能原因：CCM App 未启动、或核心服务未开启
            </div>
          </div>
        )}
      </Section>

      {/* 运行时信息 */}
      <Section title="运行时" icon={<Cpu className="w-4 h-4" />}>
        <Row label="运行模式" ok={true} value={status.env.mode} />
        <Row label="Node 版本" ok={true} value={status.env.nodeVersion} />
        <Row label="平台" ok={true} value={`${status.env.platform} / ${status.env.arch}`} />
        <Row label="家目录" ok={true} value={status.env.home} />
        {status.env.workspace && (
          <Row label="工作区" ok={true} value={status.env.workspace} />
        )}
        <Row label="已运行" ok={true} value={formatUptime(status.env.uptimeSec)} />
      </Section>

      {/* 提示 */}
      <div className="rounded-lg bg-claude-btn/40 p-4 text-xs text-claude-textSecondary space-y-1">
        <div className="font-medium text-claude-text mb-1">关于这些状态</div>
        <div>· <b>Shizuku</b>：手机操作（点击/输入/读界面）的主力通道，跑在虚拟副屏上不占物理屏。未授权时在 App 主界面点授权。</div>
        <div>· <b>Linux 环境</b>：AI 的工具链（git/python/ffmpeg 等）跑在这里面。</div>
        <div>· <b>proot 运行时</b>：让 Linux 环境无需 root 就能跑。</div>
        <div>· 装更多工具（Python/Rust/PHP/SSH 等）在 App 的「工具链」界面里勾选。</div>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: {
  title: string; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-claude-border p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-claude-text mb-2">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-claude-textSecondary">{label}</span>
      <span className="flex items-center gap-1.5">
        {ok
          ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
          : <XCircle className="w-3.5 h-3.5 text-red-500" />}
        <span className="text-claude-text font-mono text-xs">{value}</span>
      </span>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}
