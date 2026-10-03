import React, { useState, useEffect, useCallback, useRef } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation, useParams, useNavigate } from 'react-router-dom';
import { FileText, ChevronDown, Trash, Pencil, Star, BellRing, Menu, Folder, ArrowLeft, ArrowRight } from 'lucide-react';
import Sidebar from './src/components/Sidebar';
import MainContent from './src/components/MainContent';
import { IconSidebarToggle } from './src/components/Icons';
import { useIsMobile } from './src/hooks/useIsMobile';
import { updateConversation, deleteConversation, exportConversation, openConversationFolder, getUnreadAnnouncements, markAnnouncementRead, getSystemStatus } from './src/api';
import GitBashRequiredModal from './src/components/GitBashRequiredModal';
import Auth from './src/components/Auth';
import Onboarding from './src/components/Onboarding';
import SettingsPage from './src/components/SettingsPage';
import ErrorBoundary from './src/components/ErrorBoundary';
import UpgradePlan from './src/components/UpgradePlan';
import DocumentPanel from './src/components/DocumentPanel';
import ArtifactsPanel from './src/components/ArtifactsPanel';
import ArtifactsPage from './src/components/ArtifactsPage';
import DraggableDivider from './src/components/DraggableDivider';
import { DocumentInfo } from './src/components/DocumentCard';
import AdminLayout from './src/components/admin/AdminLayout';
// 管理后台是唯一用到 recharts（约 390KB）的地方，普通用户访问不到，
// 改成路由级懒加载，把图表库移出首屏。
const AdminDashboard = React.lazy(() => import('./src/components/admin/AdminDashboard'));
import AdminKeyPool from './src/components/admin/AdminKeyPool';
import AdminUsers from './src/components/admin/AdminUsers';
import AdminPlans from './src/components/admin/AdminPlans';
import AdminRedemption from './src/components/admin/AdminRedemption';
import AdminModels from './src/components/admin/AdminModels';
import AdminAnnouncements from './src/components/admin/AdminAnnouncements';
import ChatsPage from './src/components/ChatsPage';
import CustomizePage from './src/components/CustomizePage';
import ProjectsPage from './src/components/ProjectsPage';
import CoworkPage from './src/components/CoworkPage';
import ScheduledPage from './src/components/ScheduledPage';

