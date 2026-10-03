import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  Check,
  Folder,
} from 'lucide-react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import giftLottie from '../assets/home/gift-giving.lottie';
import starSparkleImg from '../assets/figma-exports/cowork-icons/star-sparkle.png';
import micIconImg from '../assets/figma-exports/cowork-icons/mic-icon.png';
import plusIconImg from '../assets/figma-exports/cowork-icons/plus-icon.png';
import chevronProjectImg from '../assets/figma-exports/cowork-icons/chevron-project.png';
import chevronAskImg from '../assets/figma-exports/cowork-icons/chevron-ask.png';
import chevronModelImg from '../assets/figma-exports/cowork-icons/chevron-model.png';
import folderProjectSvg from '../assets/figma-exports/cowork-icons/folder-project.svg';
import { getProviders, Provider } from '../api';

interface CoworkPageProps {
  onStartTask: (prompt: string, model?: string) => void;
}

interface ChecklistItem {
  id: string;
  title: string;
  subtitle: string;
  completed: boolean;
}

interface SelectOption {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  {
    id: 'download',
    title: '下载协作模式',
    subtitle: '欢迎！',
    completed: true,
  },
  {
    id: 'connect-tools',
    title: '连接日常工具',
    subtitle: 'Claude 越了解你的工作环境，就能帮你完成越多事情。',
    completed: true,
  },
  {
    id: 'customize-role',
    title: '根据你的角色定制 Claude',
    subtitle: '添加现成的工具和工作流。',
    completed: false,
  },
  {
    id: 'create-something',
    title: '让 Claude 创建内容',
    subtitle: '试试创建表格、文档或演示文稿。',
    completed: false,
  },
  {
    id: 'schedule-task',
    title: '安排周期性任务',
    subtitle: '适合设置提醒、报告或定期检查。',
    completed: false,
  },
];

const PROJECT_OPTIONS: SelectOption[] = [
  { id: 'work', name: '在项目中工作' },
  { id: 'personal', name: '个人' },
  { id: 'research', name: '研究' },
];

const MODEL_OPTIONS: SelectOption[] = [
  { id: 'opus-4-7', name: 'Opus 4.7' },
  { id: 'sonnet-4-5', name: 'Sonnet 4.5' },
  { id: 'haiku-4', name: 'Haiku 4' },
];

type MenuKind = 'project' | 'model' | null;

