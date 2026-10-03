import React, { useState, useEffect } from 'react';
import { ChevronLeft, FolderOpen } from 'lucide-react';
import ClaudeLogo from './ClaudeLogo';
import { getWorkspace, listWorkspaceDirectories, saveWorkspace, WorkspaceListing } from '../api';

interface OnboardingProps {
  onComplete: () => void;
}

const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as any) || 'system';
  });
  const [workspace, setWorkspace] = useState('/data/data/com.termux/files/home/claude-code-mobile');
  const [directoryListing, setDirectoryListing] = useState<WorkspaceListing | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getWorkspace().then(({ workspacePath }) => setWorkspace(workspacePath)).catch(() => {});
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    setDirectoryLoading(true);
    setWorkspaceError('');
    listWorkspaceDirectories(workspace)
      .then(setDirectoryListing)
      .catch(error => setWorkspaceError(error?.message || '无法读取目录'))
      .finally(() => setDirectoryLoading(false));
  }, [step, workspace]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else if (theme === 'light') root.classList.remove('dark');
    else {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) root.classList.add('dark');
      else root.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const handleFinish = async () => {
    setSaving(true);
    setWorkspaceError('');
    try {
      const saved = await saveWorkspace(workspace.trim());
      localStorage.setItem('theme', theme);
      localStorage.setItem('user_mode', 'selfhosted');
      localStorage.setItem('onboarding_done', 'true');
      localStorage.setItem('workspace_path', saved.workspacePath);
      onComplete();
    } catch (error: any) {
      setWorkspaceError(error?.message || '工作目录无效');
    } finally {
      setSaving(false);
    }
  };

  const presetPaths = [
    { label: '项目根目录', path: '/data/data/com.termux/files/home/claude-code-mobile' },
    { label: 'Termux 主目录', path: '/data/data/com.termux/files/home' },
    { label: 'SD 卡', path: '/sdcard' },
  ];

  const themeCards = [
    { 
      id: 'system' as const, 
      label: '跟随系统',
      preview: (
        <div className="w-full h-[80px] rounded-lg overflow-hidden flex">
          <div className="flex-1 bg-[#F8F8F6] flex items-end p-2"><div className="w-full h-3 rounded bg-[#E8E5DE]"/></div>
          <div className="flex-1 bg-[#2A2A28] flex items-end p-2"><div className="w-full h-3 rounded bg-[#3A3A38]"/></div>
        </div>
      )
    },
    { 
      id: 'light' as const, 
      label: '浅色',
      preview: (
        <div className="w-full h-[80px] rounded-lg bg-[#F8F8F6] flex flex-col justify-end p-2 gap-1.5">
          <div className="w-[70%] h-2.5 rounded bg-[#E8E5DE]"/>
          <div className="w-[45%] h-2.5 rounded bg-[#E8E5DE]"/>
        </div>
      )
    },
    { 
      id: 'dark' as const, 
      label: '深色',
      preview: (
        <div className="w-full h-[80px] rounded-lg bg-[#1A1A18] flex flex-col justify-end p-2 gap-1.5">
          <div className="w-[70%] h-2.5 rounded bg-[#2E2E2C]"/>
          <div className="w-[45%] h-2.5 rounded bg-[#2E2E2C]"/>
        </div>
      )
    },
  ];

  return (
    <div className="fixed inset-0 z-[999] bg-claude-bg flex flex-col select-none overflow-hidden">
      <style>{`
        @keyframes onboarding-fade-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .onboarding-card {
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .onboarding-card:hover {
          transform: translateY(-2px);
        }
        .onboarding-card-selected {
          box-shadow: 0 0 0 2px rgba(217, 119, 87, 0.35), 0 8px 24px -8px rgba(217, 119, 87, 0.15);
        }
      `}</style>

      <div className="flex-1 flex flex-col items-center justify-center px-6 relative">
        <div className="flex flex-col items-center mb-10">
          <div className="w-[42px] h-[42px] mb-4">
            <ClaudeLogo color="#D97757" maxScale={0.15} />
          </div>
          <h1 className="text-[15px] tracking-[0.12em] uppercase text-claude-textSecondary/60 font-medium">
            欢迎使用 Claude Code Mobile
          </h1>
        </div>

        <div className="w-full max-w-[560px]" style={{ animation: 'onboarding-fade-in 0.4s ease' }}>
          {step === 0 && (
            <div className="flex flex-col items-center">
              <h2 className="text-[24px] font-semibold text-claude-text tracking-[-0.02em] mb-1.5">
                选择外观
              </h2>
              <p className="text-[14px] text-claude-textSecondary mb-7">
                选择界面主题，之后可以在设置中随时更改
              </p>
              <div className="flex gap-3 w-full max-w-[420px]">
                {themeCards.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className={`onboarding-card flex-1 flex flex-col gap-2.5 p-3 rounded-xl border transition-all ${
                      theme === t.id
                        ? 'border-[#D97757]/60 onboarding-card-selected bg-claude-bg'
                        : 'border-claude-border/60 hover:border-claude-textSecondary/20 bg-claude-bg'
                    }`}
                  >
                    {t.preview}
                    <span className={`text-[13px] font-medium text-center ${
                      theme === t.id ? 'text-[#D97757]' : 'text-claude-textSecondary'
                    }`}>
                      {t.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col items-center">
              <h2 className="text-[24px] font-semibold text-claude-text tracking-[-0.02em] mb-1.5">
                工作目录
              </h2>
              <p className="text-[14px] text-claude-textSecondary mb-7">
                Claude 将在此文件夹中读写项目文件
              </p>

              <div className="w-full max-w-[480px] space-y-3">
                {workspaceError && <div className="text-[12px] text-red-600 dark:text-red-400">{workspaceError}</div>}

                <div className="flex items-center gap-2 rounded-lg border border-claude-border/60 bg-claude-hover/40 px-3 py-2">
                  <FolderOpen size={16} className="text-[#D97757] flex-shrink-0" />
                  <span className="text-[12px] text-claude-text truncate flex-1" title={workspace}>{workspace}</span>
                  {directoryListing?.parentPath && (
                    <button type="button" onClick={() => setWorkspace(directoryListing.parentPath!)} className="p-1 rounded hover:bg-claude-hover text-claude-textSecondary" title="返回上一级">
                      <ChevronLeft size={16} />
                    </button>
                  )}
                </div>

                {/* 预设路径 */}
                <div className="space-y-2">
                  {presetPaths.map((preset) => (
                    <button
                      key={preset.path}
                      onClick={() => setWorkspace(preset.path)}
                      className={`onboarding-card w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                        workspace === preset.path
                          ? 'border-[#D97757]/60 onboarding-card-selected bg-claude-bg'
                          : 'border-claude-border/60 hover:border-claude-textSecondary/20 bg-claude-bg'
                      }`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        workspace === preset.path ? 'bg-[#D97757]/10' : 'bg-claude-hover'
                      }`}>
                        <FolderOpen size={18} className={workspace === preset.path ? 'text-[#D97757]' : 'text-claude-textSecondary'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[13.5px] font-medium ${workspace === preset.path ? 'text-[#D97757]' : 'text-claude-text'}`}>
                          {preset.label}
                        </div>
                        <div className="text-[11.5px] text-claude-textSecondary/60 truncate">
                          {preset.path}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                {/* 目录浏览 */}
                <div className="rounded-xl border border-claude-border/60 overflow-hidden">
                  <div className="px-3 py-2 text-[11px] text-claude-textSecondary/70 border-b border-claude-border/50">选择此目录下的文件夹</div>
                  <div className="max-h-[130px] overflow-y-auto">
                    {directoryLoading ? (
                      <div className="px-3 py-3 text-[12px] text-claude-textSecondary">正在读取目录…</div>
                    ) : directoryListing?.entries.length ? directoryListing.entries.map(entry => (
                      <button key={entry.path} type="button" onClick={() => setWorkspace(entry.path)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-claude-hover transition-colors">
                        <FolderOpen size={15} className="text-claude-textSecondary flex-shrink-0" />
                        <span className="text-[12.5px] text-claude-text truncate">{entry.name}</span>
                      </button>
                    )) : (
                      <div className="px-3 py-3 text-[12px] text-claude-textSecondary">没有可用的子目录</div>
                    )}
                  </div>
                </div>

                {/* 自定义路径输入 */}
                <div className="pt-2">
                  <label className="text-[12px] text-claude-textSecondary/70 mb-2 block">
                    或输入自定义路径：
                  </label>
                  <input
                    type="text"
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                    placeholder="/path/to/workspace"
                    className="w-full px-3 py-2.5 rounded-lg border border-claude-border/60 bg-claude-bg text-claude-text text-[13.5px] focus:border-[#D97757]/60 focus:outline-none transition-colors"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-8 pb-8 flex items-center justify-between max-w-[640px] w-full mx-auto">
        {step === 0 ? (
          <div className="invisible">占位</div>
        ) : (
          <button
            onClick={() => setStep(0)}
            className="text-[13.5px] text-claude-textSecondary hover:text-claude-text transition-colors py-2 px-3 rounded-lg hover:bg-claude-hover"
          >
            上一步
          </button>
        )}

        <div className="flex items-center gap-1.5">
          {[0, 1].map(i => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-6 bg-claude-text' : 'w-1.5 bg-claude-border'
              }`}
            />
          ))}
        </div>

        <button
          onClick={() => step === 0 ? setStep(1) : handleFinish()}
          disabled={saving}
          className="text-[13.5px] font-medium py-2.5 px-6 rounded-lg transition-all duration-200 text-white bg-[#333] dark:bg-[#e0e0e0] dark:text-[#1a1a1a] hover:bg-[#444] dark:hover:bg-[#ccc] shadow-sm hover:shadow disabled:opacity-50"
        >
          {step === 0 ? '继续' : saving ? '保存中…' : '开始使用'}
        </button>
      </div>
    </div>
  );
};

export default Onboarding;