const Tooltip = ({ children, text, shortcut }: { children: React.ReactNode; text: string; shortcut?: string }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[200] pointer-events-none">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap bg-[#2a2a2a] text-white dark:bg-[#e8e8e8] dark:text-[#1a1a1a] shadow-lg">
            <span>{text}</span>
            {shortcut && <span className="opacity-60 text-[11px]">{shortcut}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

const ChatHeader = ({
  title,
  showArtifacts,
  documentPanelDoc,
  onOpenArtifacts,
  hasArtifacts,
  onTitleRename
}: {
  title: string;
  showArtifacts: boolean;
  documentPanelDoc: any;
  onOpenArtifacts: () => void;
  hasArtifacts: boolean;
  onTitleRename?: (newTitle: string) => void;
}) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  const startEditing = () => {
    setEditTitle(title || 'New Chat');
    setIsEditing(true);
    setShowMenu(false);
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteConversation(id);
      navigate('/');
      // Trigger sidebar refresh
      window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
    setShowMenu(false);
  };

  const handleRenameSubmit = async () => {
    if (!id || !editTitle.trim()) {
      setIsEditing(false);
      return;
    }

    try {
      await updateConversation(id, { title: editTitle });
      onTitleRename?.(editTitle);
      window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
    } catch (err) {
      console.error('Failed to rename chat:', err);
    } finally {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return (
    <div
      data-chrome="topbar"
      className="relative flex items-center justify-between px-3 py-2 bg-claude-bg flex-shrink-0 h-[44px] border-b border-claude-border z-40"
    >
      {isEditing ? (
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleKeyDown}
          autoFocus
          className="max-w-[60%] px-2 py-1 text-[14px] font-medium text-claude-text bg-claude-input border border-blue-500 rounded-md outline-none shadow-sm"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
      ) : (
        <div className="relative flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={startEditing}
            className="flex items-center px-2 py-1.5 hover:bg-claude-btn-hover rounded-md transition-colors text-[14px] font-medium text-claude-text max-w-[200px] truncate group"
          >
            {title || 'New Chat'}
          </button>

          <button
            ref={buttonRef}
            onClick={() => setShowMenu(!showMenu)}
            className={`p-1 hover:bg-claude-btn-hover rounded-md transition-colors text-claude-textSecondary hover:text-claude-text ${showMenu ? 'bg-claude-btn-hover text-claude-text' : ''}`}
          >
            <ChevronDown size={14} />
          </button>

          {showMenu && (
            <div
              ref={menuRef}
              className="absolute top-full left-0 mt-1 z-50 bg-claude-input border border-claude-border rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.08)] py-1.5 flex flex-col w-[200px]"
            >
              <button className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group">
                <Star size={16} className="text-claude-textSecondary group-hover:text-claude-text" />
                <span className="text-[13px] text-claude-text">Star</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startEditing();
                }}
                className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group"
              >
                <Pencil size={16} className="text-claude-textSecondary group-hover:text-claude-text" />
                <span className="text-[13px] text-claude-text">Rename</span>
              </button>
              <div className="h-[1px] bg-claude-border my-1 mx-3" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group"
              >
                <Trash size={16} className="text-[#B9382C]" />
                <span className="text-[13px] text-[#B9382C]">Delete</span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        {hasArtifacts && (
          <button
            onClick={onOpenArtifacts}
            className={`w-10 h-10 flex items-center justify-center text-claude-textSecondary hover:bg-claude-btn-hover rounded-lg transition-colors ${showArtifacts ? 'bg-claude-btn-hover text-claude-text' : ''}`}
            title="View Artifacts"
          >
            <FileText size={20} strokeWidth={1.5} />
          </button>
        )}
        <button
          className="w-10 h-10 flex items-center justify-center text-claude-textSecondary hover:text-claude-text hover:bg-claude-btn-hover rounded-lg transition-colors"
          title="Open Workspace Folder"
          onClick={async () => {
            if (!id) return;
            // 【为什么不是"打开文件管理器"】Android 11+ 没有任何 App 能处理「打开目录」
            // 的 Intent（实测 termux-open / termux-open-url 都返回成功但无界面，
            // 属于系统 scoped storage 限制）。这里改成：把路径复制到剪贴板并显示出来，
            // 用户能粘到文件管理器地址栏 / Termux / 任何地方 —— 至少按钮有实际作用。
            try {
              const data = await openConversationFolder(id);
              const dir = data?.dir || '';
              if (!dir) throw new Error('服务端没有返回目录路径');
              let copied = false;
              try {
                await navigator.clipboard.writeText(dir);
                copied = true;
              } catch {
                // 非 HTTPS / 无权限时 clipboard API 不可用，退回到 prompt（可手动复制）
              }
              if (copied) {
                window.alert(`工作目录已复制到剪贴板：\n\n${dir}`);
              } else {
                window.prompt('工作目录（手动复制）：', dir);
              }
            } catch (e) {
              console.error('Open folder failed:', e);
              window.alert(e instanceof Error ? e.message : '获取目录失败');
            }
          }}
        >
          <Folder size={20} strokeWidth={1.5} />
        </button>
        <button
          onClick={async () => {
            if (!id || isExporting) return;
            setIsExporting(true);
            try {
              await exportConversation(id);
            } catch (err) {
              console.error('导出失败', err);
              window.alert(err instanceof Error ? err.message : '导出失败');
            } finally {
              setIsExporting(false);
            }
          }}
          disabled={isExporting}
          className="px-4 h-10 text-[14px] font-medium text-claude-textSecondary hover:bg-claude-btn-hover rounded-lg transition-colors border border-claude-border/60 hover:border-claude-border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isExporting ? '导出中…' : 'Export'}
        </button>
      </div>
      <div className="absolute top-full left-0 right-0 h-6 bg-gradient-to-b from-claude-bg to-transparent pointer-events-none z-30" />
    </div>
  );
};

const Layout = () => {
  const [unreadAnnouncements, setUnreadAnnouncements] = useState<Array<{
    id: number;
    title: string;
    content: string;
    created_at: string;
    updated_at?: string;
  }>>([]);
  const [activeAnnouncementId, setActiveAnnouncementId] = useState<number | null>(null);
  const [isMarkingAnnouncementRead, setIsMarkingAnnouncementRead] = useState(false);
  // 移动端（<768px）默认收起侧边栏，把屏宽留给对话；桌面端维持原有展开行为。
  const isMobile = useIsMobile();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768
  );
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [newChatKey, setNewChatKey] = useState(0);
  const [authChecked, setAuthChecked] = useState(true);
  const [authValid, setAuthValid] = useState(() => {
    // Electron + clawparrot mode without gateway key → need login. Other cases pass.
    if (!(window as any).electronAPI?.isElectron) return true;
    const mode = localStorage.getItem('user_mode');
    const hasGatewayKey = !!(localStorage.getItem('ANTHROPIC_API_KEY') && localStorage.getItem('gateway_user'));
    return !(mode === 'clawparrot' && !hasGatewayKey);
  });
  const [showSettings, setShowSettings] = useState(false);
  // 打开设置前的页面路径，关闭时还原（用户从 /projects 进设置，关掉该回 /projects）
  const pathBeforeSettingsRef = useRef<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('onboarding_done'));
  const [needsGitBash, setNeedsGitBash] = useState(false);

  // Check for git-bash on Windows (required by Claude Code SDK)
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const status = await getSystemStatus();
        if (cancelled) return;
        if (status.gitBash.required && !status.gitBash.found) {
          setNeedsGitBash(true);
        }
      } catch {
        // Bridge server not ready yet — retry shortly
        if (!cancelled) setTimeout(check, 1500);
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  // Document panel state
  const [documentPanelDoc, setDocumentPanelDoc] = useState<DocumentInfo | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifacts, setArtifacts] = useState<DocumentInfo[]>([]);
  const [documentPanelWidth, setDocumentPanelWidth] = useState(50); // percent of remaining space (1:1 default)
  const [isChatMode, setIsChatMode] = useState(false);
  const [currentChatTitle, setCurrentChatTitle] = useState('');
  const sidebarWasCollapsedRef = useRef(false);
  const contentContainerRef = useRef<HTMLDivElement>(null);

  // Detect macOS for traffic light padding
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.getPlatform) {
      api.getPlatform().then((p: string) => setIsMac(p === 'darwin'));
    }
  }, []);

  // Title bar height adjusts inversely to zoom so it stays visually constant
  //
  // 【2026-09-20 用户反馈「看起来其实没有区别，可以再大一点」】
  // 旧公式：320px → 34px，767px → 44px，768px 起固定 44。
  // 两个问题：
  //   1. 手机端（393px）只算出 **36px** —— 比旧的固定值大不了多少，用户当然看不出变化；
  //   2. 767px(44) 和 768px(44) 之间是**断崖**（插值终点正好撞上固定值），曲线不连续。
  // 现在：手机端基准提到 52px（明显变大），平滑过渡到桌面 44px 不变，
  // 且全程连续（767px 和 768px 都落在 44，不再跳变）。
  //   320px → 52px · 393px(本机) → 50px · 560px → 47px · 767px+ → 44px
  const computeTitleBarHeight = (width: number) => {
    const MOBILE_H = 44;   // 【2026-09-20 v3】用户反馈 52px 太大，折中到 44（=桌面基准）
    const DESKTOP_H = 44;  // 桌面高度
    const RAMP_START = 320;
    const RAMP_END = 767;  // 到 767 恰好收敛到 DESKTOP_H，与 >=768 的固定值无缝衔接
    if (width >= RAMP_END) return DESKTOP_H;
    const t = Math.max(0, width - RAMP_START) / (RAMP_END - RAMP_START);
    return Math.round(MOBILE_H + (DESKTOP_H - MOBILE_H) * t);
  };
  const [titleBarHeight, setTitleBarHeight] = useState(() =>
    computeTitleBarHeight(typeof window !== 'undefined' ? window.innerWidth : 1440)
  );
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.onZoomChanged) {
      api.onZoomChanged((factor: number) => {
        setTitleBarHeight(Math.round(44 / factor));
      });
    }
  }, []);

  const location = useLocation();
  const navigate = useNavigate();

  // 移动端：跳转到新页面后自动收起抽屉，避免遮住内容
  useEffect(() => {
    if (isMobile) setIsSidebarCollapsed(true);
  }, [isMobile, location.pathname]);

  // 顶栏高度跟随视口宽度连续更新（覆盖旋转、分屏、任意屏宽）
  useEffect(() => {
    const sync = () => setTitleBarHeight(computeTitleBarHeight(window.innerWidth));
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // 移动端整体缩放比例：存 localStorage，可在控制台用 setMobileZoom(0.8) 实时调。
  // 默认 0.92：再小就明显浪费横向空间（字号走 clamp(vw) 不受 zoom 影响，缩了也不变小）。
  useEffect(() => {
    const apply = (value: number) => {
      const v = Math.min(1, Math.max(0.6, value));
      document.documentElement.style.setProperty('--mobile-zoom', String(v));
      localStorage.setItem('mobileZoom', String(v));
    };
    const saved = parseFloat(localStorage.getItem('mobileZoom') || '');
    apply(Number.isFinite(saved) ? saved : 0.92);
    (window as any).setMobileZoom = apply;
    return () => { delete (window as any).setMobileZoom; };
  }, []);

  // Navigation history for back/forward buttons
  const [navHistory, setNavHistory] = useState<string[]>([location.pathname + location.search + location.hash]);
  const [navIndex, setNavIndex] = useState(0);
  const isNavAction = useRef(false);

  useEffect(() => {
    const fullPath = location.pathname + location.search;
    if (isNavAction.current) {
      isNavAction.current = false;
      return;
    }
    setNavHistory(prev => {
      const trimmed = prev.slice(0, navIndex + 1);
      if (trimmed[trimmed.length - 1] === fullPath) return trimmed;
      return [...trimmed, fullPath];
    });
    setNavIndex(prev => {
      const trimmed = navHistory.slice(0, prev + 1);
      if (trimmed[trimmed.length - 1] === fullPath) return prev;
      return trimmed.length;
    });
  }, [location.pathname, location.search]);

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;

  const handleNavBack = () => {
    if (!canGoBack) return;
    isNavAction.current = true;
    const newIndex = navIndex - 1;
    setNavIndex(newIndex);
    navigate(navHistory[newIndex]);
  };

  const handleNavForward = () => {
    if (!canGoForward) return;
    isNavAction.current = true;
    const newIndex = navIndex + 1;
    setNavIndex(newIndex);
    navigate(navHistory[newIndex]);
  };

  useEffect(() => {
    setShowSettings(false);
    setShowUpgrade(false);
    setDocumentPanelDoc(null);
    setShowArtifacts(false);
  }, [location.pathname]);

  // 进设置页时收起侧边栏：设置页本身就是全屏内容，侧边栏挤掉一半宽度很难用。
  // 退出时恢复到进入前的状态（不强制展开 —— 用户原来就是收起的话保持收起）。
  const sidebarBeforeSettingsRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (showSettings) {
      sidebarBeforeSettingsRef.current = isSidebarCollapsed;
      setIsSidebarCollapsed(true);
    } else if (sidebarBeforeSettingsRef.current !== null) {
      const prev = sidebarBeforeSettingsRef.current;
      sidebarBeforeSettingsRef.current = null;
      setIsSidebarCollapsed(prev);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  // Listen for open-upgrade event from MainContent paywall
  useEffect(() => {
    const handler = () => { setShowUpgrade(true); setShowSettings(false); };
    window.addEventListener('open-upgrade', handler);
    return () => window.removeEventListener('open-upgrade', handler);
  }, []);

  // Collapse sidebar on Customize page (Removed per user request)
  useEffect(() => {
    // Intentionally empty: do not collapse left sidebar automatically
  }, [location.pathname]);

  const isElectron = !!(window as any).electronAPI?.isElectron;
  // Electron auth rule: clawparrot users must login before entering the main UI
  // (登录页会提示去 clawparrot.com 注册, 也提供"跳过登录"按钮切到 selfhosted).
  // selfhosted users skip the login page entirely.
  useEffect(() => {
    if (!isElectron) return;
    const mode = localStorage.getItem('user_mode');
    const hasGatewayKey = !!(localStorage.getItem('ANTHROPIC_API_KEY') && localStorage.getItem('gateway_user'));
    setAuthValid(!(mode === 'clawparrot' && !hasGatewayKey));
  }, [isElectron]);

  const loadUnreadAnnouncements = useCallback(async () => {
    try {
      const data = await getUnreadAnnouncements();
      setUnreadAnnouncements(Array.isArray(data?.announcements) ? data.announcements : []);
    } catch (err) {
      console.error('Failed to fetch announcements:', err);
    }
  }, []);

  useEffect(() => {
    if (!authValid) return;

    loadUnreadAnnouncements();

    const intervalId = window.setInterval(() => {
      loadUnreadAnnouncements();
    }, 15000);

    const handleFocus = () => {
      loadUnreadAnnouncements();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadUnreadAnnouncements();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authValid, loadUnreadAnnouncements]);

  useEffect(() => {
    if (unreadAnnouncements.length === 0) {
      if (activeAnnouncementId !== null) setActiveAnnouncementId(null);
      return;
    }

    if (activeAnnouncementId === null || !unreadAnnouncements.some(item => item.id === activeAnnouncementId)) {
      setActiveAnnouncementId(unreadAnnouncements[0].id);
    }
  }, [unreadAnnouncements, activeAnnouncementId]);

  const activeAnnouncement = unreadAnnouncements.find(item => item.id === activeAnnouncementId) || null;

  const handleAnnouncementRead = useCallback(async () => {
    if (!activeAnnouncement || isMarkingAnnouncementRead) return;

    setIsMarkingAnnouncementRead(true);
    try {
      await markAnnouncementRead(activeAnnouncement.id);
      setUnreadAnnouncements(prev => prev.filter(item => item.id !== activeAnnouncement.id));
    } catch (err: any) {
      alert(err?.message || '公告已读失败，请稍后重试');
    } finally {
      setIsMarkingAnnouncementRead(false);
    }
  }, [activeAnnouncement, isMarkingAnnouncementRead]);

  const refreshSidebar = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  const handleNewChat = () => {
    setNewChatKey(prev => prev + 1);
    setRefreshTrigger(prev => prev + 1);
    setShowSettings(false);
    setShowUpgrade(false);
    setDocumentPanelDoc(null);
    setShowArtifacts(false);
  };

  const handleOpenDocument = useCallback((doc: DocumentInfo) => {
    if (!documentPanelDoc && !showArtifacts) {
      sidebarWasCollapsedRef.current = isSidebarCollapsed;
    }
    setShowArtifacts(false);
    setIsSidebarCollapsed(true);
    setDocumentPanelDoc(doc);
  }, [isSidebarCollapsed, documentPanelDoc, showArtifacts]);

  const handleCloseDocument = useCallback(() => {
    setDocumentPanelDoc(null);
    if (!showArtifacts) {
      setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
    }
  }, [showArtifacts]);

  const handleArtifactsUpdate = useCallback((docs: DocumentInfo[]) => {
    setArtifacts(docs);
  }, []);

  const handleOpenArtifacts = useCallback(() => {
    if (showArtifacts) {
      setShowArtifacts(false);
      // Restore sidebar state if it was collapsed by us?
      // For now, simple toggle close.
      if (!documentPanelDoc) {
        setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
      }
      return;
    }

    if (!documentPanelDoc) {
      sidebarWasCollapsedRef.current = isSidebarCollapsed;
    }
    setIsSidebarCollapsed(true);
    setShowArtifacts(true);
    setDocumentPanelDoc(null);
  }, [isSidebarCollapsed, documentPanelDoc, showArtifacts]);

  const handleCloseArtifacts = useCallback(() => {
    setShowArtifacts(false);
    setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
  }, []);

  const handleChatModeChange = useCallback((isChat: boolean) => {
    setIsChatMode(isChat);
  }, []);

  const handleTitleChange = useCallback((title: string) => {
    setCurrentChatTitle(title);
  }, []);

  // Layout Tuner State
  const [tunerConfig, setTunerConfig] = useState({
    sidebarWidth: 288, // tuned value
    recentsMt: 24,
    profilePy: 10,
    profilePx: 12,
    mainContentWidth: 773, // tuned value
    mainContentMt: -100,
    inputRadius: 24,
    welcomeSize: 46,
    welcomeMb: 34,

    recentsFontSize: 14,
    recentsItemPy: 7,
    recentsPl: 6,
    userAvatarSize: 36,
    userNameSize: 15,
    headerPy: 0,

    // Toggle Button (Independent Position)
    toggleSize: 28,
    toggleAbsRight: 10,
    toggleAbsTop: 11,
    toggleAbsLeft: 8, // Collapsed State Left Position
  });

  // Git-bash required (Windows): block app until installed
  if (needsGitBash) {
    return <GitBashRequiredModal onResolved={() => setNeedsGitBash(false)} />;
  }

  // Onboarding: show on first launch
  if (showOnboarding) {
    return <Onboarding onComplete={() => {
      setShowOnboarding(false);
      if (!isElectron) { setAuthValid(true); return; }
      // clawparrot users go straight to /login (Onboarding also opens clawparrot.com
      // in the browser so they can register). selfhosted users enter the main UI.
      const mode = localStorage.getItem('user_mode');
      const hasGatewayKey = !!(localStorage.getItem('ANTHROPIC_API_KEY') && localStorage.getItem('gateway_user'));
      setAuthValid(!(mode === 'clawparrot' && !hasGatewayKey));
    }} />;
  }

  // Guard: check if logged in
  if (!authChecked) {
    return null; // 验证中，不渲染
  }
  if (!authValid) {
    return <Navigate to="/login" replace />;
  }

  return (
    <>
      <div className="relative flex w-full h-screen overflow-hidden bg-claude-bg font-sans antialiased">
        {/* Custom Solid Title Bar (Unified Full Width) */}
        <div
          data-chrome="titlebar"
          className="absolute top-0 left-0 w-full z-50 flex items-center select-none pointer-events-none bg-claude-bg border-b border-claude-border transition-all duration-300"
          style={{ WebkitAppRegion: 'drag', height: `${titleBarHeight}px` } as React.CSSProperties}
        >
          {/* Left Controls inside Title Bar — extra padding on Mac for traffic lights */}
          <div
            className="h-full flex items-center pr-2 gap-0.5"
            style={{ pointerEvents: 'auto', WebkitAppRegion: 'no-drag', paddingLeft: isMac ? '78px' : '4px' } as React.CSSProperties}
          >
            {/* Menu 按钮是无实现的装饰按钮（onClick 为空），移动端屏宽紧张直接隐藏 */}
            <Tooltip text="Menu">
              <button
                onClick={() => { }}
                className="hidden md:block p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                <Menu size={18} className="opacity-80" />
              </button>
            </Tooltip>
            <Tooltip text={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                aria-label={isSidebarCollapsed ? '打开菜单' : '关闭菜单'}
                className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                {/* 移动端是抽屉，用汉堡图标语义更清楚；桌面端沿用原折叠图标 */}
                {isMobile
                  ? <Menu size={20} className="opacity-90" />
                  : <IconSidebarToggle size={24} className="dark:invert transition-[filter] duration-200" />}
              </button>
            </Tooltip>
            {canGoBack ? (
              <Tooltip text="Back">
                <button
                  onClick={handleNavBack}
                  className="p-2 rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: '#73726C' }}
                >
                  <ArrowLeft size={18} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <span className="p-2" style={{ color: '#B7B5B0' }}>
                <ArrowLeft size={18} strokeWidth={1.5} />
              </span>
            )}
            {canGoForward ? (
              <Tooltip text="Forward">
                <button
                  onClick={handleNavForward}
                  className="p-2 rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: '#73726C' }}
                >
                  <ArrowRight size={18} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <span className="p-2" style={{ color: '#B7B5B0' }}>
                <ArrowRight size={18} strokeWidth={1.5} />
              </span>
            )}
          </div>

          {/* Mode tabs moved to sidebar */}
        </div>

        <Sidebar
          isCollapsed={isSidebarCollapsed}
          toggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          refreshTrigger={refreshTrigger}
          onNewChatClick={handleNewChat}
          onOpenSettings={() => { pathBeforeSettingsRef.current = location.pathname; setShowSettings(true); setShowUpgrade(false); }}
          onOpenUpgrade={() => { setShowUpgrade(true); setShowSettings(false); }}
          onCloseOverlays={() => { setShowSettings(false); setShowUpgrade(false); }}
          tunerConfig={tunerConfig}
          setTunerConfig={setTunerConfig}
        />

        {/* Unified Content Wrapper - takes remaining space after sidebar */}
        <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative" style={{ paddingTop: `${titleBarHeight}px` }}>
          {/* Header - moved to allow conditional placement (Full Width Mode) */}
          {isChatMode && (showArtifacts && !documentPanelDoc) && !showSettings && !showUpgrade && (
            <ChatHeader
              title={currentChatTitle}
              showArtifacts={showArtifacts}
              documentPanelDoc={documentPanelDoc}
              onOpenArtifacts={handleOpenArtifacts}
              hasArtifacts={artifacts.length > 0}
              onTitleRename={handleTitleChange}
            />
          )}

          <div className="flex-1 flex overflow-hidden relative" ref={contentContainerRef}>

            {/* Main Content Area - takes remaining width after panel */}
            <div className="flex-1 flex flex-col h-full min-w-0">
              {/* Header - Only render here if NOT in Artifacts-only mode */}
              {isChatMode && (!showArtifacts || documentPanelDoc) && !showSettings && !showUpgrade && location.pathname !== '/chats' && location.pathname !== '/customize' && location.pathname !== '/projects' && location.pathname !== '/artifacts' && location.pathname !== '/cowork' && location.pathname !== '/scheduled' && (
                <ChatHeader
                  title={currentChatTitle}
                  showArtifacts={showArtifacts}
                  documentPanelDoc={documentPanelDoc}
                  onOpenArtifacts={handleOpenArtifacts}
                  hasArtifacts={artifacts.length > 0}
                  onTitleRename={handleTitleChange}
                />
              )}

              {showSettings ? (
                <ErrorBoundary label="设置页">
                  <SettingsPage onClose={() => {
                    setShowSettings(false);
                    // 回到打开设置前停留的页面，而不是被丢回主页。
                    // location.pathname 在这里其实没变过（设置是覆盖层不是路由），
                    // 之前的问题是有人顺手 navigate('/')；这里显式还原。
                    if (pathBeforeSettingsRef.current && pathBeforeSettingsRef.current !== location.pathname) {
                      navigate(pathBeforeSettingsRef.current, { replace: true });
                    }
                    pathBeforeSettingsRef.current = null;
                  }} />
                </ErrorBoundary>
              ) : showUpgrade ? (
                <UpgradePlan onClose={() => setShowUpgrade(false)} />
              ) : location.pathname === '/chats' ? (
                <ChatsPage />
              ) : location.pathname === '/customize' ? (
                <CustomizePage onCreateWithClaude={() => {
                  sessionStorage.setItem('prefill_input', '让我们一起使用你的 skill-creator skill 来创建一个 skill 吧。请先问我这个 skill 应该做什么。');
                  handleNewChat();
                  window.location.hash = '#/';
                }} />
              ) : location.pathname === '/projects' ? (
                <ProjectsPage />
              ) : location.pathname === '/cowork' ? (
                <CoworkPage onStartTask={(prompt, model) => {
                  // 【2026-09-20 修】这里原来只是把 prompt 塞进 sessionStorage 再跳回聊天 ——
                  // 等于一个"新建对话"的变体，**没有任何多 Agent 编排**，
                  // 用户反馈「web 中协作模式可能无效」正是这个。
                  //
                  // 核实官方确有 Coordinator Mode（多 Agent 编排），且我们的
                  // Agent / SendMessage / AgentStop / TeamCreate 工具早已齐备。
                  //
                  // 做法：**不额外发一条 /coordinate**（那会让用户看到莫名其妙的第二步），
                  // 而是直接把输入预填成 `/coordinate <任务>` —— 用户点发送时
                  // 一条消息就完成「进模式 + 派任务」。index.mjs 的 case 'coordinate'
                  // 已支持带参形态（参数会作为首轮指令留在对话里）。
                  const text = prompt && prompt.trim() ? prompt.trim() : '';
                  if (text) sessionStorage.setItem('prefill_input', `/coordinate ${text}`);
                  if (model) sessionStorage.setItem('prefill_model', model);
                  handleNewChat();
                  navigate('/');
                }} />
              ) : location.pathname === '/scheduled' ? (
                <ScheduledPage onNewTask={() => navigate('/cowork')} />
              ) : location.pathname === '/artifacts' ? (
                <ArtifactsPage onTryPrompt={(prompt) => {
                  if (prompt === '__remix__') {
                    // Remix mode: artifact data already in sessionStorage
                    sessionStorage.setItem('artifact_prompt', '__remix__');
                  } else {
                    sessionStorage.setItem('artifact_prompt', prompt);
                  }
                  handleNewChat();
                  window.location.hash = '#/';
                }} />
              ) : (
                <MainContent
                  onNewChat={refreshSidebar}
                  resetKey={newChatKey}
                  tunerConfig={tunerConfig}
                  onOpenDocument={handleOpenDocument}
                  onArtifactsUpdate={handleArtifactsUpdate}
                  onOpenArtifacts={handleOpenArtifacts}
                  onTitleChange={handleTitleChange}
                  onChatModeChange={handleChatModeChange}
                />
              )}
            </div>

            {/* Animated Document Panel Container */}
            <div
              className={`h-full bg-claude-bg transition-all duration-300 ease-out flex z-20 relative ${(documentPanelDoc || showArtifacts) ? 'border-l border-claude-border' : ''}`}
              style={{
                width: documentPanelDoc ? `${documentPanelWidth}%` : showArtifacts ? '360px' : '0px',
                opacity: (documentPanelDoc || showArtifacts) ? 1 : 0,
                overflow: 'hidden'
              }}
            >
              {documentPanelDoc && (
                <div className="absolute left-0 top-0 bottom-0 h-full z-50">
                  <DraggableDivider onResize={setDocumentPanelWidth} containerRef={contentContainerRef} />
                </div>
              )}
              <div className={`w-full h-full flex relative min-w-0 overflow-hidden`}>
                {(documentPanelDoc || showArtifacts) && (
                  <>
                    {documentPanelDoc ? (
                      <DocumentPanel document={documentPanelDoc} onClose={handleCloseDocument} />
                    ) : (
                      <ArtifactsPanel
                        documents={artifacts}
                        onClose={handleCloseArtifacts}
                        onOpenDocument={handleOpenDocument}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
      {activeAnnouncement && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#1F1F1F] shadow-2xl border border-black/5 dark:border-white/10">
            <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100 dark:border-white/10">
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 flex items-center justify-center shrink-0">
                <BellRing size={20} />
              </div>
              <div className="min-w-0">
                <h3 className="text-[18px] font-semibold text-gray-900 dark:text-white break-words">{activeAnnouncement.title}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  系统公告 · {activeAnnouncement.created_at?.slice(0, 16).replace('T', ' ') || ''}
                </p>
              </div>
            </div>
            <div className="px-6 py-5">
              <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-[15px] leading-7 text-gray-700 dark:text-gray-200">
                {activeAnnouncement.content}
              </div>
              <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                点击右下角“已读”后，后续将不再重复弹出这条公告。
              </div>
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-white/10">
              <div className="text-xs text-gray-400 dark:text-gray-500">
                {unreadAnnouncements.length > 1 ? `还有 ${unreadAnnouncements.length - 1} 条未读公告` : '暂无其他未读公告'}
              </div>
              <button
                onClick={handleAnnouncementRead}
                disabled={isMarkingAnnouncementRead}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isMarkingAnnouncementRead ? '处理中...' : '已读'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const App = () => {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<React.Suspense fallback={<div className="p-8 text-claude-textSecondary">加载中…</div>}><AdminDashboard /></React.Suspense>} />
          <Route path="keys" element={<AdminKeyPool />} />
          <Route path="models" element={<AdminModels />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="announcements" element={<AdminAnnouncements />} />
          <Route path="plans" element={<AdminPlans />} />
          <Route path="redemption" element={<AdminRedemption />} />
        </Route>
        <Route path="/" element={<Layout />} />
        <Route path="/chats" element={<Layout />} />
        <Route path="/customize" element={<Layout />} />
        <Route path="/projects" element={<Layout />} />
        <Route path="/artifacts" element={<Layout />} />
        <Route path="/cowork" element={<Layout />} />
        <Route path="/scheduled" element={<Layout />} />
        <Route path="/chat/:id" element={<Layout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
};

export default App;