const CoworkPage: React.FC<CoworkPageProps> = ({ onStartTask }) => {
  const [draft, setDraft] = useState('');
  const [openMenu, setOpenMenu] = useState<MenuKind>(null);
  const [project, setProject] = useState<SelectOption>(PROJECT_OPTIONS[0]);
  const [modelOptions, setModelOptions] = useState<SelectOption[]>(MODEL_OPTIONS);
  const [model, setModel] = useState<SelectOption>(MODEL_OPTIONS[0]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  const hintId = useId();

  useEffect(() => {
    textareaRef.current?.focus();
    getProviders().then((providers: Provider[]) => {
      const options = (providers || []).flatMap((provider: any) => {
        const models = Array.isArray(provider.models) && provider.models.length
          ? provider.models
          : [{ id: provider.model, name: provider.model }];
        return models.filter((item: any) => item?.id).map((item: any) => ({
          id: item.id,
          name: item.name || item.id,
          providerId: provider.id,
          providerName: provider.name || provider.id,
        }));
      });
      const seen = new Set<string>();
      const unique = options.filter(item => !seen.has(item.id) && seen.add(item.id));
      if (unique.length) {
        setModelOptions(unique);
        setModel(unique[0]);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!openMenu) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const inProject = projectRef.current?.contains(target);
      const inModel = modelRef.current?.contains(target);
      if (!inProject && !inModel) setOpenMenu(null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const submit = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    onStartTask(value, model.id);
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.removeProperty('height');
  }, [draft, onStartTask]);

  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const canSubmit = useMemo(() => draft.trim().length > 0, [draft]);

  return (
    <div className="cowork-bg flex-1 h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 pt-24 pb-16">
        {/* Hero */}
        <div className="mb-3 flex items-center gap-3">
          <img
            src={starSparkleImg}
            alt=""
            className="shrink-0"
            width={28}
            height={28}
            aria-hidden="true"
          />
          <h1 className="cowork-title">
            完成清单上的一件事吧
          </h1>
        </div>
        <div className="mb-8">
          <button
            type="button"
            className="cowork-subtitle-link"
          >
            了解如何安全使用协作模式。
          </button>
        </div>

        {/* Composer – base container with inner card */}
        <div className="cowork-composer-base rounded-[32px] border p-1.5">
          {/* Inner input card */}
          <div className="cowork-composer cowork-composer-inner rounded-[20px] p-4 pb-3">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onTextareaKeyDown}
              placeholder="今天需要什么帮助？"
              rows={1}
              aria-label="协作任务描述"
              aria-describedby={hintId}
              className="cowork-textarea w-full resize-none border-0 bg-transparent px-1 pt-0.5 text-[17px] leading-7 text-claude-text placeholder:text-[#8E8D89] focus:outline-none"
              style={{ minHeight: 44, fontFamily: '"Anthropic Serif", Spectral, "Source Serif 4", Georgia, serif' }}
            />
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full text-claude-textSecondary transition-colors hover:bg-claude-hover hover:text-claude-text focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent"
                aria-label="添加附件"
              >
                <img src={plusIconImg} alt="" width={18} height={18} />
              </button>
              {canSubmit ? (
                <button
                  type="button"
                  onClick={submit}
                  className="cowork-send flex items-center gap-1.5 rounded-[10px] px-4 py-1.5 text-[13px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-claude-accent"
                >
                  <span>开始吧</span>
                  <ArrowDown size={14} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex items-center justify-center text-claude-textSecondary transition-colors hover:text-claude-text focus:outline-none"
                  aria-label="语音输入"
                >
                  <img src={micIconImg} alt="" width={14} height={18} />
                </button>
              )}
            </div>
          </div>

          {/* Bottom selector bar inside the base */}
          <div id={hintId} className="flex items-center gap-x-3 px-5 py-2.5">
            <div className="relative" ref={projectRef}>
              <button
                type="button"
                onClick={() => setOpenMenu((cur) => (cur === 'project' ? null : 'project'))}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'project'}
                className="cowork-selector-btn"
              >
                <img src={folderProjectSvg} alt="" width={18} height={18} className="cowork-selector-icon" />
                <span>{project.name}</span>
                <img src={chevronProjectImg} alt="" width={10} height={8} className="opacity-60" />
              </button>
              {openMenu === 'project' && (
                <div
                  role="menu"
                  aria-label="选择项目"
                  className="absolute left-0 top-full z-30 mt-1 w-[220px] rounded-xl border border-claude-border bg-claude-input py-1.5 shadow-lg"
                >
                  {PROJECT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={opt.id === project.id}
                      onClick={() => {
                        setProject(opt);
                        setOpenMenu(null);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-claude-text hover:bg-claude-hover focus:bg-claude-hover focus:outline-none"
                    >
                      <Folder size={14} strokeWidth={1.6} className="text-claude-textSecondary" />
                      {opt.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="cowork-selector-btn"
            >
              <span>提问</span>
              <img src={chevronAskImg} alt="" width={10} height={8} className="opacity-60" />
            </button>

            <div className="ml-auto relative" ref={modelRef}>
              <button
                type="button"
                onClick={() => setOpenMenu((cur) => (cur === 'model' ? null : 'model'))}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'model'}
                className="cowork-selector-btn"
              >
                <span>{model.name}</span>
                <img src={chevronModelImg} alt="" width={10} height={8} className="opacity-60" />
              </button>
              {openMenu === 'model' && (
                <div
                  role="menu"
                  aria-label="选择模型"
                  className="absolute right-0 top-full z-30 mt-1 max-h-[min(420px,calc(100vh-180px))] w-[280px] overflow-y-auto rounded-xl border border-claude-border bg-claude-input py-1.5 shadow-lg"
                >
                  {Array.from(modelOptions.reduce((groups, option) => {
                    const key = `${option.providerId || 'unknown'}:${option.providerName || '其他 Provider'}`;
                    const group = groups.get(key) || { providerName: option.providerName || '其他 Provider', options: [] as SelectOption[] };
                    group.options.push(option);
                    groups.set(key, group);
                    return groups;
                  }, new Map<string, { providerName: string; options: SelectOption[] }>()).values()).map((group) => (
                    <div key={group.providerName} className="py-1">
                      <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-claude-textSecondary">{group.providerName}</div>
                      {group.options.map((opt) => (
                        <button
                          key={`${opt.providerId}:${opt.id}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={opt.id === model.id && opt.providerId === model.providerId}
                          onClick={() => {
                            setModel(opt);
                            setOpenMenu(null);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] text-claude-text hover:bg-claude-hover focus:bg-claude-hover focus:outline-none"
                        >
                          <span className="truncate">{opt.name}</span>
                          {opt.id === model.id && opt.providerId === model.providerId && <Check size={14} className="shrink-0 text-claude-accent" />}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 了解协作模式 */}
        <div className="mt-14">
          <h2 className="cowork-section-title mb-4">
            了解协作模式
          </h2>
          <div className="space-y-0">
            {CHECKLIST_ITEMS.map((item, i) => (
              <div
                key={item.id}
                className={`flex items-start gap-4 py-4 ${i < CHECKLIST_ITEMS.length - 1 ? 'cowork-checklist-divider' : ''}`}
              >
                <div className={`cowork-check-circle mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${item.completed ? 'completed' : ''}`}>
                  {item.completed && <Check size={16} strokeWidth={2.5} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[15px] font-medium ${item.completed ? 'cowork-check-title-done' : 'cowork-check-title'}`}>
                    {item.title}
                  </div>
                  <div className="cowork-check-subtitle text-[13px] mt-0.5">
                    {item.subtitle}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Web 说明 */}
        <div className="mt-12">
          <div className="mb-3 text-[12px] uppercase tracking-wider text-claude-textSecondary">
            Web 说明
          </div>
          <div className="cowork-card flex items-center gap-4 rounded-2xl border px-4 py-4">
            <div className="flex h-14 w-14 items-center justify-center shrink-0">
              <DotLottieReact
                src={giftLottie}
                loop
                autoplay
                style={{ width: 48, height: 48 }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium text-claude-text">当前 Web 协作能力</div>
              <div className="mt-0.5 text-[12.5px] text-claude-textSecondary">
                协作模式会把任务交给当前 Web Agent 执行，使用当前 session 的 Provider、workspace 和工具权限。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkPage;
