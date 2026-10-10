import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronDown, FileText, ArrowUp, RotateCcw, Pencil, Copy, Check, Globe, Clock, Info, Plus, X, Loader2 } from 'lucide-react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { IconPlus, IconVoice, IconPencil, IconProjects, IconResearch, IconWebSearch, IconCoworkSparkle } from './Icons';
import AssistantActivityIndicator from './AssistantActivityIndicator';
import { LONG_THINKING_THRESHOLD_MS } from './assistantActivityState';
import { getConversation, sendMessage, createConversation, getUser, updateConversation, deleteMessagesFrom, deleteMessagesTail, uploadFile, deleteAttachment, compactConversation, answerUserQuestion, answerWebQuestion, getUserUsage, getAttachmentUrl, getGenerationStatus, stopGeneration, getContextSize, getUserModels, getStreamStatus, reconnectStream, getProviderModels, getSkills, getSlashCommands, warmEngine, getProjects, createProject, Project, materializeGithub, getProviders, Provider, PROFILE_UPDATED_EVENT } from '../api';
import SlashCommandMenu, { SlashSuggestion } from './SlashCommandMenu';
import { addStreaming, removeStreaming, isStreaming } from '../streamingState';
import MarkdownRenderer from './MarkdownRenderer';
import PresentBlock from './PresentBlock';
import ResearchPanel from './ResearchPanel';
import ModelSelector, { SelectableModel } from './ModelSelector';
import FileUploadPreview, { PendingFile } from './FileUploadPreview';
import AddFromGithubModal, { GithubAddPayload } from './AddFromGithubModal';
import MessageAttachments from './MessageAttachments';
import DocumentCard, { DocumentInfo } from './DocumentCard';
import { copyToClipboard } from '../utils/clipboard';
import { normalizeGeneratedDocumentFormat } from './documentCardMeta.js';
import SearchProcess from './SearchProcess';
import AssistantThinkingChain, { AssistantThinkingCompactStatus, AssistantThinkingEvent } from './AssistantThinkingChain';
import WizardDialog, { WizardStep } from './WizardDialog';
import SelectDialog, { SelectRequest } from './SelectDialog';
import DocumentCreationProcess, { DocumentDraftInfo } from './DocumentCreationProcess';
import CodeExecution from './CodeExecution';
import ToolDiffView, { shouldUseDiffView, hasExpandableContent, getToolStats } from './ToolDiffView';
import TodoPanel, { TodoItem } from './TodoPanel';
import { buildToolFallbackThinking, buildReasoningTimelineEvents, buildResponseFallbackThinking, getToolDisplayName, HIDDEN_TOOL_NAMES } from './toolThinkingFallback.js';
import { executeCode, sendCodeResult, setStatusCallback } from '../pyodideRunner';
import inspirationsData from '../data/inspirations.json';
import inputPlusIcon from '../assets/home/input-plus.svg';
import modelCaretIcon from '../assets/home/model-caret.svg';
import promptWriteIcon from '../assets/home/prompt-write.svg';
import promptLearnIcon from '../assets/home/prompt-learn.svg';
import promptCodeIcon from '../assets/home/prompt-code.svg';
import promptLifeIcon from '../assets/home/prompt-life.svg';
import promptChoiceIcon from '../assets/home/prompt-choice.svg';
import plusMenuAttachIcon from '../assets/home/plus-menu/attach.svg';
import plusMenuScreenshotIcon from '../assets/home/plus-menu/screenshot.svg';
import plusMenuProjectIcon from '../assets/home/plus-menu/project.svg';
import plusMenuChevronIcon from '../assets/home/plus-menu/chevron.svg';
import plusMenuSkillsIcon from '../assets/home/plus-menu/skills.svg';
import plusMenuConnectorsIcon from '../assets/home/plus-menu/connectors.svg';
import plusMenuWebSearchIcon from '../assets/home/plus-menu/web-search.svg';
import plusMenuCheckIcon from '../assets/home/plus-menu/check.svg';
import plusMenuStyleIcon from '../assets/home/plus-menu/style.svg';
import { localizeInspiration } from '../utils/ui-locale';

interface InspirationItem {
  artifact_id: string;
  chat_id: string;
  category: string;
  name: string;
  description: string;
  starting_prompt: string;
  img_src: string;
  content_uuid?: string;
  code_file?: string;
}

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: null | (() => void);
  onresult: null | ((event: any) => void);
  onerror: null | ((event: any) => void);
  onend: null | (() => void);
  start: () => void;
  stop: () => void;
  abort: () => void;
};

const inspirationLibrary = inspirationsData.items as InspirationItem[];

const pickInspirations = (names: string[]) =>
  names
    .map((name) => inspirationLibrary.find((item) => item.name === name))
    .filter((item): item is InspirationItem => Boolean(item));

const sanitizeSelfHostedChatModels = (rawModels: any[]) => (
  Array.isArray(rawModels)
    ? rawModels.flatMap((model) => {
        const id = typeof model?.id === 'string' ? model.id.trim() : '';
        const providerId = typeof model?.providerId === 'string' ? model.providerId.trim() : '';
        if (!id || !providerId) return [];

        return [{
          ...model,
          id,
          providerId,
          name: typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : id,
          providerName: typeof model?.providerName === 'string' && model.providerName.trim() ? model.providerName.trim() : 'Custom provider',
        }];
      })
    : []
);

const LANDING_PROMPT_SECTIONS = [
  {
    label: '写作',
    icon: promptWriteIcon,
    width: 82.609,
    items: pickInspirations([
      'Writing editor',
      'Email writing assistant',
      'Meeting notes summary',
      'One-pager PRD maker',
      'My weekly chronicle',
    ]),
  },
  {
    label: '学习',
    icon: promptLearnIcon,
    width: 83.703,
    items: pickInspirations([
      'Flashcards',
      'PyLingo',
      'Molecule studio',
      'Language learning tutor',
      'Origin stories',
    ]),
  },
  {
    label: '编程',
    icon: promptCodeIcon,
    width: 81.688,
    items: pickInspirations([
      'CodeVerter',
      'Project dashboard generator',
      'Interactive drum machine',
      'Join dots',
      'Piano',
    ]),
  },
  {
    label: '生活',
    icon: promptLifeIcon,
    width: 106.484,
    items: pickInspirations([
      'Your life in weeks',
      'Dream interpreter',
      'Team activity ideas',
      'Magic in the grass',
      'How petty are you?',
    ]),
  },
  {
    label: 'Claude 推荐',
    icon: promptChoiceIcon,
    width: 148.453,
    items: pickInspirations([
      'Historical SVG amphitheater',
      'Stories in the sky',
      'Word cloud maker',
      'Sakura serenity',
      'Better than very',
    ]),
  },
] as const;

function createAssistantPlaceholder(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: '',
    _streamStartedAt: Date.now(),
    _firstContentAt: null,
    _didLongThinking: false,
    ...overrides,
  };
}

function assistantHadLongThinking(message: any): boolean {
  if (!message) return false;
  if (message._didLongThinking) return true;
  return (
    typeof message._streamStartedAt === 'number' &&
    typeof message._firstContentAt === 'number' &&
    message._firstContentAt - message._streamStartedAt >= LONG_THINKING_THRESHOLD_MS
  );
}

function applyAssistantTextUpdate(message: any, full: string) {
  if (!message) return;
  const now = Date.now();
  if (typeof message._streamStartedAt !== 'number') {
    message._streamStartedAt = now;
  }
  if (typeof message._firstContentAt !== 'number') {
    message._firstContentAt = now;
    if (now - message._streamStartedAt >= LONG_THINKING_THRESHOLD_MS) {
      message._didLongThinking = true;
    }
  }
  message.content = full;
  message.isThinking = false;
}

function applyAssistantThinkingUpdate(message: any, thinkingFull: string) {
  if (!message) return;
  const now = Date.now();
  if (typeof message._streamStartedAt !== 'number') {
    message._streamStartedAt = now;
  }
  if (now - message._streamStartedAt >= LONG_THINKING_THRESHOLD_MS) {
    message._didLongThinking = true;
  }
  message.thinking = thinkingFull;
  message.isThinking = true;
  delete message.searchStatus;
}

function formatChatError(err: string): string {
  const lower = (err || '').toLowerCase();
  // 【轮数上限要单独说清】agent 抛的是中文自解释消息（core/agent.mjs），
  // 原样展示比笼统的「Error: xxx」好得多 —— 它还告诉用户 /deep 或「继续」怎么走。
  if (lower.includes('已达轮数上限') || lower.includes('max turns exceeded')) {
    return '⚠️ ' + (err || '').replace(/^error:\s*/i, '');
  }
  if (lower.includes('quota_exceeded') || lower.includes('额度已用完') || lower.includes('额度已用尽') || lower.includes('时段额度') || lower.includes('周期额度')) {
    return '⚠️ 当前额度已用完，请等待额度重置后再试。你可以在设置页查看额度详情。';
  }
  if (lower.includes('订阅已过期') || lower.includes('未激活') || lower.includes('inactive') || lower.includes('expired')) {
    return '⚠️ 你的订阅已过期或未激活，请续费后继续使用。';
  }
  if (lower.includes('invalid api key') || lower.includes('authentication')) {
    return '⚠️ API 认证失败，请重新登录。';
  }
  if (lower.includes('overloaded') || lower.includes('rate limit') || lower.includes('529')) {
    return '⚠️ 服务暂时繁忙，请稍后再试。';
  }
  return 'Error: ' + err;
}

function formatVoiceError(err?: string): string {
  switch (err) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '请先允许 Claude 使用麦克风，然后再试一次。';
    case 'audio-capture':
      return '没有检测到可用的麦克风。';
    case 'network':
      return '语音识别暂时不可用，请稍后重试。';
    case 'no-speech':
      return '没有听到语音输入。';
    case 'aborted':
      return '';
    default:
      return '当前环境暂时无法启动语音听写。';
  }
}

// Blue skill tag shown in chat messages (hover shows tooltip)
const SkillTag: React.FC<{ slug: string; description?: string }> = ({ slug, description }) => {
  const [hover, setHover] = useState(false);
  return (
    <span className="relative inline" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span className={`text-[#4B9EFA] font-medium cursor-default transition-colors ${hover ? 'bg-[#4B9EFA]/10 rounded px-0.5 -mx-0.5' : ''}`}>
        /{slug}
      </span>
      {hover && description && (
        <div className="absolute left-0 top-full mt-2 w-[240px] p-3 bg-claude-input border border-claude-border rounded-xl shadow-lg z-[100] pointer-events-none">
          <div className="text-[12px] text-claude-textSecondary leading-snug mb-1.5">{description.length > 150 ? description.slice(0, 150) + '...' : description}</div>
          <div className="text-[11px] text-claude-textSecondary/60">Skill</div>
        </div>
      )}
    </span>
  );
};

// Overlay that mirrors textarea text: slash 命令整段蓝色，参数/正文普通色
//
// 【2026-09-20 用户反馈「输入 /config list，只有 /config 是蓝色，list 是正常色」】
// 原来的正则 `^(\/[a-zA-Z0-9_-]+)([\s\S]*)$` 只吃掉第一个词，
// 所以 /config list 里的 `list` 落到第二组 → 普通色。
//
// 但 slash 命令的**子命令**是命令的一部分（/config list、/config test、
// /config provider add），用户视觉上期望它们和命令同色。
// 而真正的「参数/正文」（如 `/model gpt-4` 里的 gpt-4、`/goal 补全 x.mjs` 里的描述）
// 才该是普通色 —— 否则整行全蓝，看不出命令到哪结束。
//
// 判据：命令后的**首个词**若命中已知子命令集合，就并入高亮段。
// 已知子命令由服务端的 slash 候选表提供（slashSubcommands），
// 这里接收一个可选的 subcommands 集合；没有就退回只高亮第一个词（老行为）。
const SkillInputOverlay: React.FC<{
  text: string;
  className?: string;
  style?: React.CSSProperties;
  /** 已知子命令表：{ config: ['list','show','test',...], ... } */
  subcommands?: Record<string, { candidates?: string[] }>;
}> = ({ text, className, style, subcommands }) => {
  const match = text.match(/^(\/[a-zA-Z0-9_-]+)([\s\S]*)$/);
  if (!match) return null;
  const cmd = match[1];
  const rest = match[2] || '';

  // 命令名去掉前导 '/'，查它的子命令候选
  const cmdName = cmd.slice(1);
  const candidates = subcommands?.[cmdName]?.candidates || [];

  // rest 形如 " list 剩余参数" —— 取首个非空词看看是不是子命令
  const subMatch = rest.match(/^(\s+)([a-zA-Z0-9_.-]+)([\s\S]*)$/);
  let bluePart = cmd;
  let normalPart = rest;
  if (subMatch && candidates.length) {
    const [, gap, word, after] = subMatch;
    // 大小写不敏感匹配（CLI 的子命令都接受任意大小写）
    if (candidates.some(c => c.toLowerCase() === word.toLowerCase())) {
      bluePart = cmd + gap + word;   // 子命令并入蓝色段
      normalPart = after;
    }
  }

  return (
    <div className={className} style={{ ...style, pointerEvents: 'none', position: 'absolute', top: 0, left: 0, right: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} aria-hidden>
      <span className="text-[#4B9EFA]">{bluePart}</span>
      <span className="text-claude-text">{normalPart}</span>
    </div>
  );
};

const CompactingStatus = () => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Fake progress animation
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 95) return prev;
        // Logarithmic-like slowdown
        const remaining = 95 - prev;
        const inc = Math.max(0.2, remaining * 0.05);
        return Math.min(95, prev + inc);
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col justify-center ml-2">
      <div className="text-[#404040] dark:text-[#d1d5db] font-serif italic text-[17px] leading-relaxed mb-1">
        Compacting our conversation so we can keep chatting...
      </div>
      <div className="flex items-center gap-3">
        <div className="w-48 h-1.5 bg-[#EAE8E1] dark:bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#404040] dark:bg-[#d1d5db] rounded-full transition-all duration-100 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[13px] text-[#707070] dark:text-[#9ca3af] font-medium font-mono">
          {Math.round(progress)}%
        </span>
      </div>
    </div>
  );
};

// 时间戳格式化
function formatMessageTime(dateStr: string): string {
  if (!dateStr) return '';

  let timeStr = dateStr;
  // Handle SQLite format (space instead of T)
  if (timeStr.includes(' ') && !timeStr.includes('T')) {
    timeStr = timeStr.replace(' ', 'T');
  }
  // Handle missing timezone (assume UTC if no Z or offset at end)
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(timeStr)) {
    timeStr += 'Z';
  }

  const date = new Date(timeStr);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  const isSameYear = date.getFullYear() === now.getFullYear();
  if (isSameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function stripThinking(model: string) {
  return (model || '').replace(/-thinking$/, '');
}

function withThinking(base: string, thinking: boolean) {
  return thinking ? `${base}-thinking` : base;
}

function isThinkingModel(model: string) {
  return typeof model === 'string' && model.endsWith('-thinking');
}

function getStoredMessageModel(message: any): string {
  const candidates = [message?.model, message?.generation_model, message?.request_model];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function resolveMessagePresentationModel(message: any, currentModelString: string, isStreamingCurrentTurn: boolean) {
  const storedModel = getStoredMessageModel(message);
  if (storedModel) return storedModel;
  if (isStreamingCurrentTurn) return currentModelString;
  return '';
}

// ─── Cross-mode override helpers ──────────────────────────────────────────────
// When a conversation's model belongs to a different mode than the user is
// currently in, we let the user opt to "keep using the cross-mode model".
// The choice is persisted per-conversation in localStorage so the next message
// in the same conversation continues to use the override mode without re-prompting.
function getCrossModeOverride(convId: string): 'clawparrot' | 'selfhosted' | null {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[convId] || null;
  } catch { return null; }
}

function setCrossModeOverride(convId: string, mode: 'clawparrot' | 'selfhosted') {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    const map = raw ? JSON.parse(raw) : {};
    map[convId] = mode;
    localStorage.setItem('cross_mode_overrides', JSON.stringify(map));
  } catch {}
}

function clearCrossModeOverride(convId: string) {
  try {
    const raw = localStorage.getItem('cross_mode_overrides');
    if (!raw) return;
    const map = JSON.parse(raw);
    delete map[convId];
    localStorage.setItem('cross_mode_overrides', JSON.stringify(map));
  } catch {}
}

function isSearchStatusMessage(message: string) {
  if (!message) return false;
  return (
    message.startsWith('正在搜索：') ||
    message.startsWith('正在读取网页：') ||
    message.startsWith('正在浏览 GitHub：') ||
    message.startsWith('Searching:') ||
    message.startsWith('Fetching:')
  );
}

// Extract display text from content that may be a plain string or a JSON-stringified content array
function extractTextContent(content: any): string {
  if (!content) return '';
  if (typeof content !== 'string') return String(content);
  // Try to parse as JSON array (Anthropic API content format)
  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((block: any) => block && block.type === 'text' && block.text)
          .map((block: any) => block.text)
          .join('\n');
      }
    } catch {
      // Not valid JSON, treat as plain text
    }
  }
  return content;
}

function extractToolSummaryHint(message: any): string {
  if (!message) return '';

  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      const textBefore = extractTextContent(toolCall?.textBefore);
      if (textBefore.trim()) return textBefore.trim();
    }
  }

  const fullText = extractTextContent(message.content);
  if (!fullText.trim()) return '';

  const offset = message.toolTextEndOffset;
  if (offset && offset > 0 && offset < fullText.length) {
    return fullText.slice(0, offset).trim();
  }

  return fullText.trim();
}

function withAuthToken(url: string) {
  if (!url || url.startsWith('data:') || /[?&]token=/.test(url)) return url;
  if (typeof window === 'undefined') return url;
  const token = localStorage.getItem('auth_token');
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function normalizeMessageDocuments(message: any): DocumentInfo[] {
  const raw = Array.isArray(message?.documents)
    ? message.documents
    : (message?.document ? [message.document] : []);
  const docs: DocumentInfo[] = [];
  const seen = new Set<string>();

  for (const doc of raw) {
    if (!doc || typeof doc !== 'object') continue;
    const key = doc.id || doc.url || doc.filename || `${doc.title || 'doc'}-${docs.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push(doc as DocumentInfo);
  }

  // Extract documents from Write tool calls, then apply subsequent Edit operations
  const previewExts = ['md', 'txt', 'html', 'json', 'xml', 'yaml', 'yml', 'csv'];
  if (Array.isArray(message?.toolCalls)) {
    // First pass: collect initial Write content per file path
    const fileContents = new Map<string, string>();
    const fileOrder: string[] = [];
    for (const tc of message.toolCalls) {
      if (tc.name === 'Write' && tc.input?.file_path && tc.input?.content) {
        const fp = tc.input.file_path as string;
        fileContents.set(fp, tc.input.content);
        if (!fileOrder.includes(fp)) fileOrder.push(fp);
      }
    }
    // Second pass: apply Edit operations to the accumulated content
    for (const tc of message.toolCalls) {
      if ((tc.name === 'Edit' || tc.name === 'MultiEdit') && tc.input?.file_path && tc.input?.old_string != null && tc.input?.new_string != null) {
        const fp = tc.input.file_path as string;
        const current = fileContents.get(fp);
        if (current != null) {
          fileContents.set(fp, current.replaceAll(tc.input.old_string, tc.input.new_string));
        }
      }
    }
    // Create document entries from final content
    for (const fp of fileOrder) {
      const fileName = fp.split(/[/\\]/).pop() || fp;
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      if (!previewExts.includes(ext)) continue;
      const key = `write-${fp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        id: key,
        title: fileName,
        filename: fileName,
        url: '',
        content: fileContents.get(fp) || '',
        format: normalizeGeneratedDocumentFormat(fileName, fileContents.get(fp) || ''),
      });
    }
  }

  return docs;
}

function parseInlineArtifactDisplay(content: any): { cleanedContent: string; draft: DocumentDraftInfo | null } | null {
  if (typeof content !== 'string' || !content.includes('<cp_artifact')) return null;

  const openMatch = content.match(/<cp_artifact\s+([^>]*)>/i);
  if (!openMatch || openMatch.index === undefined) return null;

  const attrsRaw = openMatch[1] || '';
  const title = (attrsRaw.match(/title="([^"]*)"/i)?.[1] || '').trim() || 'Untitled document';
  const format = (attrsRaw.match(/format="([^"]*)"/i)?.[1] || 'markdown').trim() || 'markdown';
  const openTag = openMatch[0];
  const bodyStart = openMatch.index + openTag.length;
  const closeTag = '</cp_artifact>';
  const closeIdx = content.indexOf(closeTag, bodyStart);

  if (closeIdx === -1) {
    const preview = content.slice(bodyStart).replace(/^\n/, '');
    const cleanedContent = content.slice(0, openMatch.index).trim().replace(/\n{3,}/g, '\n\n');
    return {
      cleanedContent,
      draft: {
        draftId: `inline-${title}-${format}`,
        title,
        format,
        preview,
        previewAvailable: preview.length > 0,
        done: false,
      },
    };
  }

  const preview = content.slice(bodyStart, closeIdx).replace(/^\n/, '');
  const before = content.slice(0, openMatch.index);
  const after = content.slice(closeIdx + closeTag.length);
  const cleanedContent = `${before}${after}`.trim().replace(/\n{3,}/g, '\n\n');

  return {
    cleanedContent,
    draft: {
      draftId: `inline-${title}-${format}`,
      title,
      format,
      preview,
      previewAvailable: preview.length > 0,
      done: true,
    },
  };
}

// Apply a research_* SSE event to the last assistant message in a messages array.
// Returns a new messages array (mutates a clone of the last message).
function applyResearchEvent(prev: any[], event: string, data: any): any[] {
  const newMsgs = [...prev];
  const lastIdx = newMsgs.length - 1;
  const lastMsg = newMsgs[lastIdx];
  if (!lastMsg || lastMsg.role !== 'assistant') return prev;
  const research = { ...(lastMsg.research || { sub_agents: [], sources: [], phase: null, plan: null, report: null, completed: false }) };
  research.sub_agents = [...(research.sub_agents || [])];
  research.sources = [...(research.sources || [])];
  switch (event) {
    case 'research_phase':
      research.phase = data.phase;
      research.phase_label = data.label;
      break;
    case 'research_plan':
      research.plan = { title: data.title, sub_questions: data.sub_questions };
      break;
    case 'research_subagent_started': {
      const exists = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (!exists) {
        research.sub_agents.push({
          id: data.sub_agent_id,
          index: data.index,
          sub_question: data.sub_question,
          status: 'running',
          sources: [],
          findings: '',
        });
      }
      break;
    }
    case 'research_source': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.sources = [...sub.sources, data.source];
      }
      // Global dedupe
      const exists = research.sources.find((s: any) => s.url === data.source.url);
      if (!exists) research.sources.push(data.source);
      break;
    }
    case 'research_finding': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.findings = data.markdown || '';
      }
      break;
    }
    case 'research_subagent_done': {
      const sub = research.sub_agents.find((a: any) => a.id === data.sub_agent_id);
      if (sub) {
        sub.status = data.error ? 'error' : 'done';
        if (data.error) sub.error = data.error;
      }
      break;
    }
    case 'research_report':
      research.report = data.markdown;
      break;
    case 'research_done':
      research.completed = true;
      research.duration_ms = data.duration_ms;
      break;
    case 'research_error':
      research.error = data.error;
      research.completed = true;
      break;
  }
  newMsgs[lastIdx] = { ...lastMsg, research };
  return newMsgs;
}

function sanitizeInlineArtifactMessage(message: any) {
  if (!message || message.role !== 'assistant') return message;
  const parsed = parseInlineArtifactDisplay(message.content);
  if (!parsed) return message;

  let next = { ...message, content: parsed.cleanedContent };
  if (parsed.draft && normalizeMessageDocuments(next).length === 0) {
    next = mergeDocumentDraftIntoMessage(next, parsed.draft);
  }
  return next;
}

function mergeDocumentsIntoMessage(message: any, incomingDoc?: DocumentInfo | null, incomingDocs?: DocumentInfo[] | null) {
  const merged = [...normalizeMessageDocuments(message)];
  const queue = [
    ...(Array.isArray(incomingDocs) ? incomingDocs : []),
    ...(incomingDoc ? [incomingDoc] : []),
  ];

  for (const doc of queue) {
    if (!doc || typeof doc !== 'object') continue;
    const key = doc.id || doc.url || doc.filename || doc.title;
    if (!key) continue;
    const index = merged.findIndex(item => (item.id || item.url || item.filename || item.title) === key);
    if (index >= 0) merged[index] = doc;
    else merged.push(doc);
  }

  if (merged.length === 0) return message;
  return { ...message, document: merged[merged.length - 1], documents: merged };
}

function applyGenerationState(message: any, state: any) {
  const base = {
    ...message,
    content: state.text || message.content,
    thinking: state.thinking || message.thinking,
    thinkingSummary: state.thinkingSummary || message.thinkingSummary,
    citations: state.citations?.length ? state.citations : message.citations,
    searchLogs: state.searchLogs?.length ? state.searchLogs : message.searchLogs,
    isThinking: !state.text && !!state.thinking,
  };
  const withDocuments = mergeDocumentsIntoMessage(base, state.document, state.documents);
  const drafts = Array.isArray(state?.documentDrafts) ? state.documentDrafts : [];
  const withDrafts = drafts.length === 0
    ? withDocuments
    : drafts.reduce((acc, draft) => mergeDocumentDraftIntoMessage(acc, draft), withDocuments);
  return sanitizeInlineArtifactMessage(withDrafts);
}

function normalizeDocumentDrafts(message: any): DocumentDraftInfo[] {
  const raw = Array.isArray(message?.documentDrafts) ? message.documentDrafts : [];
  const last = raw[raw.length - 1];
  if (!last || typeof last !== 'object') return [];
  const key = last.draftId || last.draft_id || last.title || 'draft';
  return [{
    draftId: key,
    title: last.title,
    format: last.format,
    preview: last.preview,
    previewAvailable: last.previewAvailable ?? last.preview_available,
    done: !!last.done,
  }];
}

function mergeDocumentDraftIntoMessage(message: any, incomingDraft: any) {
  if (!incomingDraft || typeof incomingDraft !== 'object') return message;
  const draftId = incomingDraft.draftId || incomingDraft.draft_id || incomingDraft.title;
  if (!draftId) return message;

  const current = normalizeDocumentDrafts(message)[0] || null;
  const nextDraft: DocumentDraftInfo = {
    draftId,
    title: incomingDraft.title,
    format: incomingDraft.format,
    preview: incomingDraft.preview ?? incomingDraft.document?.content,
    previewAvailable: incomingDraft.previewAvailable ?? incomingDraft.preview_available ?? !!incomingDraft.document?.content,
    done: !!incomingDraft.done,
  };
  const merged: DocumentDraftInfo = current
    ? {
      ...current,
      ...nextDraft,
      draftId: current.draftId || nextDraft.draftId,
      title: nextDraft.title || current.title,
      format: nextDraft.format || current.format,
      preview: nextDraft.preview ?? current.preview,
      previewAvailable: nextDraft.previewAvailable ?? current.previewAvailable,
      done: typeof incomingDraft.done === 'boolean' ? incomingDraft.done : current.done,
    }
    : nextDraft;

  return { ...message, documentDrafts: [merged] };
}

interface MainContentProps {
  onNewChat: () => void; // Callback to tell sidebar to refresh
  resetKey?: number;
  tunerConfig?: any;
  onOpenDocument?: (doc: DocumentInfo) => void;
  onArtifactsUpdate?: (docs: DocumentInfo[]) => void;
  onOpenArtifacts?: () => void;
  onTitleChange?: (title: string) => void;
  onChatModeChange?: (isChat: boolean) => void;
}

// 草稿存储：在切换对话、打开设置页面时保留输入内容和附件
const draftsStore = new Map<string, { text: string; files: PendingFile[]; height: number }>();

interface ModelCatalog {
  common: SelectableModel[];
  all: SelectableModel[];
  fallback_model: string | null;
}

/** Memoized message list — skips re-render when only inputText changes */
interface MessageListProps {
  messages: any[];
  loading: boolean;
  currentModelString: string;
  expandedMessages: Set<number>;
  editingMessageIdx: number | null;
  editingContent: string;
  copiedMessageIdx: number | null;
  compactStatus: { state: string; message?: string };
  onSetEditingContent: (v: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onToggleExpand: (idx: number) => void;
  onResend: (content: string, idx: number) => void;
  onEdit: (content: string, idx: number) => void;
  onCopy: (content: string, idx: number) => void;
  onOpenDocument?: (doc: DocumentInfo) => void;
  onSetMessages: React.Dispatch<React.SetStateAction<any[]>>;
  messageContentRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  /**
   * 打开「研究」徽章对应的资料面板。
   *
   * 【2026-09-19 修】这个 prop 原来**不存在**，而子组件里直接调了
   * `setOpenedResearchMsgId(msg.id)` —— 那是**父组件的 state setter**，
   * MessageList 是 React.memo 独立组件、闭包里根本没这个名字。
   * TS 报 TS2304，运行时点「研究」徽章会直接 ReferenceError 崩掉。
   */
  onOpenResearch: (msgId: string) => void;
}

const MessageList = React.memo<MessageListProps>(({
  messages, loading, currentModelString, expandedMessages, editingMessageIdx, editingContent,
  copiedMessageIdx, compactStatus, onSetEditingContent, onEditCancel, onEditSave,
  onToggleExpand, onResend, onEdit, onCopy, onOpenDocument, onSetMessages,
  messageContentRefs, onOpenResearch,
}) => {
  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .animate-shimmer-text {
          background: linear-gradient(90deg, var(--text-claude-secondary) 45%, var(--text-claude-main) 50%, var(--text-claude-secondary) 55%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 4s linear infinite;
        }
      `}</style>
      {messages.map((msg: any, idx: number) => (
        <div key={idx} className="mb-6 group">
          {(msg.is_summary === 1 || msg.is_compact_boundary) && (
            <div className="flex items-center gap-3 mb-5 mt-2">
              <div className="flex-1 h-px bg-claude-border" />
              <span className="text-[12px] text-claude-textSecondary whitespace-nowrap">Context compacted above this point</span>
              <div className="flex-1 h-px bg-claude-border" />
            </div>
          )}
          {(msg.is_summary === 1 || msg.is_compact_boundary) ? null : msg.role === 'user' ? (
            editingMessageIdx === idx ? (
              <div className="w-full bg-[#F0EEE7] dark:bg-claude-btnHover rounded-xl p-3 border border-black/5 dark:border-white/10">
                <div className="bg-white dark:bg-black/20 rounded-lg border border-black/10 dark:border-white/10 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all p-3">
                  <textarea
                    className="w-full bg-transparent text-claude-text outline-none resize-none text-[16px] leading-relaxed font-sans font-[350] block"
                    value={editingContent}
                    onChange={(e) => {
                      onSetEditingContent(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    onKeyDown={(e) => { if (e.key === 'Escape') onEditCancel(); }}
                    ref={(el) => {
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                        el.focus();
                      }
                    }}
                    style={{ minHeight: '60px' }}
                  />
                </div>
                <div className="flex items-start justify-between mt-3 px-1 gap-4">
                  <div className="flex items-start gap-2 text-claude-textSecondary text-[13px] leading-tight pt-1">
                    <Info size={14} className="mt-0.5 shrink-0" />
                    <span>
                      Editing this message will remove it and all later messages from the current conversation, then resend the edited version.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={onEditCancel}
                      className="px-3 py-1.5 text-[13px] font-medium text-claude-text bg-white dark:bg-claude-bg border border-black/10 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-claude-hover rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={onEditSave}
                      disabled={!editingContent.trim() || editingContent === msg.content}
                      className="px-3 py-1.5 text-[13px] font-medium text-white bg-claude-text hover:bg-claude-textSecondary rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-end">
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="max-w-[85%] w-fit mb-1">
                    <MessageAttachments attachments={msg.attachments} onOpenDocument={onOpenDocument} />
                  </div>
                )}
                {(!msg.attachments || msg.attachments.length === 0) && msg.has_attachments === 1 && (
                  <div className="max-w-[85%] w-fit mb-1">
                    <div className="bg-[#F0EEE7] dark:bg-claude-btnHover text-claude-textSecondary px-3.5 py-2 text-[14px] rounded-2xl font-sans italic">
                      📎 Files attached
                    </div>
                  </div>
                )}
                {(() => { const displayText = extractTextContent(msg.content); return displayText && displayText.trim() !== ''; })() && (
                  <div className="max-w-[85%] w-fit relative">
                    <div
                      className="bg-[#F0EEE7] dark:bg-claude-btnHover text-claude-text px-3.5 py-2.5 text-[16px] leading-relaxed font-sans font-[350] whitespace-pre-wrap break-words relative overflow-hidden"
                      style={{
                        maxHeight: expandedMessages.has(idx) ? 'none' : '300px',
                        borderRadius: ((() => {
                          const el = messageContentRefs.current.get(idx);
                          const isOverflow = el && el.scrollHeight > 300;
                          return isOverflow;
                        })()) ? '16px 16px 0 0' : '16px',
                      }}
                      ref={(el) => { if (el) messageContentRefs.current.set(idx, el); }}
                    >
                      {(() => {
                        try {
                          const text = extractTextContent(msg.content);
                          if (!text) return '';
                          const skillMatch = text.match(/^\/([a-zA-Z0-9_-]+)(\s|$)/);
                          if (skillMatch) {
                            const slug = skillMatch[1];
                            const rest = text.slice(skillMatch[0].length);
                            return <>
                              <span className="text-[#4B9EFA] font-medium">/{slug}</span>
                              {rest ? ' ' + rest : ''}
                            </>;
                          }
                          return text;
                        } catch { return extractTextContent(msg.content) || ''; }
                      })()}
                      {!expandedMessages.has(idx) && (() => {
                        const el = messageContentRefs.current.get(idx);
                        return el && el.scrollHeight > 300;
                      })() && (
                          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#F0EEE7] dark:from-claude-btnHover to-transparent pointer-events-none" />
                        )}
                    </div>
                    {(() => {
                      const el = messageContentRefs.current.get(idx);
                      const isOverflow = el && el.scrollHeight > 300;
                      if (!isOverflow) return null;
                      return (
                        <div className="bg-[#F0EEE7] dark:bg-claude-btnHover rounded-b-2xl px-3.5 pb-3 pt-1 -mt-[1px] relative" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                          <button onClick={() => onToggleExpand(idx)} className="text-[13px] text-claude-textSecondary hover:text-claude-text transition-colors">
                            {expandedMessages.has(idx) ? 'Show less' : 'Show more'}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1.5 pr-1">
                  {msg.created_at && (
                    <span className="text-[12px] text-claude-textSecondary mr-1">{formatMessageTime(msg.created_at)}</span>
                  )}
                  <div className="flex items-center gap-0.5 overflow-hidden transition-all duration-200 ease-in-out max-w-0 opacity-0 group-hover:max-w-[200px] group-hover:opacity-100">
                    <button onClick={() => onResend(msg.content, idx)} className="p-1 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover rounded transition-colors" title="重新发送"><RotateCcw size={14} /></button>
                    <button onClick={() => onEdit(msg.content, idx)} className="p-1 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover rounded transition-colors" title="编辑"><Pencil size={14} /></button>
                    <button onClick={() => onCopy(msg.content, idx)} className="p-1 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover rounded transition-colors" title="复制">
                      {copiedMessageIdx === idx ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="px-1 text-claude-text text-[16.5px] leading-normal mt-2">
              {(() => {
                const isStreamingAssistantTurn = Boolean(loading && idx === messages.length - 1);
                const messagePresentationModel = resolveMessagePresentationModel(msg, currentModelString, isStreamingAssistantTurn);
                const shouldUseThinkingModePresentation = isThinkingModel(messagePresentationModel);
                const shouldUseCompactToolPresentation = !shouldUseThinkingModePresentation && Boolean(
                  (msg.toolCalls && msg.toolCalls.length > 0) ||
                  msg.searchStatus ||
                  (msg.searchLogs && msg.searchLogs.length > 0)
                );
                const reasoningTimeline = msg.thinking
                  ? buildReasoningTimelineEvents(msg.thinking, {
                      summaryHint: msg.thinking_summary,
                      toolCalls: msg.toolCalls,
                      searchLogs: msg.searchLogs,
                      searchStatus: msg.searchStatus,
                      isThinking: Boolean(msg.isThinking || isStreamingAssistantTurn),
                    })
                  : null;
                const toolFallbackThinking = !msg.thinking && (shouldUseThinkingModePresentation || shouldUseCompactToolPresentation)
                  ? buildToolFallbackThinking(msg.toolCalls, {
                      summaryHint: extractToolSummaryHint(msg),
                      searchLogs: msg.searchLogs,
                      searchStatus: msg.searchStatus,
                    })
                  : null;
                const responseFallbackThinking = !msg.thinking && !toolFallbackThinking && !reasoningTimeline && shouldUseThinkingModePresentation
                  ? buildResponseFallbackThinking(extractTextContent(msg.content))
                  : null;
                const fallbackThinking = reasoningTimeline || toolFallbackThinking || responseFallbackThinking;
                // JS 模块（toolThinkingFallback.js）无类型声明，推断出的 kind 是宽 string，
                // 而 AssistantThinkingChain 要的是字面量联合（'direct'|'focus'|'tool'|…）。
                // 这里断言为目标类型 —— 值确实来自该模块的固定枚举，不是硬塞。
                const displayEvents = fallbackThinking?.events as AssistantThinkingEvent[] | undefined;
                const hasDetailedThinkingEvents = Boolean(
                  displayEvents?.some((event: any) => typeof event?.detail === 'string' && event.detail.trim().length > 0)
                );
                const shouldUseDetailedThinkingPresentation = Boolean(reasoningTimeline?.hasDetailedEvents || hasDetailedThinkingEvents);
                const showingSyntheticThinking = Boolean(shouldUseThinkingModePresentation && !msg.thinking && fallbackThinking);
                const syntheticThinkingInFlight = showingSyntheticThinking && loading && idx === messages.length - 1;
                const displayThinking = shouldUseThinkingModePresentation
                  ? msg.thinking || fallbackThinking?.thinking || ''
                  : fallbackThinking?.thinking || '';
                const displayThinkingSummary = msg.thinking_summary || fallbackThinking?.summary;
                const displayIsExtended = shouldUseDetailedThinkingPresentation;
                const defaultExpandedState = displayEvents?.length
                  ? true
                  : shouldUseDetailedThinkingPresentation
                    ? (
                        Boolean(msg.isThinking) ||
                        assistantHadLongThinking(msg) ||
                        showingSyntheticThinking ||
                        hasDetailedThinkingEvents
                      )
                    : false;
                const displayIsExpanded = Boolean(
                  msg.isThinkingExpanded ??
                  defaultExpandedState
                );
                const displayChainIsThinking = Boolean(
                  msg.isThinking ||
                  syntheticThinkingInFlight ||
                  (loading && idx === messages.length - 1 && displayEvents?.length)
                );

                (msg as any)._usesCompactThoughtChain = Boolean(
                  shouldUseCompactToolPresentation && displayEvents?.length
                );
                (msg as any)._compactActiveEvent = (msg as any)._usesCompactThoughtChain && displayChainIsThinking && displayEvents?.length
                  ? displayEvents[displayEvents.length - 1]
                  : null;

                if (!displayThinking && !displayEvents?.length) return null;

                return (
                <AssistantThinkingChain
                  thinking={displayThinking}
                  thinkingSummary={displayThinkingSummary}
                  isThinking={displayChainIsThinking}
                  isExtended={displayIsExtended}
                  isExpanded={displayIsExpanded}
                  events={displayEvents}
                  onToggleExpanded={() => {
                    onSetMessages(prev =>
                      prev.map((m, i) =>
                        i === idx
                          ? {
                              ...m,
                              isThinkingExpanded: !(
                                m.isThinkingExpanded ??
                                m.isThinking ??
                                showingSyntheticThinking
                              ),
                            }
                          : m
                      )
                    );
                  }}
                />
                );
              })()}
              {/* Research badge */}
              {msg.research && (
                <button
                  onClick={() => onOpenResearch(msg.id)}
                  className="mb-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#DBEAFE] dark:bg-[#1E3A5F] hover:bg-[#BFDBFE] dark:hover:bg-[#2A4A75] transition-colors"
                >
                  {msg.research.completed ? (
                    <IconResearch size={16} className="text-[#2E7CF6]" />
                  ) : (
                    <Loader2 size={16} className="text-[#2E7CF6] animate-spin" />
                  )}
                  <div className="text-left">
                    <div className="text-[12.5px] font-medium text-[#2E7CF6] leading-tight">
                      {msg.research.completed
                        ? `Research complete · ${(msg.research.sources || []).length} sources`
                        : msg.research.phase_label || 'Researching...'}
                    </div>
                    {msg.research.plan?.title && (
                      <div className="text-[11px] text-[#2E7CF6]/70 leading-tight mt-0.5 truncate max-w-[400px]">
                        {msg.research.plan.title}
                      </div>
                    )}
                  </div>
                </button>
              )}
              {/* Tool calls display */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (() => {
                const isStreamingAssistantTurn = Boolean(loading && idx === messages.length - 1);
                const messagePresentationModel = resolveMessagePresentationModel(msg, currentModelString, isStreamingAssistantTurn);
                const shouldUseThinkingModePresentation = isThinkingModel(messagePresentationModel);
                const shouldUseCompactToolPresentation = !shouldUseThinkingModePresentation && Boolean(
                  (msg.toolCalls && msg.toolCalls.length > 0) ||
                  msg.searchStatus ||
                  (msg.searchLogs && msg.searchLogs.length > 0)
                );
                if (shouldUseThinkingModePresentation || shouldUseCompactToolPresentation) {
                  const fullText = extractTextContent(msg.content);
                  const offset = msg.toolTextEndOffset;
                  const hasOffset = offset && offset > 0 && offset < fullText.length;
                  const finalText = hasOffset ? fullText.slice(offset).trim() : '';
                  const isCurrentlyStreaming = loading && idx === messages.length - 1;
                  (msg as any)._finalText = shouldUseCompactToolPresentation
                    ? isCurrentlyStreaming
                      ? ''
                      : (hasOffset ? finalText : fullText)
                    : extractTextContent(msg.content);
                  return null;
                }

                const visibleToolCalls = msg.toolCalls.filter((tc: any) => !HIDDEN_TOOL_NAMES.has(tc.name));
                if (visibleToolCalls.length === 0) return null;
                const isCurrentMsg = idx === messages.length - 1;
                const isStale = (!loading && isCurrentMsg) || (idx < messages.length - 1);

                // Split text: work text (during tools) vs final text (after last tool done)
                const fullText = extractTextContent(msg.content);
                const offset = msg.toolTextEndOffset;
                const hasOffset = offset && offset > 0 && offset < fullText.length;
                const workText = hasOffset ? fullText.slice(0, offset).trim() : '';
                const finalText = hasOffset ? fullText.slice(offset).trim() : '';
                const isCurrentlyStreaming = loading && idx === messages.length - 1;
                // Tag message for MarkdownRenderer below:
                // - Streaming with tools: show nothing in main area (all text in tool section)
                // - Complete with offset: show only final text
                // - Complete without offset: show full text (fallback)
                // During streaming: compute pending text (text after last tool's textBefore)
                let consumedLen = 0;
                for (const tc of visibleToolCalls) {
                  if (tc.textBefore) consumedLen += tc.textBefore.length;
                }
                // Text currently being typed that hasn't been associated with a tool yet
                const pendingWorkText_ui = isCurrentlyStreaming ? fullText.slice(consumedLen).trim() : '';

                (msg as any)._finalText = isCurrentlyStreaming
                  ? ''  // During streaming, all text goes in tool section
                  : (hasOffset ? finalText : null);

                const toolNames = visibleToolCalls.map((tc: any) => {
                  return getToolDisplayName(tc.name);
                });
                const uniqueNames = [...new Set(toolNames)];
                const allDone = visibleToolCalls.every((tc: any) => {
                  const rs = (tc.status === 'running' && isStale) ? 'canceled' : tc.status;
                  return rs !== 'running';
                });
                const hasError = visibleToolCalls.some((tc: any) => tc.status === 'error');
                const summary = uniqueNames.join(', ');

                return (
                  <div className="mb-4">
                    <div className={`rounded-lg overflow-hidden ${!allDone ? 'bg-black/[0.04] dark:bg-white/[0.04]' : ''}`}>
                    <div
                      className="flex items-center gap-2 cursor-pointer select-none group/tool text-claude-textSecondary hover:text-claude-text transition-colors px-2 py-1.5"
                      onClick={() => {
                        onSetMessages(prev =>
                          prev.map((m, i) =>
                            i === idx ? { ...m, isToolCallsExpanded: !m.isToolCallsExpanded } : m
                          )
                        );
                      }}
                    >
                      {!allDone && (
                        <FileText size={16} className="text-claude-textSecondary animate-pulse" />
                      )}
                      {allDone && !hasError && (
                        <Check size={16} className="text-claude-textSecondary" />
                      )}
                      {allDone && hasError && (
                        <span className="text-red-400 text-[14px]">✗</span>
                      )}
                      <span className={`text-[14px] ${!allDone ? 'animate-shimmer-text' : 'text-claude-textSecondary'}`}>
                        {summary}
                      </span>
                      <ChevronDown size={14} className={`transform transition-transform duration-200 ${(msg.isToolCallsExpanded ?? (isCurrentlyStreaming || !allDone)) ? 'rotate-180' : ''}`} />
                    </div>
                    </div>

                    {(msg.isToolCallsExpanded ?? (isCurrentlyStreaming || !allDone)) && (
                      <div className="mt-2 ml-1 pl-4 border-l-2 border-claude-border space-y-2">
                        {visibleToolCalls.map((tc: any, tcIdx: number) => {
                          const inputStr = tc.input ? (typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)) : '';
                          const rawPath = tc.input?.file_path || tc.input?.path || '';
                          const shortPath = rawPath ? rawPath.split(/[/\\]/).pop() || rawPath : '';
                          const actionLabel: Record<string, string> = {
                            'Read': 'Read', 'Write': 'Write', 'Edit': 'Edit',
                            'MultiEdit': 'Edit', 'Bash': '', 'Grep': 'Search',
                            'Glob': 'Find', 'ListDir': 'List', 'Skill': 'Skill',
                          };
                          const prefix = actionLabel[tc.name] ?? tc.name;
                          const fileOrCmd = shortPath || tc.input?.command || (inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr);
                          const inputPreview = (prefix && fileOrCmd) ? `${prefix} ${fileOrCmd}` : (fileOrCmd || prefix || tc.name);
                          const realStatus = (tc.status === 'running' && isStale) ? 'canceled' : tc.status;
                          const expandable = hasExpandableContent(tc.name, tc.input, tc.result);
                          const stats = getToolStats(tc.name, tc.input);

                          return (
                            <div key={tc.id || tcIdx}>
                              {/* Interleaved text: what the model said BEFORE this tool call */}
                              {tc.textBefore && (
                                <div className="text-[13px] text-claude-textSecondary px-1 py-1.5 leading-relaxed">
                                  {tc.textBefore}
                                </div>
                              )}
                              {/* Tool card */}
                              <div className="text-[13px] bg-black/5 dark:bg-black/20 rounded-lg overflow-hidden border border-black/5 dark:border-white/5 mx-1 w-full">
                                <div
                                  className={`flex items-center justify-between px-3 py-2 transition-colors ${expandable ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5' : ''}`}
                                  onClick={() => {
                                    if (!expandable) return;
                                    onSetMessages(prev =>
                                      prev.map((m, i) => {
                                        if (i !== idx) return m;
                                        const newTc = [...m.toolCalls];
                                        newTc[tcIdx] = { ...newTc[tcIdx], isExpanded: newTc[tcIdx].isExpanded === undefined ? true : !newTc[tcIdx].isExpanded };
                                        return { ...m, toolCalls: newTc };
                                      })
                                    );
                                  }}
                                >
                                  <div className="flex items-center gap-2 overflow-hidden">
                                    {tc.name === 'Bash' ? (
                                      <span className="text-claude-textSecondary font-mono font-bold">&gt;_</span>
                                    ) : (
                                      <FileText size={14} className="text-claude-textSecondary flex-shrink-0" />
                                    )}
                                    <span className="text-claude-text font-mono text-[12px] truncate">
                                      {inputPreview || tc.name}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                                    {stats && realStatus !== 'running' && (
                                      <span className="text-[11px] font-mono flex items-center gap-1.5">
                                        {stats.added > 0 && <span className="text-green-500 dark:text-green-400">+{stats.added}</span>}
                                        {stats.removed > 0 && <span className="text-red-500 dark:text-red-400">-{stats.removed}</span>}
                                      </span>
                                    )}
                                    {realStatus === 'running' && <span className="text-claude-textSecondary text-[12px] animate-shimmer-text">Running...</span>}
                                    {realStatus === 'error' && <span className="text-red-400/80 text-[12px]">Failed</span>}
                                    {expandable && (
                                      <ChevronDown size={14} className={`text-claude-textSecondary transform transition-transform duration-200 ${(tc.isExpanded ?? false) ? 'rotate-180' : ''}`} />
                                    )}
                                  </div>
                                </div>
                                {expandable && (tc.isExpanded ?? false) && (
                                  <div className="px-2 py-2 border-t border-black/5 dark:border-white/5">
                                    {shouldUseDiffView(tc.name, tc.input) ? (
                                      <ToolDiffView toolName={tc.name} input={tc.input} result={tc.result} />
                                    ) : tc.result != null ? (
                                      <div className="px-1 text-claude-textSecondary text-[12px] font-mono max-h-[400px] overflow-y-auto whitespace-pre-wrap bg-black/5 dark:bg-black/40 rounded-md p-2">
                                        {typeof tc.result === 'string' ? (tc.result.length > 2000 ? tc.result.slice(0, 2000) + '...' : tc.result || '(Empty output)') : JSON.stringify(tc.result).slice(0, 2000)}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {/* Streaming: show latest text being generated */}
                        {isCurrentlyStreaming && pendingWorkText_ui && (
                          <div className="text-[13px] text-claude-textSecondary px-1 py-1.5 leading-relaxed animate-shimmer-text">
                            {pendingWorkText_ui}
                          </div>
                        )}
                        {allDone && !isCurrentlyStreaming && (
                          <div className="flex items-center gap-2 text-claude-textSecondary pt-1 pb-1">
                            <Check size={14} />
                            <span className="text-[13px]">Done</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
              {!isThinkingModel(resolveMessagePresentationModel(msg, currentModelString, Boolean(loading && idx === messages.length - 1))) && !(msg as any)._usesCompactThoughtChain && msg.searchStatus && (!msg.searchLogs || msg.searchLogs.length === 0) && (!msg.content || msg.content.length === (msg._contentLenBeforeSearch || 0)) && loading && idx === messages.length - 1 && (
                <div className="flex items-center justify-center gap-2 text-[15px] font-medium mb-4 w-full">
                  <Globe size={18} className="text-claude-textSecondary" />
                  <span className="animate-shimmer-text">
                    Searching the web
                  </span>
                </div>
              )}

              {!isThinkingModel(resolveMessagePresentationModel(msg, currentModelString, Boolean(loading && idx === messages.length - 1))) && !(msg as any)._usesCompactThoughtChain && msg.searchLogs && msg.searchLogs.length > 0 && (
                <SearchProcess logs={msg.searchLogs} isThinking={msg.isThinking} isDone={(msg.content || '').length > (msg._contentLenBeforeSearch || 0)} />
              )}

              {normalizeDocumentDrafts(msg).length > 0 && (
                <DocumentCreationProcess drafts={normalizeDocumentDrafts(msg)} />
              )}

              {/* 【2026-09-20】slash 命令的输出是**终端风格的纯文本**（靠缩进对齐：
                  `  Name: xxx`、`    1. key 待用 ok=0`）。
                  走 MarkdownRenderer 会被折叠空格、丢掉缩进层级，
                  用户感受就是「web 的 slash 命令比 CLI 敷衍」—— 其实内容一样。
                  这里单独用 <pre> 保留原始空白。 */}
              {(msg as any).isCommandOutput ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.5] text-claude-text m-0">{extractTextContent(msg.content)}</pre>
              ) : (
                <MarkdownRenderer content={(msg as any)._finalText ?? extractTextContent(msg.content)} citations={msg.citations} />
              )}
              {Array.isArray((msg as any).presents) && (msg as any).presents.length > 0 && (
                <div className="mt-1">
                  {(msg as any).presents.map((p: any, pi: number) => (
                    <PresentBlock key={`${p?.at || pi}-${pi}`} payload={p} />
                  ))}
                </div>
              )}
              {(() => {
                const compactActiveEvent = (msg as any)._compactActiveEvent;
                if (!(msg as any)._usesCompactThoughtChain || !compactActiveEvent) return null;

                return (
                  <AssistantThinkingCompactStatus
                    event={compactActiveEvent}
                    isThinking={Boolean(loading && idx === messages.length - 1)}
                  />
                );
              })()}
              {(() => {
                const documents = normalizeMessageDocuments(msg);
                if (documents.length === 0) return null;
                const stackedPreview = documents.length > 1;

                return (
                  <div className="mt-2 mb-1 space-y-2">
                    {documents.map((doc, docIdx) => (
                      <DocumentCard
                        key={doc.id || `${idx}-${docIdx}`}
                        document={doc}
                        onOpen={(openedDoc) => onOpenDocument?.(openedDoc)}
                        stackedPreview={stackedPreview}
                      />
                    ))}
                  </div>
                );
              })()}
              {msg.codeExecution && (
                <CodeExecution
                  code={msg.codeExecution.code}
                  status={msg.codeExecution.status}
                  stdout={msg.codeExecution.stdout}
                  stderr={msg.codeExecution.stderr}
                  images={msg.codeExecution.images}
                  error={msg.codeExecution.error}
                />
              )}
              {!msg.codeExecution && (msg as any).codeImages && (msg as any).codeImages.length > 0 && (
                <div className="my-3 space-y-2">
                  {(msg as any).codeImages.map((url: string, i: number) => (
                    <div key={i} className="rounded-lg overflow-hidden">
                      <img src={withAuthToken(url)} alt={`图表 ${i + 1}`} className="max-w-full" />
                    </div>
                  ))}
                </div>
              )}
              {(() => {
                const isLastMessage = idx === messages.length - 1;
                const compactActiveEvent = (msg as any)._compactActiveEvent;
                const hasDocumentDrafts = normalizeDocumentDrafts(msg).length > 0;
                const hasToolCalls = Boolean(msg.toolCalls && msg.toolCalls.length > 0);
                const didLongThinking = assistantHadLongThinking(msg);
                const tailPhase = !isLastMessage
                  ? null
                  : loading && !msg.content && !msg.searchStatus && !hasDocumentDrafts && !hasToolCalls
                    ? 'waiting'
                    : loading && !msg.isThinking && (msg.content || (msg.searchStatus && msg.content))
                      ? 'streaming'
                      : !loading && msg.content
                        ? 'done'
                        : null;

                if (!tailPhase) return null;
                if (compactActiveEvent && tailPhase !== 'done') return null;

                const tailIndicator = (
                  <span className="inline-flex ml-1.5 align-middle" style={{ verticalAlign: '-0.18em' }}>
                    <AssistantActivityIndicator
                      phase={tailPhase}
                      didLongThinking={didLongThinking}
                      size={28}
                      interactive={tailPhase === 'done'}
                      className="inline-block"
                    />
                  </span>
                );

                if (tailPhase === 'done') {
                  return (
                    <>
                      <div className="mt-3 flex items-start">
                        {tailIndicator}
                      </div>
                      {compactStatus.state === 'compacting' && (
                        <div className="mt-3">
                          <CompactingStatus />
                        </div>
                      )}
                    </>
                  );
                }

                return tailIndicator;
              })()}
            </div>
          )}
        </div>
      ))}
    </>
  );
});

const MainContent = ({ onNewChat, resetKey, tunerConfig, onOpenDocument, onArtifactsUpdate, onOpenArtifacts, onTitleChange, onChatModeChange }: MainContentProps) => {
  const { id } = useParams(); // Get conversation ID from URL
  const location = useLocation();
  const [localId, setLocalId] = useState<string | null>(null);
  const [showEntranceAnimation, setShowEntranceAnimation] = useState(false);

  // Use localId if we just created a chat, effectively overriding the lack of URL param until next true navigation
  const activeId = id || localId || null;

  const navigate = useNavigate();
  const [inputText, setInputText] = useState("");
  const [slashSuggestions, setSlashSuggestions] = useState<SlashSuggestion[]>([]);
  const [slashSubcommands, setSlashSubcommands] = useState<Record<string, { candidates?: string[]; desc?: Record<string, string>; nested?: Record<string, { candidates?: string[]; desc?: Record<string, string> }> }>>({});
  const [slashIndex, setSlashIndex] = useState(0);
  // 向导弹窗状态。命令返回 kind:'wizard' 时（如 /config provider add 无参）
  // 服务端把 steps 发过来，这里渲染成表单 —— 与 CLI 的 runWizard 共用同一份定义。
  const [wizard, setWizard] = useState<{ id: string; title: string; steps: WizardStep[] } | null>(null);
  // 选择列表状态。命令返回 kind:'select' 时打开（如 /model 无参拉模型列表）。
  // 【2026-09-20】与 wizard 分开：wizard 是表单（输入框/radio），select 是
  // 「从一批里挑一个」——列表常几十项且要能搜索，两者渲染方式差别太大。
  const [selectReq, setSelectReq] = useState<SelectRequest | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Notify parent about artifacts
  useEffect(() => {
    if (onArtifactsUpdate) {
      const docsMap = new Map<string, DocumentInfo>();
      for (const message of messages) {
        for (const doc of normalizeMessageDocuments(message)) {
          const key = doc.id || doc.url || doc.filename || doc.title;
          if (!key) continue;
          docsMap.set(key, doc);
        }
      }
      const docs = Array.from(docsMap.values());
      onArtifactsUpdate(docs);
    }
  }, [messages, onArtifactsUpdate]);

  // Notify parent about Chat Mode and Title
  useEffect(() => {
    const isChat = !!(activeId || messages.length > 0);
    onChatModeChange?.(isChat);
  }, [activeId, messages.length, onChatModeChange]);


  // Model state
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const isSelfHostedMode = localStorage.getItem('user_mode') === 'selfhosted';

  // Self-hosted: read chat_models from localStorage synchronously to avoid flash of wrong models
  const selfHostedModels = useMemo<SelectableModel[]>(() => {
    if (!isSelfHostedMode) return [];
    try {
      const chatModels = sanitizeSelfHostedChatModels(JSON.parse(localStorage.getItem('chat_models') || '[]'));
      if (chatModels.length === 0) return [];
      const tierDescMap: Record<string, string> = {
        'opus': 'Most capable for ambitious work',
        'sonnet': 'Most efficient for everyday tasks',
        'haiku': 'Fastest for quick answers',
      };
      return chatModels.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        enabled: 1,
        tier: m.tier || 'extra',
        description: m.tier && tierDescMap[m.tier] ? tierDescMap[m.tier] : undefined,
      }));
    } catch { return []; }
  }, [isSelfHostedMode]);

  const fallbackCommonModels = useMemo<SelectableModel[]>(() => {
    // 【自建服务判定不该依赖 localStorage】原来这里卡 `isSelfHostedMode`
    // （读 localStorage.user_mode === 'selfhosted'）—— 但这个值在手机上不一定被
    // 设置过，于是明明连的是自建后端（/api/config 有 providers），却回退到
    // **硬编码的 Claude 模型列表**，输入栏的模型下拉因此几乎是空的。
    // 正确的判据：后端有没有下发 providers（有 = 自建/自定义，没有才用官方兜底）。
    const hasBackendProviders = (modelCatalog?.all?.length || selfHostedModels.length) > 0;
    if ((isSelfHostedMode || hasBackendProviders) && selfHostedModels.length > 0) {
      const tierOrder = ['opus', 'sonnet', 'haiku'];
      const common = tierOrder.map(t => selfHostedModels.find(m => m.tier === t)).filter(Boolean) as SelectableModel[];
      return common.length > 0 ? common : selfHostedModels;
    }
    return [
      { id: 'claude-opus-4-6', name: 'Opus 4.6', enabled: 1, description: 'Most capable for ambitious work' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', enabled: 1, description: 'Most efficient for everyday tasks' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', enabled: 1, description: 'Fastest for quick answers' },
    ];
  }, [isSelfHostedMode, selfHostedModels]);

  const displayCommonModels = modelCatalog?.common?.length ? modelCatalog.common : fallbackCommonModels;
  const selectorModels = useMemo<SelectableModel[]>(() => {
    const visible = [...displayCommonModels];
    // 【把后端下发的所有模型都补进下拉】原来这一步只在 isSelfHostedMode 时做，
    // 导致「common 为空 + 非自建模式」时下拉里只剩当前模型一个。
    // 现在只要后端给了模型列表就合并进来（去重）。
    {
      const seen = new Set(visible.map(m => `${m.providerId || ''}:${m.id}`));
      const extraModels = (modelCatalog?.all || []).filter(m => !seen.has(`${m.providerId || ''}:${m.id}`));
      for (const model of extraModels) {
        visible.push({ ...model, tier: model.tier || 'extra' });
        seen.add(`${model.providerId || ''}:${model.id}`);
      }
    }
    // 【同名去重已移除】曾在这里按 id 去重并优先保留「当前会话用的 Provider」那条，
    // 但 currentModelString 的 useState 声明在下方（第 1509 行附近），
    // 在这里读它命中 TDZ（Cannot access 'Z' before initialization），整个组件崩。
    // 输入栏下拉的重复条目改由数据源处理（chatModels 配置本身就是按 provider 存的）。
    return visible;
  }, [displayCommonModels, modelCatalog, isSelfHostedMode]);

  // Initial model: for self-hosted, prefer first configured model over hardcoded claude-sonnet-4-6
  const [currentModelString, setCurrentModelString] = useState(() => {
    const saved = localStorage.getItem('default_model');
    if (saved) return saved;
    if (isSelfHostedMode && selfHostedModels.length > 0) return selfHostedModels[0].id;
    return 'claude-sonnet-4-6';
  });
  const [conversationTitle, setConversationTitle] = useState("");
  // Clawparrot login-required gate: shown when an un-logged-in clawparrot user
  // tries to send their first message.
  const [showLoginRequired, setShowLoginRequired] = useState(false);
  const pendingLoginSendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onTitleChange?.(conversationTitle);
  }, [conversationTitle, onTitleChange]);

  const [user, setUser] = useState<any>(null);

  // Welcome greeting — randomized per new chat, time-aware
  const welcomeGreeting = useMemo(() => {
    const hour = new Date().getHours();
    const name = user?.display_name || user?.nickname || 'there';
    const timeGreetings = hour < 6
      ? [`夜猫子模式，${name}`, `还没睡吗，${name}？`, `这么晚还在忙吗，${name}？`]
      : hour < 12
        ? [`早上好，${name}`, `早安，${name}`, `新的一天开始了，${name}`]
        : hour < 18
          ? [`下午好，${name}`, `你好，${name}`, `今天想做些什么，${name}？`]
          : [`晚上好，${name}`, `晚上好，${name}`, `准备收尾了吗，${name}？`];
    const general = [`有什么我可以帮你？`, `今天需要什么帮助？`, `开始工作吧，${name}`, `随时可以开始，${name}`];
    const pool = [...timeGreetings, ...general];
    return pool[Math.floor(Math.random() * pool.length)];
  }, [resetKey, user?.nickname]);

  // 输入栏参数
  const inputBarWidth = 768;
  const inputBarMinHeight = 32;
  const inputBarRadius = 22;
  const inputBarBottom = 0;
  const inputBarBaseHeight = inputBarMinHeight + 16; // border-box: content + padding (pt-4=16px + pb-0=0px)
  const textareaHeightVal = useRef(inputBarBaseHeight);

  const isCreatingRef = useRef(false);
  const pendingInitialMessageRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestCountRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResetKeyRef = useRef(0);
  const streamConversationIdRef = useRef<string | null>(null);
  const streamRequestIdRef = useRef(0);

  // Per-conversation message buffer for multi-conversation streaming isolation
  const viewingIdRef = useRef<string | null>(null);
  const messagesBufferRef = useRef(new Map<string, any[]>());

  // Update messages for a specific conversation — only touches React state if it's the active conversation.
  //
  // Backfill safety net: setMessagesFor is called exclusively from streaming SSE event
  // handlers (text deltas, thinking deltas, tool events, done/error callbacks). They all
  // mutate the trailing assistant placeholder. If a race causes the updater to run BEFORE
  // the placeholder push has committed (rare but real — depends on React batching, async
  // boundaries, and SSE chunk timing), the original updaters silently dropped the event
  // via their `lastMsg.role === 'assistant'` guard.
  //
  // The fix: ensure the tail of `prev` is an assistant message before invoking the
  // updater. Existing callers don't change — their guard now always passes, and the
  // event lands on the backfilled placeholder. The bridge will overwrite this placeholder
  // with the canonical message + toolCalls when finishTurn flushes to db, so even if a
  // re-load races with backfill the persistent state stays correct.
  const setMessagesFor = useCallback((convId: string, updater: (prev: any[]) => any[]) => {
    const ensureUpdater = (prev: any[]) => {
      if (prev.length === 0) return updater(prev); // empty conv: don't synthesize a phantom placeholder
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') return updater(prev);
      // Tail is a user message (or other non-assistant). Backfill an assistant
      // placeholder so the trailing SSE event has somewhere to land instead of
      // being silently dropped by the updater's `lastMsg.role === 'assistant'` guard.
      const placeholderModel = getStoredMessageModel(last);
      return updater([
        ...prev,
        createAssistantPlaceholder(placeholderModel ? { model: placeholderModel } : {}),
      ]);
    };

    if (viewingIdRef.current === convId) {
      setMessages(prev => {
        const result = ensureUpdater(prev);
        messagesBufferRef.current.set(convId, result);
        return result;
      });
    } else {
      const prev = messagesBufferRef.current.get(convId) || [];
      messagesBufferRef.current.set(convId, ensureUpdater(prev));
    }
  }, []);

  const isModelSelectable = useCallback((modelString: string) => {
    const base = stripThinking(modelString);
    const pool = modelCatalog?.all || displayCommonModels;
    const found = pool.find(m => m.id === base);
    if (!found || Number(found.enabled) !== 1) return false;
    return !isThinkingModel(modelString) || found.thinkingId === modelString;
  }, [modelCatalog, displayCommonModels]);

  const resolveModelForNewChat = useCallback((preferredModel?: string | null) => {
    const saved = preferredModel || localStorage.getItem('default_model') || 'claude-sonnet-4-6';
    const base = stripThinking(saved);
    const all = modelCatalog?.all || displayCommonModels;
    const preferred = all.find(m => m.id === base);
    const thinking = isThinkingModel(saved) && preferred?.thinkingId === saved;
    if (preferred && Number(preferred.enabled) === 1) {
      return withThinking(base, thinking);
    }

    const fallbackBase = modelCatalog?.fallback_model
      || all.find(m => /sonnet/i.test(m.id) && Number(m.enabled) === 1)?.id
      || all.find(m => Number(m.enabled) === 1)?.id
      || base
      || 'claude-sonnet-4-6';
    return withThinking(fallbackBase, thinking);
  }, [displayCommonModels, modelCatalog]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const userScrolledUpRef = useRef(false);
  // 【2026-10-10 加】「回到底部」按钮显示状态 —— ref 不触发重渲染，
  // 需要一个 state 驱动按钮的出现/消失（对齐 APK 的 followBottom 机制）。
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const [copiedMessageIdx, setCopiedMessageIdx] = useState<number | null>(null);
  const [editingMessageIdx, setEditingMessageIdx] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const messageContentRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [inputHeight, setInputHeight] = useState(160);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [researchMode, setResearchMode] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(() => localStorage.getItem('web_thinking') !== '0');
  const [thinkingEffort, setThinkingEffort] = useState<string>(() => localStorage.getItem('web_thinking_effort') || 'xhigh');
  const handleThinkingChange = useCallback(async (enabled: boolean) => {
    setThinkingEnabled(enabled);
    localStorage.setItem('web_thinking', enabled ? '1' : '0');
    if (activeId) {
      try { await updateConversation(activeId, { thinking: enabled }); }
      catch (err) { console.error('Failed to update thinking mode', err); }
    }
  }, [activeId]);
  const handleThinkingEffortChange = useCallback(async (effort: string) => {
    setThinkingEffort(effort);
    localStorage.setItem('web_thinking_effort', effort);
    if (activeId) {
      try { await updateConversation(activeId, { thinkingEffort: effort }); }
      catch (err) { console.error('Failed to update thinking effort', err); }
    }
  }, [activeId]);
  const [openedResearchMsgId, setOpenedResearchMsgId] = useState<string | null>(null);
  const toggleResearchMode = useCallback(async () => {
    const next = !researchMode;
    setResearchMode(next);
    if (activeId) {
      try { await updateConversation(activeId, { research_mode: next }); } catch (_) {}
    }
  }, [researchMode, activeId]);

  // Provider web-search capability (derived from the current model's provider).
  // The bridge strips web_search_20250305 automatically when the provider doesn't support it,
  // so this state is purely a UI indicator — no need to persist or toggle.
  const [providersCache, setProvidersCache] = useState<Provider[]>([]);
  const [webSearchToast, setWebSearchToast] = useState<string | null>(null);
  // 运行时指标（轮 / 首字 / 吞吐 / 耗时构成）。数据来自服务端 agent.getMetrics()，
  // 与 CLI 状态行同源 —— 用户要求「和我们 cli 的一样计算」。
  const [runMetrics, setRunMetrics] = useState<{ avgFirstTokenMs?: number | null; tps?: number | null; turns?: number; llmMs?: number; toolMs?: number; toolCalls?: number } | null>(null);
  // 中断残局：服务端从磁盘恢复会话时若发现上一轮没跑完（进程重启/断连），
  // 会带 interrupted 标记。显示一条可点的提示，用户一键接着跑。
  const [interruptedInfo, setInterruptedInfo] = useState<{ detected: boolean; reason: string } | null>(null);
  // 目标契约：服务端在会话 payload 里带 goal，跨轮推进时显示进度
  const [goalInfo, setGoalInfo] = useState<{ objective: string; status: string; turnsUsed: number; turnBudget: number | null } | null>(null);
  // 轮数提醒：agent 快到 maxTurns 时服务端发 turn_limit 事件。
  // 原来 Web 完全没有这个提示 —— 用户看到 agent「突然停下」却不知道到了轮数上限。
  const [turnLimitToast, setTurnLimitToast] = useState<string | null>(null);
  const [voiceToast, setVoiceToast] = useState<string | null>(null);
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const [activeLandingPromptSection, setActiveLandingPromptSection] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const voiceBaseInputRef = useRef('');
  const voiceCommittedTranscriptRef = useRef('');
  useEffect(() => {
    getProviders().then(setProvidersCache).catch(() => {});
    const refreshProviders = () => { getProviders().then(setProvidersCache).catch(() => {}); };
    window.addEventListener('webModelsChanged', refreshProviders);
    return () => window.removeEventListener('webModelsChanged', refreshProviders);
  }, []);
  useEffect(() => {
    let cancelled = false;
    getSlashCommands(activeId || undefined).then(({ commands, skills, subcommands }) => {
      if (cancelled) return;
      // 子命令表：面板在「/config 」这种状态下列出候选（原来没有，靠用户背）
      setSlashSubcommands(subcommands || {});
      const activeSkills = (skills || []).filter((item: any) => !item.passive);
      setSlashSuggestions([
        ...(commands || []).map((item: any) => ({ name: item.name, description: item.description, kind: 'command' as const })),
        ...activeSkills.map((item: any) => ({ name: item.name, description: item.description, kind: 'skill' as const, passive: false })),
      ]);
      setEnabledSkills(activeSkills.map((item: any) => ({ id: item.name, name: item.name, description: item.description })));
    }).catch(() => { if (!cancelled) setSlashSuggestions([]); });
    return () => { cancelled = true; };
  }, [activeId]);
  const currentProviderSupportsWebSearch = useMemo(() => {
    if (!providersCache.length) return false;
    const bareModel = (currentModelString || '').replace(/-thinking$/, '');
    const provider = providersCache.find(p => p.model === bareModel || (p.models || []).some(m => m.id === bareModel));
    return provider?.supportsWebSearch === true;
  }, [providersCache, currentModelString]);
  useEffect(() => {
    if (!webSearchToast) return;
    const t = setTimeout(() => setWebSearchToast(null), 2800);
    return () => clearTimeout(t);
  }, [webSearchToast]);
  useEffect(() => {
    if (!turnLimitToast) return;
    const t = setTimeout(() => setTurnLimitToast(null), 12000);
    return () => clearTimeout(t);
  }, [turnLimitToast]);
  useEffect(() => {
    if (!voiceToast) return;
    const t = setTimeout(() => setVoiceToast(null), 2800);
    return () => clearTimeout(t);
  }, [voiceToast]);
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!loading || !lastMsg || lastMsg.role !== 'assistant' || !lastMsg.isThinking || assistantHadLongThinking(lastMsg)) {
      return;
    }

    const startedAt = typeof lastMsg._streamStartedAt === 'number' ? lastMsg._streamStartedAt : Date.now();
    const elapsed = Date.now() - startedAt;

    const markAsLongThinking = () => {
      setMessages((prev) => {
        const newMsgs = [...prev];
        const target = newMsgs[newMsgs.length - 1];
        if (!target || target.role !== 'assistant' || !target.isThinking || assistantHadLongThinking(target)) {
          return prev;
        }
        target._didLongThinking = true;
        if (activeId) {
          messagesBufferRef.current.set(activeId, newMsgs);
        }
        return newMsgs;
      });
    };

    if (elapsed >= LONG_THINKING_THRESHOLD_MS) {
      markAsLongThinking();
      return;
    }

    const timer = window.setTimeout(markAsLongThinking, LONG_THINKING_THRESHOLD_MS - elapsed);
    return () => window.clearTimeout(timer);
  }, [activeId, loading, messages]);
  useEffect(() => () => {
    try {
      recognitionRef.current?.abort();
    } catch {}
  }, []);
  const [showSkillsSubmenu, setShowSkillsSubmenu] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ name: string; slug: string; description?: string } | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  // Add-to-project state
  const [showProjectsSubmenu, setShowProjectsSubmenu] = useState(false);
  const [projectList, setProjectList] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [projectAddToast, setProjectAddToast] = useState<string | null>(null);
  const [compactStatus, setCompactStatus] = useState<{ state: 'idle' | 'compacting' | 'done' | 'error'; message?: string }>({ state: 'idle' });
  const [showCompactDialog, setShowCompactDialog] = useState(false);
  const [compactInstruction, setCompactInstruction] = useState('');
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null); // null = loading
  const [contextInfo, setContextInfo] = useState<{ tokens: number; limit: number; exact?: boolean } | null>(null);

  // AskUserQuestion state
  const [askUserDialog, setAskUserDialog] = useState<{
    request_id: string;
    tool_use_id: string;
    questions: Array<{ question: string; header?: string; options?: Array<string | { label: string; description?: string }>; multiSelect?: boolean }>;
    answers: Record<string, string>;
  } | null>(null);

  // Task/Agent progress state
  const [activeTasks, setActiveTasks] = useState<Map<string, { description: string; status?: string; summary?: string; last_tool_name?: string }>>(new Map());

  // Plan mode state
  const [planMode, setPlanMode] = useState(false);
  const [deepMode, setDeepMode] = useState(false);
  // Todo 面板：后端 emit('todos')，前端展示进度
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);

  // 草稿持久化 refs（跟踪最新值，供 effect cleanup 读取）
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const pendingFilesRef = useRef(pendingFiles);
  pendingFilesRef.current = pendingFiles;
  const textareaHeightRef = useRef(textareaHeightVal.current);
  textareaHeightRef.current = textareaHeightVal.current;

  // textarea 高度计算改为在 onChange 中直接操作 DOM（见 adjustTextareaHeight）
  const adjustTextareaHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = `${inputBarBaseHeight}px`;
    const sh = el.scrollHeight;
    const newH = sh > inputBarBaseHeight ? Math.min(sh, 316) : inputBarBaseHeight;
    el.style.height = `${newH}px`;
    el.style.overflowY = newH >= 316 ? 'auto' : 'hidden';
    textareaHeightVal.current = newH;
  }, [inputBarBaseHeight]);

  useEffect(() => {
    // If we have a URL param ID, clear any local ID to ensure we sync with source of truth
    if (id) {
      setLocalId(null);
    }
  }, [id]);

  // 检测滚动条宽度
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => setScrollbarWidth(el.offsetWidth - el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages]);

  // 动态调整 paddingBottom，使聊天列表能滚到输入框上方
  useEffect(() => {
    const el = inputWrapperRef.current;
    if (!el) return;

    const updateHeight = () => {
      // 底部留白 = 输入框高度 + 底部边距(48px)
      setInputHeight(el.offsetHeight + 48);
    };

    // 初始测量
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);

    return () => observer.disconnect();
  }, [activeId, messages.length]);

  // 用户滚轮向上时，立刻中止自动滚动
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledUpRef.current = true;
        isAtBottomRef.current = false;
        // 取消正在进行的 smooth scroll 动画
        el.scrollTo({ top: el.scrollTop });
        // 【2026-10-10】滚轮上翻 → 显示「回到底部」按钮
        setShowScrollButton(true);
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Load enabled skills for the plus menu
  useEffect(() => {
    if (!showPlusMenu) { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); return; }
    getSkills().then((data: any) => {
      const all = [...(data.examples || []), ...(data.my_skills || [])];
      setEnabledSkills(all.map((s: any) => ({ id: s.id || s.name, name: s.name, description: s.description })));
    }).catch(() => {});
    getProjects().then((data: Project[]) => {
      setProjectList((data || []).filter(p => !p.is_archived));
    }).catch(() => {});
  }, [showPlusMenu]);

  // 点击外部关闭加号菜单
  useEffect(() => {
    if (!showPlusMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMenu = plusMenuRef.current && plusMenuRef.current.contains(target);
      const insideButton = plusBtnRef.current && plusBtnRef.current.contains(target);
      if (!insideMenu && !insideButton) {
        setShowPlusMenu(false);
        setShowSkillsSubmenu(false);
        setShowProjectsSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPlusMenu]);

  // Reset when resetKey changes (New Chat clicked)
  useEffect(() => {
    if (resetKey && resetKey !== lastResetKeyRef.current) {
      lastResetKeyRef.current = resetKey;
      setLocalId(null);
      setMessages([]);
      setCurrentModelString(resolveModelForNewChat());
      setConversationTitle("");
      setContextInfo(null);
      setCurrentProjectId(null);
      setPendingProjectId(null);
      // 触发入场动画
      setShowEntranceAnimation(true);
      setTimeout(() => setShowEntranceAnimation(false), 800);
      isAtBottomRef.current = true;

      // Check for prefill input (from Create with Claude)
      const prefillInput = sessionStorage.getItem('prefill_input');
      if (prefillInput) {
        sessionStorage.removeItem('prefill_input');
        setTimeout(() => {
          setInputText(prefillInput);
          // Auto-resize textarea
          const ta = document.querySelector('textarea');
          if (ta) {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 316) + 'px';
          }
        }, 200);
      }

      const prefillModel = sessionStorage.getItem('prefill_model');
      if (prefillModel) {
        sessionStorage.removeItem('prefill_model');
        setCurrentModelString(prefillModel);
      }

      // Check for artifact prompt (from Artifacts page)
      const artifactPrompt = sessionStorage.getItem('artifact_prompt');
      if (artifactPrompt) {
        sessionStorage.removeItem('artifact_prompt');
        if (artifactPrompt === '__remix__') {
          // Remix mode: pre-load artifact into conversation
          const remixData = sessionStorage.getItem('artifact_remix');
          sessionStorage.removeItem('artifact_remix');
          if (remixData) {
            try {
              const remix = JSON.parse(remixData);
              // Inject pre-baked assistant message with artifact info
              const assistantMsg = {
                id: 'remix-' + Date.now(),
                role: 'assistant' as const,
                content: JSON.stringify([{ type: 'text', text: `I'll customize this artifact:\n\n**${remix.name}**\n\nTransform any artifact into something uniquely yours by customizing its core elements.\n\n1. Change the topic - Adapt the content for a different subject\n2. Update the style - Refresh the visuals or overall design\n3. Make it personal - Tailor specifically for your needs\n4. Share your vision - I'll bring it to life\n\nWhere would you like to begin?` }]),
                created_at: new Date().toISOString(),
              };
              setTimeout(() => {
                setMessages([assistantMsg]);
                // Open the artifact in DocumentPanel
                if (remix.code?.content && onOpenDocument) {
                  const isReactArtifact = remix.code?.type === 'application/vnd.ant.react';
                  onOpenDocument({
                    id: 'remix-artifact',
                    title: remix.code?.title || remix.name,
                    filename: (remix.code?.title || remix.name) + (isReactArtifact ? '.jsx' : '.html'),
                    url: '',
                    content: remix.code.content,
                    format: isReactArtifact ? 'jsx' : 'html',
                  });
                }
              }, 200);
            } catch {}
          }
        } else {
          // Normal artifact prompt: auto-send
          setTimeout(() => handleSend(artifactPrompt), 300);
        }
      }
    }
  }, [resetKey, resolveModelForNewChat]);

  useEffect(() => {
    let cancelled = false;
    const isSelfHosted = localStorage.getItem('user_mode') === 'selfhosted';
    const loadModels = async () => {
      try {
        let data: any;
        if (isSelfHosted) {
          // Self-hosted: use chat_models from localStorage (configured in Models settings)
          let chatModels: any[] = [];
          let rawChatModels: any[] = [];
          try { rawChatModels = JSON.parse(localStorage.getItem('chat_models') || '[]'); } catch {}
          chatModels = sanitizeSelfHostedChatModels(rawChatModels);
          if (JSON.stringify(rawChatModels) !== JSON.stringify(chatModels)) {
            localStorage.setItem('chat_models', JSON.stringify(chatModels));
          }
          if (chatModels.length > 0) {
            const tierDescMap: Record<string, string> = {
              'opus': 'Most capable for ambitious work',
              'sonnet': 'Most efficient for everyday tasks',
              'haiku': 'Fastest for quick answers',
            };
            const all = chatModels.map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              enabled: 1,
              tier: m.tier || 'extra',
              description: m.tier && tierDescMap[m.tier] ? tierDescMap[m.tier] : undefined,
            }));
            // Common = tier models (opus/sonnet/haiku), ordered by tier
            const tierOrder = ['opus', 'sonnet', 'haiku'];
            const common = tierOrder.map(t => all.find((m: any) => m.tier === t)).filter(Boolean);
            const savedSelfHostedDefault = stripThinking(localStorage.getItem('default_model') || '');
            const validSelfHostedDefault = all.find((m: any) => m.id === savedSelfHostedDefault && Number(m.enabled) === 1)?.id;
            const availableSelfHostedFallback = all.find((m: any) => /sonnet/i.test(m.id) && Number(m.enabled) === 1)?.id
              || all.find((m: any) => Number(m.enabled) === 1)?.id
              || 'claude-sonnet-4-6';
            data = {
              all,
              common: common.length > 0 ? common : all,
              fallback_model: validSelfHostedDefault || availableSelfHostedFallback,
            };
          } else {
            // 没有单独的 chat_models 配置时，使用 Web 后端返回的真实模型列表。
            const pModels = await getUserModels();
            const all = (pModels.all || []).map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              providerId: m.providerId,
              enabled: Number(m.enabled) === 0 ? 0 : 1,
              tier: m.tier === 'opus' || m.tier === 'sonnet' || m.tier === 'haiku' ? m.tier : 'extra',
              thinkingId: m.thinkingId,
            }));
            const availableSelfHostedFallback = pModels.fallback_model || all.find((m: any) => Number(m.enabled) === 1)?.id || 'claude-sonnet-4-6';
            data = { all, common: pModels.common?.length ? pModels.common : all, fallback_model: availableSelfHostedFallback };
          }
        } else {
          data = await getUserModels();
          // Enrich known Anthropic models with descriptions
          const descMap: Record<string, string> = {
            'claude-opus-4-6': 'Most capable for ambitious work',
            'claude-sonnet-4-6': 'Most efficient for everyday tasks',
            'claude-haiku-4-5-20251001': 'Fastest for quick answers',
          };
          for (const list of [data?.common, data?.all]) {
            if (!Array.isArray(list)) continue;
            for (const m of list) {
              if (descMap[m.id] && !m.description) m.description = descMap[m.id];
            }
          }
        }
        if (cancelled) return;
        setModelCatalog(data);
        if (!viewingIdRef.current) {
          setCurrentModelString(prev => {
            // 【2026-09-19 修】原来是 `prev || localStorage...` —— prev 只要不是空串就短路，
            // 而 prev 常常是「硬编码默认值 claude-sonnet-4-6」（首次挂载时 localStorage 还没有
            // default_model，useState 就落到那个兜底值），于是**用户存过的选择永远读不到**，
            // 表现就是「我选的模型下次进来又不是它」。
            // 规则改成：localStorage 有值就以它为准（用户明确选过的），否则才用 prev。
            const stored = localStorage.getItem('default_model');
            const current = stored || prev || 'claude-sonnet-4-6';
            const thinking = isThinkingModel(current);
            const base = stripThinking(current);
            const all: SelectableModel[] = data?.all?.length ? data.all : fallbackCommonModels;
            const preferred = all.find((m: SelectableModel) => m.id === base && Number(m.enabled) === 1);
            if (preferred) return withThinking(base, thinking);
            const fallbackBase = data?.fallback_model
              || all.find((m: SelectableModel) => /sonnet/i.test(m.id) && Number(m.enabled) === 1)?.id
              || all.find((m: SelectableModel) => Number(m.enabled) === 1)?.id
              || base
              || 'claude-sonnet-4-6';
            return withThinking(fallbackBase, thinking);
          });
        }
      } catch {
        // ignore
      }
    };
    loadModels();
    // /model 等命令改了 Provider 模型后立即刷新，不用等 60s 轮询。
    const handleModelsChanged = () => { loadModels(); };
    window.addEventListener('webModelsChanged', handleModelsChanged);
    const timer = setInterval(loadModels, 60000);
    return () => {
      cancelled = true;
      window.removeEventListener('webModelsChanged', handleModelsChanged);
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackCommonModels]);

  // 草稿持久化：切换对话 / 打开设置页面时保存，切回时恢复
  const draftKey = activeId || '__new__';
  useEffect(() => {
    const saved = draftsStore.get(draftKey);
    if (saved) {
      setInputText(saved.text);
      setPendingFiles(saved.files);
      textareaHeightVal.current = saved.height;
      // Apply saved height to DOM
      if (inputRef.current) {
        inputRef.current.style.height = `${saved.height}px`;
        inputRef.current.style.overflowY = saved.height >= 316 ? 'auto' : 'hidden';
      }
      draftsStore.delete(draftKey);
    } else {
      setInputText('');
      setPendingFiles([]);
      textareaHeightVal.current = inputBarBaseHeight;
    }
    return () => {
      const text = inputTextRef.current;
      const files = pendingFilesRef.current;
      const height = textareaHeightRef.current;
      if (text.trim() || files.length > 0) {
        draftsStore.set(draftKey, { text, files, height });
      } else {
        draftsStore.delete(draftKey);
      }
    };
  }, [draftKey]);

  // 路由变化时也触发入场动画
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      setShowEntranceAnimation(true);
      setTimeout(() => setShowEntranceAnimation(false), 800);
    }
  }, [location.pathname]);

  useEffect(() => {
    setUser(getUser());
    // Check subscription status
    getUserUsage().then(usage => {
      const hasSub = !!(usage.plan && usage.plan.status === 'active');
      const hasQuota = usage.token_quota > 0 && usage.token_remaining > 0;
      setHasSubscription(hasSub || hasQuota);
    }).catch(() => setHasSubscription(false));
  }, [activeId]);

  // 设置页改称呼后，首页问候语即时跟随（不用刷新）
  useEffect(() => {
    const refreshUser = () => setUser(getUser());
    window.addEventListener('userProfileUpdated', refreshUser);
    window.addEventListener(PROFILE_UPDATED_EVENT, refreshUser);
    return () => {
      window.removeEventListener('userProfileUpdated', refreshUser);
      window.removeEventListener(PROFILE_UPDATED_EVENT, refreshUser);
    };
  }, []);

  useEffect(() => {
    // Reset state when switching conversations — each conversation has independent streaming
    setPlanMode(false);
    setDeepMode(false);
    setTodoItems([]);
    setActiveTasks(new Map());
    setAskUserDialog(null);
    isCreatingRef.current = false;
    viewingIdRef.current = activeId || null;

    // Pre-warm engine when user opens a conversation (init in background before they send)
    if (activeId) warmEngine(activeId);

    if (activeId) {
      // 目标契约随会话 payload 下发，这里同步进来（切会话时也要跟着变）
      getConversation(activeId).then(d => {
        if (viewingIdRef.current !== activeId) return;
        setGoalInfo(d?.goal || null);
        setInterruptedInfo(d?.interrupted || null);
      }).catch(() => {});
      // Check if there's a live buffer for this conversation (e.g. streaming in background)
      const buffered = messagesBufferRef.current.get(activeId);
      if (buffered && buffered.length > 0) {
        setMessages(buffered);
        setLoading(isStreaming(activeId));
        // Restore model from server even when using buffer for messages
        const buffConvId = activeId;
        getConversation(buffConvId).then(data => {
          if (data?.model && viewingIdRef.current === buffConvId) {
            // 会话模型是服务端真值。不能因为它没被 chat_models 下拉列表收录，
            // 就回退到默认 Sonnet 4.6——那只会把显示栏改错，实际 Agent 仍在用原模型。
            setCurrentModelString(data.model);
          }
        }).catch(() => {});
      } else {
        setLoading(false);
        loadConversation(activeId);
        // Check if server has an active stream we can reconnect to
        const convId = activeId;
        getStreamStatus(convId).then(status => {
          if (status.active && viewingIdRef.current === convId) {
            setLoading(true);
            addStreaming(convId);
            // Seed buffer from current messages + placeholder
            setMessages(prev => {
              const msgs = prev.length > 0 ? prev : [];
              // Add assistant placeholder if last message isn't one
              if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'assistant') {
                const lastModel = msgs.length > 0 ? getStoredMessageModel(msgs[msgs.length - 1]) : '';
                const withPlaceholder = [
                  ...msgs,
                  createAssistantPlaceholder(lastModel ? { model: lastModel } : { model: currentModelString }),
                ];
                messagesBufferRef.current.set(convId, withPlaceholder);
                return withPlaceholder;
              }
              messagesBufferRef.current.set(convId, msgs);
              return msgs;
            });
            const reconnectController = new AbortController();
            abortControllerRef.current = reconnectController;
            reconnectStream(
              convId,
              (delta, full) => {
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') {
                    applyAssistantTextUpdate(lastMsg, full);
                  }
                  return newMsgs;
                });
              },
              (full) => {
                removeStreaming(convId);
                messagesBufferRef.current.delete(convId);
                if (viewingIdRef.current === convId) setLoading(false);
                abortControllerRef.current = null;
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') {
                    applyAssistantTextUpdate(lastMsg, full);
                  }
                  return newMsgs;
                });
              },
              (err) => {
                removeStreaming(convId);
                messagesBufferRef.current.delete(convId);
                if (viewingIdRef.current === convId) setLoading(false);
                abortControllerRef.current = null;
              },
              (thinkingDelta, thinkingFull) => {
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (lastMsg && lastMsg.role === 'assistant') {
                    applyAssistantThinkingUpdate(lastMsg, thinkingFull);
                  }
                  return newMsgs;
                });
              },
              (event, message, data) => {
                // 重连握手：服务端下发本轮已产出的完整文本快照。
                // 先整体对齐再续增量，避免「切页面回来只见后半段」。
                if (event === 'ready' && data?.snapshot) {
                  const snap = data.snapshot;
                  setMessagesFor(convId, prev => {
                    const newMsgs = [...prev];
                    const lastMsg = newMsgs[newMsgs.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant') {
                      if (typeof snap.text === 'string' && snap.text) { lastMsg.content = snap.text; lastMsg.isThinking = false; }
                      if (typeof snap.thinking === 'string' && snap.thinking) lastMsg.thinking = snap.thinking;
                    }
                    return newMsgs;
                  });
                }
                if (event === 'todos' && Array.isArray(data?.todos)) setTodoItems(data.todos as TodoItem[]);
                if (event === 'modes' && data) { setPlanMode(!!data.plan); setDeepMode(!!data.deep); }
                if (event === 'metrics' && data) setRunMetrics(data);
                if (event === 'steering_accepted' && data) {
                  setMessagesFor(convId, prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.role === 'user') return prev;
                    return [...prev, { id: `steer-${Date.now()}`, role: 'user', content: String(data.content || ''), steering: true } as any];
                  });
                }
                if (event === 'turn_limit' && data) {
                  setTurnLimitToast(data.deep
                    ? `已跑 ${data.turns}/${data.max} 轮，接近上限。deep 模式已开，可继续；如已空转可让它收尾。`
                    : `已跑 ${data.turns}/${data.max} 轮，接近上限。输入 /deep 可提至 3000 轮继续，或让它收尾汇报。`);
                }
                if (event === 'ask_user' && data) {
                  setAskUserDialog({ request_id: data.request_id, tool_use_id: data.tool_use_id, questions: data.questions || [], answers: {} });
                }
                if (event === 'task_event' && data) {
                  setActiveTasks(prev => {
                    const next = new Map(prev);
                    if (data.subtype === 'task_started') next.set(data.task_id, { description: data.description || '任务运行中…' });
                    else if (data.subtype === 'task_progress') { const e = next.get(data.task_id); if (e) next.set(data.task_id, { ...e, last_tool_name: data.last_tool_name }); }
                    else if (data.subtype === 'task_notification') next.delete(data.task_id);
                    return next;
                  });
                }
              },
              (toolEvent) => {
                if (toolEvent.type === 'done' && toolEvent.tool_name === 'EnterPlanMode') setPlanMode(true);
                if (toolEvent.type === 'done' && toolEvent.tool_name === 'ExitPlanMode') setPlanMode(false);
                // 官方把 Task 工具当 subagent 内部调度管道隐藏；我们的 Task 是显式协作待办，
        // 用户就是要看到 AI 在派活/领活/交付，全隐藏等于协作过程变黑箱。
        // 另外 Team 那半（SendMessage/CheckMessages）本来就没被隐藏，
        // 一半可见一半不可见比全显示更让人困惑。这里改成不隐藏任何协作工具。
        const INTERNAL_TOOLS = new Set<string>([]);
                if (INTERNAL_TOOLS.has(toolEvent.tool_name || '')) return;
                setMessagesFor(convId, prev => {
                  const newMsgs = [...prev];
                  const lastMsg = newMsgs[newMsgs.length - 1];
                  if (!lastMsg || lastMsg.role !== 'assistant') return prev;
                  const toolCalls = lastMsg.toolCalls || [];
                  if (toolEvent.type === 'start') {
                    let existing = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (existing) {
                      existing.name = toolEvent.tool_name || existing.name;
                      if (toolEvent.tool_input && Object.keys(toolEvent.tool_input).length > 0) existing.input = toolEvent.tool_input;
                      if (toolEvent.textBefore) existing.textBefore = toolEvent.textBefore;
                    } else {
                      toolCalls.push({ id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: toolEvent.tool_input || {}, status: 'running' as const, textBefore: toolEvent.textBefore || '' });
                    }
                  }
                  else if (toolEvent.type === 'input') {
                    const tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (tc) tc.input = toolEvent.tool_input || {};
                  }
                  else if (toolEvent.type === 'done') {
                    let tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
                    if (!tc) { tc = { id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: {}, status: 'done' as const, result: toolEvent.content }; toolCalls.push(tc); }
                    else { tc.status = toolEvent.is_error ? 'error' as const : 'done' as const; tc.result = toolEvent.content; }
                  }
                  lastMsg.toolCalls = toolCalls;
                  return newMsgs;
                });
              },
              reconnectController.signal
            );
          }
        }).catch(() => {});
      }
      getContextSize(activeId).then(setContextInfo).catch(() => { });
      isAtBottomRef.current = true;

      // Handle initialMessage from Project page navigation
      const navState = location.state as any;
      if (navState?.initialMessage) {
        pendingInitialMessageRef.current = navState.initialMessage;
        if (navState.model) setCurrentModelString(navState.model);
        // Clear location state to prevent re-sends on refresh
        navigate(location.pathname, { replace: true, state: {} });
      }
      return;
    }

    setLoading(false);
    setMessages([]);
    setContextInfo(null);
    setCurrentModelString(resolveModelForNewChat());
  }, [activeId]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const beginStreamSession = useCallback((conversationId: string) => {
    const nextId = streamRequestIdRef.current + 1;
    streamRequestIdRef.current = nextId;
    streamConversationIdRef.current = conversationId;
    return nextId;
  }, []);

  const isStreamSessionActive = useCallback((conversationId: string, requestId: number) => {
    return streamConversationIdRef.current === conversationId && streamRequestIdRef.current === requestId;
  }, []);

  const clearStreamSession = useCallback((conversationId: string, requestId: number) => {
    if (!isStreamSessionActive(conversationId, requestId)) return false;
    streamConversationIdRef.current = null;
    return true;
  }, [isStreamSessionActive]);

  const abortStreamSession = useCallback((targetConversationId?: string) => {
    const trackedConversationId = streamConversationIdRef.current;
    if (!trackedConversationId) return false;
    if (targetConversationId && trackedConversationId !== targetConversationId) return false;

    streamRequestIdRef.current += 1;
    streamConversationIdRef.current = null;

    // 浏览器中断只会断开 SSE；同时通知服务端停止 Agent，避免 runtime.running 残留。
    const requestServerAbort = () => {
      stopGeneration(trackedConversationId).catch(e => console.error('[Stop] server abort error:', e));
    };

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
      requestServerAbort();
    } else if (pollingRef.current) {
      stopPolling();
      requestServerAbort();
    } else {
      requestServerAbort();
    }

    removeStreaming(trackedConversationId);
    setLoading(false);
    isCreatingRef.current = false;
    return true;
  }, [stopPolling]);

  // 组件卸载或对话切换时停止轮询
  useEffect(() => {
    return () => { stopPolling(); };
  }, [activeId, stopPolling]);

  // 对话删除前先中止流式请求，避免旧会话的输出串到当前界面
  useEffect(() => {
    const handleConversationDeleting = (evt: Event) => {
      const customEvt = evt as CustomEvent<{ id?: string }>;
      const conversationId = customEvt.detail?.id;
      if (!conversationId) return;
      abortStreamSession(conversationId);
    };

    window.addEventListener('conversationDeleting', handleConversationDeleting as EventListener);
    return () => {
      window.removeEventListener('conversationDeleting', handleConversationDeleting as EventListener);
    };
  }, [abortStreamSession]);

  useEffect(() => {
    // 只在加载中（模型正在生成）或用户刚发送消息时才自动滚动
    // 对话结束后不要自动滚动，避免用户正在查看历史消息时被打断
    if (isAtBottomRef.current && loading && !userScrolledUpRef.current) {
      scrollToBottom('auto');
    }
  }, [messages, loading]);

  // 当输入框高度变化时，如果已经在底部，则保持在底部
  useEffect(() => {
    if (isAtBottomRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [inputHeight]);

  const handleScroll = () => {
    if (scrollContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
      const isBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 50;
      if (isBottom && userScrolledUpRef.current) {
        // 用户自己滚回了底部，重新启用自动滚动
        userScrolledUpRef.current = false;
      }
      if (!userScrolledUpRef.current) {
        isAtBottomRef.current = isBottom;
      }
      // 【2026-10-10】「回到底部」按钮：不在底部就显示（对齐 APK
      // 的 `AnimatedVisibility(visible = !followBottom)`）。
      setShowScrollButton(!isBottom);
    }
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  };

  /**
   * 【2026-10-10 加】「回到底部」按钮点击 —— 对齐 APK 的成熟做法。
   *
   * APK 踩过的坑（注释里记录过）：点按钮后判定逻辑会把 followBottom
   * 打回 false（smooth 动画途中 (max-v)>50，被当成「用户上翻」），
   * 按钮反复闪、点了像没反应。修法是「追底循环」—— 每帧滚，
   * 追到后自然停（scrollTo 幂等），期间不做「用户上翻」判定。
   *
   * Web 对应实现：先把两个 ref 打回「跟随」状态（阻止自动滚动被中断），
   * 再用 rAF 追底几帧（流式期间内容还在长高，一次 scrollTo 追不上）。
   */
  const handleScrollToBottomClick = useCallback(() => {
    userScrolledUpRef.current = false;
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    const el = scrollContainerRef.current;
    if (!el) return;
    // 追底循环：连续几帧滚到底（对齐 APK 的 repeat(40) 思路，
    // 但 Web 内容长高通常 2~3 帧内稳定，6 帧足够）
    let frames = 0;
    const chase = () => {
      el.scrollTop = el.scrollHeight;
      frames++;
      if (frames < 6) requestAnimationFrame(chase);
    };
    requestAnimationFrame(chase);
  }, []);

  const scheduleScrollToBottomAfterRender = useCallback((attempts = 6) => {
    const run = (remaining: number) => {
      // Respect user scroll: if user scrolled up, abort all scheduled scrolls
      if (userScrolledUpRef.current || !isAtBottomRef.current) return;
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => run(remaining - 1));
      }
    };

    requestAnimationFrame(() => run(attempts));

    // 某些内容（Markdown、文档卡片、字体回流）会在首帧后继续撑高高度，
    // 仅靠 rAF 可能还会停在上方，因此再补几次延迟滚动。
    // 但必须在每次执行前检查用户是否已经主动滚动了！
    [80, 200, 400, 800, 1200].forEach((delay) => {
      window.setTimeout(() => {
        // Skip if user has scrolled away
        if (userScrolledUpRef.current || !isAtBottomRef.current) return;
        const el = scrollContainerRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }, delay);
    });
  }, []);

  const loadConversation = async (conversationId: string) => {
    stopPolling();
    try {
      const data = await getConversation(conversationId);
      // 会话绑定的 model 优先级高于本地默认模型/可选列表；它可能是用户通过 /model
      // 临时指定、或 Provider 配置里存在但未加入 chat_models 的模型，必须原样显示。
      if (data.model) {
        setCurrentModelString(data.model);
      }

      // Restore research mode toggle
      setResearchMode(!!data.research_mode);
      // 【2026-09-19 修】思考开关 / 强度是**用户偏好**，不是会话属性。
      //
      // 原来的写法是「会话里有值就覆盖」——而会话的 thinkingEffort 是**创建那一刻**
      // 的快照。于是：用户在输入框把强度调成 low（写进了 localStorage）→ 切到别的
      // 会话 / 刷新 → 这里用会话里旧的 max 覆盖回去 → 用户看到「我设的 low 又变回 max」。
      //
      // 正确规则：localStorage 有值就以它为准（用户最近一次的选择）；
      // 只有 localStorage 没值时，才用会话里带的值兜底（比如换设备/清过缓存的旧会话）。
      if (typeof data.thinking === 'boolean' && localStorage.getItem('web_thinking') === null) {
        setThinkingEnabled(data.thinking);
      }
      if (data.thinkingEffort && localStorage.getItem('web_thinking_effort') === null) {
        setThinkingEffort(data.thinkingEffort);
      }
      // 会话带的值与本地偏好不一致时，把本地偏好**同步回会话**，
      // 保证这一轮实际用的强度跟界面显示的一致（否则界面显示 low、实际发的是 max）。
      const localEffort = localStorage.getItem('web_thinking_effort');
      if (localEffort && data.thinkingEffort && data.thinkingEffort !== localEffort) {
        updateConversation(conversationId, { thinkingEffort: localEffort }).catch(() => {});
      }
      const localThinking = localStorage.getItem('web_thinking');
      if (localThinking !== null && typeof data.thinking === 'boolean' && String(data.thinking) !== (localThinking === '1' ? 'true' : 'false')) {
        updateConversation(conversationId, { thinking: localThinking === '1' }).catch(() => {});
      }
      const normalizedMessages = (data.messages || []).map((msg: any) => {
        // Normalize attachment field names (bridge-server uses camelCase, component expects snake_case)
        if (msg.attachments && Array.isArray(msg.attachments)) {
          msg.attachments = msg.attachments.map((att: any) => ({
            id: att.id || att.fileId || att.file_id || '',
            file_name: att.file_name || att.fileName || 'file',
            file_type: att.file_type || att.fileType || 'document',
            mime_type: att.mime_type || att.mimeType || '',
            file_size: att.file_size || att.size || 0,
            ...att,
          }));
        }
        return sanitizeInlineArtifactMessage(msg);
      });
      // 【运行中不要用磁盘快照覆盖本地】服务端 autosave 每 20s 才落一次盘，
      // 而用户切回来时拿到的可能是 15 秒前的旧历史 —— 直接 setMessages 覆盖，
      // 用户就会看到「刚聊的内容消失了」。运行中时只补不覆盖：以本地为准，
      // 缺的部分交给 SSE 重连的快照机制补齐。
      const serverRunning = !!data.running;
      setMessages(prev => {
        if (!serverRunning) return normalizedMessages;
        // 运行中：服务端历史比本地短 → 保留本地；否则用服务端（更完整）
        if (prev.length > normalizedMessages.length) return prev;
        return normalizedMessages;
      });
      if (serverRunning) {
        // 运行中切回来：标记 loading，让重连逻辑接管后续增量
        setLoading(true);
        addStreaming(conversationId);
      }
      isAtBottomRef.current = true;
      scheduleScrollToBottomAfterRender();
      setConversationTitle(data.title || 'New Chat');
      setCurrentProjectId(data.project_id || null);

      // 检查是否有活跃的后台生成
      try {
        const genStatus = await getGenerationStatus(conversationId);
        if (genStatus.active && genStatus.status === 'generating') {
          // 追加占位 assistant 消息（如果最后一条不是 assistant）
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === 'assistant' &&
              !last.content &&
              !genStatus.text &&
              !genStatus.thinking &&
              !(genStatus.documents && genStatus.documents.length > 0) &&
              !genStatus.document
            ) {
              // 已有空占位，更新它
              return prev;
            }
            if (last && last.role === 'assistant') {
              // 更新现有 assistant 消息
              const newMsgs = [...prev];
              newMsgs[newMsgs.length - 1] = applyGenerationState(last, genStatus);
              return newMsgs;
            }
            // 追加新的 assistant 占位
            return [...prev, mergeDocumentsIntoMessage({
              role: 'assistant',
              content: genStatus.text || '',
              thinking: genStatus.thinking || '',
              thinkingSummary: genStatus.thinkingSummary,
              citations: genStatus.citations,
              searchLogs: genStatus.searchLogs,
              isThinking: !genStatus.text && !!genStatus.thinking,
            }, genStatus.document, genStatus.documents)];
          });
          setLoading(true);
          isAtBottomRef.current = true;

          // 启动轮询
          pollingRef.current = setInterval(async () => {
            try {
              const s = await getGenerationStatus(conversationId);
              if (!s.active || s.status !== 'generating') {
                // 生成结束，停止轮询，重新加载最终数据
                stopPolling();
                setLoading(false);
                const final_ = await getConversation(conversationId);
                setMessages((final_.messages || []).map((msg: any) => sanitizeInlineArtifactMessage(msg)));
                isAtBottomRef.current = true;
                scheduleScrollToBottomAfterRender();
                if (final_.title) setConversationTitle(final_.title);
                getContextSize(conversationId).then(setContextInfo).catch(() => { });
                return;
              }
              // 跨进程轮询：内容在另一个进程，从数据库拉最新消息
              if (s.crossProcess) {
                const fresh = await getConversation(conversationId);
                const freshMsgs = (fresh.messages || []).map((msg: any) => sanitizeInlineArtifactMessage(msg));
                isAtBottomRef.current = true;
                scheduleScrollToBottomAfterRender();
                // 如果数据库里最后一条是 assistant，说明有新内容，更新
                // 否则保留当前显示的内容（助手消息可能还没存到数据库）
                setMessages(prev => {
                  const lastFresh = freshMsgs[freshMsgs.length - 1];
                  const lastPrev = prev[prev.length - 1];
                  if (lastFresh && lastFresh.role === 'assistant') {
                    return freshMsgs;
                  }
                  // 数据库里还没有助手消息，保留当前显示的占位消息
                  if (lastPrev && lastPrev.role === 'assistant') {
                    return prev;
                  }
                  return freshMsgs;
                });
                return;
              }
              // 更新进度
              setMessages(prev => {
                const newMsgs = [...prev];
                const last = newMsgs[newMsgs.length - 1];
                if (last && last.role === 'assistant') {
                  newMsgs[newMsgs.length - 1] = applyGenerationState(last, s);
                }
                return newMsgs;
              });
            } catch (e) {
              console.error('[Polling] error:', e);
              stopPolling();
              setLoading(false);
            }
          }, 1500);
        } else {
          setLoading(false);
        }
      } catch {
        // generation-status 接口失败不影响正常加载
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  // 模型→Provider 映射：模型名不能当作 providerId 传给后端（以前会被错识并回退到默认配置）。
  const resolveProviderIdForModel = useCallback((modelString: string) => {
    const base = stripThinking(modelString);
    const fromCatalog = (modelCatalog?.all || []).find((m: any) => m.id === base)?.providerId;
    if (fromCatalog) return fromCatalog;
    const fromProviders = providersCache.find(p => p.model === base || (p.models || []).some(m => m.id === base));
    return fromProviders?.id;
  }, [modelCatalog, providersCache]);

  const handleModelChange = async (newModelString: string) => {
    if (!isModelSelectable(newModelString)) return;
    setCurrentModelString(newModelString);

    // 【2026-09-19 修】原来只写会话，不写 localStorage —— 于是「在输入框选了个模型，
    // 下次进来又不是它了」：组件初始化读的是 localStorage 的 `default_model`
    //（见下方 useState），而它从来没被更新过。
    // 用户的选择应该成为**默认模型**，跨会话保持。
    try {
      localStorage.setItem('default_model', newModelString);
      const pid = resolveProviderIdForModel(newModelString);
      if (pid) localStorage.setItem('default_provider', pid);
    } catch {}

    // If in an existing conversation, we should update the conversation's model immediately
    if (activeId && !isCreatingRef.current) {
      try {
        const providerId = resolveProviderIdForModel(newModelString);
        const updated = await updateConversation(activeId, providerId ? { providerId, model: newModelString } : { model: newModelString });
        if (updated?.model) {
          setCurrentModelString(updated.model);
        }
      } catch (err) {
        console.error("Failed to update conversation model", err);
      }
    }
  };

  const handleAttachToProject = async (project: Project) => {
    setShowPlusMenu(false);
    setShowProjectsSubmenu(false);
    if (activeId) {
      if (currentProjectId === project.id) return;
      try {
        await updateConversation(activeId, { project_id: project.id });
        setCurrentProjectId(project.id);
        onNewChat();
        setProjectAddToast(`Added to ${project.name}`);
        setTimeout(() => setProjectAddToast(null), 2500);
      } catch (err) {
        console.error('Failed to add conversation to project', err);
      }
    } else {
      setPendingProjectId(project.id);
      setProjectAddToast(`Will add to ${project.name} on send`);
      setTimeout(() => setProjectAddToast(null), 2500);
    }
  };

  const handleCreateProjectFromMenu = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const project = await createProject(name, newProjectDescription.trim());
      setShowNewProjectDialog(false);
      setNewProjectName('');
      setNewProjectDescription('');
      setProjectList(prev => [project, ...prev]);
      await handleAttachToProject(project);
    } catch (err) {
      console.error('Failed to create project', err);
    }
  };

  const slashOpen = inputText.startsWith('/') && !inputText.includes('\n') && !inputText.includes(' ');
  // ── 子命令面板（「命令 + 空格」后）─────────────────────────────────
  // 例：输「/config 」→ 列出 list/show/test/vision/provider/stream…
  //    输「/config v」→ 筛出 vision
  // 原来完全没有这层，用户只能背子命令名（实测为此敲错几十次）。
  //
  // 注意：slashOpen 的定义排除了空格（那是「命令名补全」阶段），
  // 子命令阶段**必然有空格**，所以这里要单独判定，不能复用 slashOpen。
  // 支持三级：`/config vision ` 的下一层是 on|off|set（在 nested.vision 里）。
  const subCmdMatch = inputText.match(/^\/([a-z0-9-]+)\s+([a-z0-9-]*)\s*([a-z0-9-]*)$/i);
  const subCmdParts = subCmdMatch ? [subCmdMatch[1], subCmdMatch[2], subCmdMatch[3]].filter(Boolean) : [];
  const parentCmd = subCmdMatch ? slashSubcommands[subCmdMatch[1].toLowerCase()] : null;
  // 判定当前在几级：`/config <partial>` → 一级子命令；`/config vision <partial>` → 二级
  const firstSub = subCmdMatch ? (subCmdMatch[2] || '') : '';
  const secondSub = subCmdMatch ? (subCmdMatch[3] || '') : '';
  // 判定在当前是否处于「二级子命令」层：
  //   /config vision <partial>  → firstSub='vision' 命中 nested，partial 是第 3 段（可能为空）
  // 注意不能要求 secondSub 为空 —— 那样「/config vision o」会退回父级候选，用户白打一个字。
  const nestedTable = (parentCmd && firstSub)
    ? (parentCmd.nested as any)?.[firstSub.toLowerCase()]
    : null;
  const activeTable = nestedTable || parentCmd;
  const activePrefix = nestedTable ? `${subCmdMatch![1]} ${firstSub}` : (subCmdMatch ? subCmdMatch[1] : '');
  const activePartial = nestedTable ? secondSub : firstSub;
  const slashSubCandidates: SlashSuggestion[] = activeTable
    ? ((activeTable.candidates || []) as string[])
        .filter(c => !activePartial || c.toLowerCase().startsWith(activePartial.toLowerCase()))
        .map(c => ({
          name: `${activePrefix} ${c}`,
          description: (activeTable.desc as any)?.[c] || '',
          kind: 'command' as const,
        }))
    : [];
  // 【2026-09-19 修】原来是 .slice(0, 12) —— 硬编码只给 12 个，而 web 端有 47 个命令，
  // 后面 35 个（/goal /todos /tasks /team /plan /watch /image /voice …）用户**永远看不到**，
  // 面板底部也没有「还有 N 项」提示（组件里那句判断拿的是全量 vs visible，
  // 但上游已经砍到 12，两边相等就永远不提示）。这就是「slash 命令问题很多」的根源。
  //
  // 现在：不在这里截断，交给面板按可用高度滚动 + 显示「还有 N 项」。
  // 同时过滤放宽到「名字前缀 或 描述包含」，输 /压 也能搜到「压缩」类命令。
  const slashQuery = subCmdMatch ? '' : inputText.slice(1).toLowerCase();
  // 分级展示：
  //   · 没输关键词 → 只列命令（47 个，都是内置/自定义命令，需要一眼看全）
  //     skill 有 800+ 个，全列出来滚动毫无意义，给一句提示让用户搜
  //   · 输了关键词 → 命令 + skill 一起搜（skill 本来就是"记得名字才用得上"）
  // 面板出现的两种情形：① 只打了「/xxx」→ 命令名补全；② 打了「/xxx 子命令」→ 子命令补全。
  // 情形②有空格，slashOpen 为 false，必须显式并进来。
  const slashPanelActive = slashOpen || slashSubCandidates.length > 0;
  const filteredSlashSuggestions = slashPanelActive
    ? (slashSubCandidates.length ? slashSubCandidates : slashSuggestions)
        .filter(item => {
          if (!slashQuery) return item.kind !== 'skill';
          return item.name.toLowerCase().includes(slashQuery)
            || (item.description || '').toLowerCase().includes(slashQuery);
        })
        // 排序：命令 > skill；同组内「名字前缀命中」>「名字包含」>「描述命中」。
        // 不排的话 /go 会把 /goal 和一堆名字里带 go 的 skill 混在一起（实测 36 项乱序）。
        .sort((a, b) => {
          const ga = a.kind === 'skill' ? 1 : 0;
          const gb = b.kind === 'skill' ? 1 : 0;
          if (ga !== gb) return ga - gb;
          if (!slashQuery) return a.name.localeCompare(b.name);
          const rank = (item) => {
            const n = item.name.toLowerCase();
            if (n.startsWith(slashQuery)) return 0;
            if (n.includes(slashQuery)) return 1;
            return 2; // 描述命中
          };
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          return a.name.localeCompare(b.name);
        })
    : [];
  // 没输关键词时，提示还有多少 skill 可搜（面板底部会显示）
  const hiddenSkillCount = slashOpen && !slashQuery
    ? slashSuggestions.filter(item => item.kind === 'skill').length
    : 0;
  // 输入变化后候选集变了，旧索引可能越界（例：47 项选到第 30，再打一个字只剩 2 项）
  // → 高亮项指到不存在的项，Enter 选中 undefined。这里按需夹紧。
  React.useEffect(() => {
    setSlashIndex(i => {
      if (filteredSlashSuggestions.length === 0) return 0;
      return i >= filteredSlashSuggestions.length ? 0 : i;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSlashSuggestions.length]);
  const selectSlashSuggestion = (item: SlashSuggestion) => {
    // item.name 对子命令是「config vision」这种带父命令的形态（见 slashSubCandidates）；
    // 对普通命令就是「config」。统一前面补斜杠、后面补空格即可。
    setInputText(`/${item.name} `);
    setSlashIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  // 设置页「发送消息 / 换行」按键配置。每次按键都实时读 localStorage，
  // 这样在设置页改完立刻生效，不需要刷新或额外的事件同步。
  const matchesCombo = (e: React.KeyboardEvent, combo: string) => {
    if (e.key !== 'Enter') return false;
    switch (combo) {
      // 「仅按钮」：任何 Enter 组合都不发送，一律当换行处理（发送只能点按钮）。
      // 用户明确要的选项：Enter 换行、发送用鼠标点。
      case 'button_only': return false;
      case 'enter': return !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      case 'shift_enter': return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      case 'ctrl_enter': return e.ctrlKey && !e.metaKey && !e.altKey;
      case 'cmd_enter': return e.metaKey && !e.altKey;
      case 'alt_enter': return e.altKey && !e.ctrlKey && !e.metaKey;
      default: return false;
    }
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 【2026-09-19 修】slash 面板的上下键 + Tab/Enter 选择。
    // 原来第一行就是 `if (e.key !== 'Enter') return`，ArrowDown/ArrowUp 从来没被处理过
    // —— activeIndex 有状态、面板有高亮样式，但没有任何代码改它，
    // 键盘选择完全失效，用户只能鼠标点（手机上尤其难受）。
    if (slashPanelActive && filteredSlashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % filteredSlashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + filteredSlashSuggestions.length) % filteredSlashSuggestions.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // 关掉面板但保留输入内容（再打一个空格面板也会消失）
        setInputText(inputText + ' ');
        return;
      }
      // Tab = 选中当前高亮项（补全，不发送）—— 对齐 CLI 的 Tab 补全习惯。
      if (e.key === 'Tab') {
        const item = filteredSlashSuggestions[slashIndex];
        if (item) {
          e.preventDefault();
          selectSlashSuggestion(item);
          return;
        }
      }
      // Enter：**发不发送由设置页的 sendKey 决定**，面板不硬编码。
      //
      // 【2026-09-19 纠正】我上一轮在这里写死「输入完整命令 → Enter 发送」，
      // 那是越权：Enter 发不发送是用户在设置页选的（默认 button_only = 只能点按钮）。
      // 用户当场指出「enter 不该发送，这是设置页自选的」。
      //
      // 正确逻辑 —— 先问 sendKey：
      //   · Enter 就是用户配的发送键 → 不拦截，落到下面正常发送流程
      //   · 否则 → 当菜单选择（补全），绝不发送
      if (e.key === 'Enter') {
        const panelSendCombo = localStorage.getItem('sendKey') || 'button_only';
        if (!matchesCombo(e, panelSendCombo)) {
          const item = filteredSlashSuggestions[slashIndex];
          if (item) {
            e.preventDefault();
            selectSlashSuggestion(item);
            return;
          }
        }
        // Enter 是发送键 → 不 return，交给下面的发送逻辑
      }
    }
    if (e.key !== 'Enter') return;
    // 输入法组合中（拼音候选未确认）不能提交，否则会截断输入
    if ((e.nativeEvent as any)?.isComposing) return;
    const sendCombo = localStorage.getItem('sendKey') || 'button_only';
    const newlineCombo = localStorage.getItem('newlineKey') || 'enter';
    // 【撞车时发送优先，不是换行优先】
    // 旧逻辑写的是「换行优先」，看起来更安全，但有个致命场景：
    // 用户在设置里把发送改成 Enter，而 newlineKey 还留着默认的 'enter'
    //（localStorage 里早存过）→ 两个组合相同 → Enter 被当换行拦下 return，
    // **永远走不到发送分支**，用户感受就是「选了 Enter 发送，实际还得点按钮」。
    // 发送是用户显式配置的动作，撞车时该让它生效；想换行可以 Shift+Enter。
    if (sendCombo !== 'button_only' && sendCombo === newlineCombo) {
      // 冲突：发行为准
      if (matchesCombo(e, sendCombo)) {
        e.preventDefault();
        if (loading) return;
        if (pendingFiles.some(f => f.status === 'uploading')) return;
        if (!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) return;
        handleSend();
      }
      return;
    }
    if (matchesCombo(e, newlineCombo)) return;
    if (!matchesCombo(e, sendCombo)) return;
    e.preventDefault();
    if (loading) return;
    if (pendingFiles.some(f => f.status === 'uploading')) return;
    if (!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) return;
    handleSend();
  };

  const handleSend = async (overrideText?: string) => {
    const effectiveText = (typeof overrideText === 'string') ? overrideText : inputText;
    // Skill slug is already in the text (inserted when selected from menu)
    setSelectedSkill(null);
    const hasFiles = pendingFiles.some(f => f.status === 'done');
    const hasErrorFiles = pendingFiles.some(f => f.status === 'error');
    if ((!effectiveText.trim() && !hasFiles) || loading) {
      if (!loading && !effectiveText.trim() && !hasFiles && hasErrorFiles) {
        alert('有文件上传失败，请先删除失败文件后再发送');
      }
      return;
    }
    // 【生成中插话】正在生成时不再吞掉输入 —— 走 steering：服务端入队，
    // agent 下一轮调用前会以「执行中补充指令」注入。用户的话立刻上屏（乐观显示）。
    if (loading && activeId && effectiveText.trim()) {
      const steerText = effectiveText.trim();
      const convId = activeId;
      setMessagesFor(convId, prev => [...prev, {
        id: `steer-${Date.now()}`,
        role: 'user',
        content: steerText,
        steering: true,
      } as any]);
      setInputText('');
      messagesBufferRef.current.set(convId, []);   // 让本地缓冲以服务端为准
      try {
        const res = await fetch(`/api/sessions/${convId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: steerText }),
        });
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}));
          alert(data?.error || '当前对话正在生成，无法发送');
        }
      } catch (e) {
        console.error('[steering] 发送失败', e);
      }
      return;
    }
    if (activeRequestCountRef.current >= 2) {
      alert('最多同时进行 2 个对话，请等待其他对话完成');
      return;
    }
    const isUploading = pendingFiles.some(f => f.status === 'uploading');
    if (isUploading) {
      alert('文件仍在上传中，请稍等完成后再发送');
      return;
    }

    // Clawparrot login gate: Electron users in clawparrot mode without a
    // gateway API key get prompted to login on first send. Replaces the old
    // hard redirect to /login at app start — users can now explore the app
    // freely before deciding to login or switch modes.

    const userMessageText = effectiveText;
    setInputText(""); // Clear input

    // 收集已上传的附件
    const uploadedFiles = pendingFiles.filter(f => f.status === 'done' && f.fileId);
    const githubFiles = pendingFiles.filter(f => f.status === 'done' && f.source === 'github');
    const uploadedPayload = uploadedFiles.map(f => ({ fileId: f.fileId!, fileName: f.fileName, fileType: f.fileType, mimeType: f.mimeType, size: f.size }));
    const githubPayload = githubFiles.map(f => ({
      fileId: `github:${f.ghRepo || f.fileName}`,
      fileName: f.ghRepo || f.fileName,
      fileType: 'github' as any,
      mimeType: 'application/x-github',
      size: 0,
      source: 'github',
      ghRepo: f.ghRepo,
      ghRef: f.ghRef,
    }));
    const attachmentsPayload = (uploadedPayload.length + githubPayload.length) > 0
      ? [...uploadedPayload, ...githubPayload]
      : null;

    // 构建乐观 UI 的附件数据
    const optimisticAttachments: any[] = uploadedFiles.map(f => ({
      id: f.fileId!,
      file_type: f.fileType || 'text',
      file_name: f.fileName,
      mime_type: f.mimeType,
      file_size: f.size,
      line_count: f.lineCount,
    }));
    for (const g of githubFiles) {
      optimisticAttachments.push({
        id: `github:${g.ghRepo || g.fileName}`,
        file_type: 'github',
        file_name: g.ghRepo || g.fileName,
        mime_type: 'application/x-github',
        file_size: 0,
        source: 'github',
        gh_repo: g.ghRepo,
        gh_ref: g.ghRef,
      });
    }

    // 清空 pendingFiles 并释放预览 URL
    pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    setPendingFiles([]);
    draftsStore.delete(activeId || '__new__');

    // 重置 textarea 高度
    textareaHeightVal.current = inputBarBaseHeight;
    if (inputRef.current) {
      inputRef.current.style.height = `${inputBarBaseHeight}px`;
      inputRef.current.style.overflowY = 'hidden';
    }

    const turnModelString = activeId
      ? currentModelString
      : (
          isModelSelectable(currentModelString)
            ? currentModelString
            : resolveModelForNewChat(currentModelString)
        );

    // Optimistic UI: Add user message immediately
    const tempUserMsg: any = { role: 'user', content: userMessageText, created_at: new Date().toISOString(), model: turnModelString };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }
    setMessages(prev => [...prev, tempUserMsg]);

    // Force scroll to bottom and track state
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);

    // Prepare assistant message placeholder
    setMessages(prev => [...prev, createAssistantPlaceholder({ model: turnModelString })]);

    let conversationId = activeId;

    // If no ID, create conversation first
    if (!conversationId) {
      isCreatingRef.current = true; // Block useEffect fetch
      try {
        const modelForCreate = turnModelString;
        if (modelForCreate !== currentModelString) {
          setCurrentModelString(modelForCreate);
        }
        // 不传临时标题，让后端生成
        const providerIdForCreate = resolveProviderIdForModel(modelForCreate);
        const newConv = await createConversation(undefined, modelForCreate, { research_mode: researchMode, thinking: thinkingEnabled, thinkingEffort, model: modelForCreate, ...(providerIdForCreate ? { providerId: providerIdForCreate } : {}) });

        if (!newConv || !newConv.id) {
          throw new Error("Invalid conversation response from server");
        }

        conversationId = newConv.id;
        // Attach to pending project if user chose one before sending
        if (pendingProjectId) {
          try {
            await updateConversation(conversationId!, { project_id: pendingProjectId });
            setCurrentProjectId(pendingProjectId);
          } catch (e) {
            console.error('Failed to attach new conversation to project', e);
          }
          setPendingProjectId(null);
        }
        warmEngine(conversationId); // Pre-warm engine while user waits

        // Use React Router navigate so useParams stays in sync with the URL
        // isCreatingRef prevents the activeId effect from reloading during streaming
        navigate(`/chat/${conversationId}`, { replace: true });
        if (newConv.model) {
          setCurrentModelString(newConv.model);
        }
        setConversationTitle(newConv.title || 'New Chat');

        onNewChat(); // Refresh sidebar
      } catch (err: any) {
        console.error("Failed to create conversation", err);
        isCreatingRef.current = false;
        setMessages(prev => {
          const newMsgs = [...prev];
          // Find the last assistant message (placeholder) and update it
          if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = "Error: Failed to create conversation. " + (err.message || err);
          }
          return newMsgs;
        });
        return;
      }
    }

    // Call streaming API — seed buffer with current messages so background streaming works
    messagesBufferRef.current.set(
      conversationId!,
      [...messages, tempUserMsg, createAssistantPlaceholder({ model: tempUserMsg.model })]
    );
    const controller = new AbortController();
    const streamRequestId = beginStreamSession(conversationId!);
    abortControllerRef.current = controller;
    setLoading(true);
    addStreaming(conversationId!);
    activeRequestCountRef.current += 1;
    await sendMessage(
      conversationId!,
      userMessageText,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count, even if session changed
        removeStreaming(conversationId!);
        messagesBufferRef.current.delete(conversationId!);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllerRef.current = null;
        isCreatingRef.current = false; // Reset flag
        clearStreamSession(conversationId!, streamRequestId);
        // 流结束后再拉一次真实上下文用量（context_size 事件可能因断线漏掉）
        getContextSize(conversationId!).then(setContextInfo).catch(() => { });
        // goal 状态一轮一结算，流结束时刷新横幅
        getConversation(conversationId!).then(d => setGoalInfo(d?.goal || null)).catch(() => {});
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });

        // Refresh conversation to get generated title (if any)
        // 标题生成是异步的，可能需要几秒钟，所以需要延迟轮询
        if (conversationId) {
          // 【2026-09-19 修重复拉取】标题生成是异步的，所以要轮询几次。
          // 但原来**每次都无条件 dispatch conversationTitleUpdated** —— 侧边栏
          // 收到事件就 fetchChats() 拉整张会话列表。于是「发一条消息」结尾会
          // 触发 3 次（立即 / 3s / 6s）全量拉取，日志里能看到成对刷屏。
          //
          // 改成：只有标题**真的变化**时才派发。第一次拿到标题后，后两次轮询
          // 发现没变就不吭声了 —— 轮询次数不变（保证最终能拿到），但重复拉取消失。
          let lastTitle = '';
          const refreshTitle = async () => {
            try {
              const data = await getConversation(conversationId);
              const t = data?.title;
              if (!t) return;
              setConversationTitle(t);
              if (t === lastTitle) return;   // 没变 → 不通知侧边栏
              lastTitle = t;
              // 使用 CustomEvent 通知侧边栏刷新，避免触发 resetKey 变化
              window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
            } catch (err) {
              console.error('[MainContent] Error polling title:', err);
            }
          };

          // 立即刷新一次
          refreshTitle();
          // 3秒后再刷新一次（此时标题生成应该已完成）
          setTimeout(refreshTitle, 3000);
          // 6秒后再刷新一次（备用）
          setTimeout(refreshTitle, 6000);
        }
      },
      (err) => {
        // Always clean up streaming state and request count, even if session changed
        removeStreaming(conversationId!);
        messagesBufferRef.current.delete(conversationId!);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllerRef.current = null;
        isCreatingRef.current = false;
        clearStreamSession(conversationId!, streamRequestId);
        // 流结束后再拉一次真实上下文用量（context_size 事件可能因断线漏掉）
        getContextSize(conversationId!).then(setContextInfo).catch(() => { });
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantThinkingUpdate(lastMsg, thinkingFull);
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // 命令要求交互式向导（/config provider add 无参等）→ 弹表单
        if (event === 'command_applied' && data?.wizard) {
          setWizard({ id: data.wizard.id, title: data.wizard.title, steps: data.wizard.steps || [] });
        }
        // 命令要求「从一批里挑一个」（/model 无参等）→ 弹选择列表
        if (event === 'command_applied' && data?.select) {
          setSelectReq(data.select as SelectRequest);
        }
        // slash 命令改了 Provider/模型：立刻刷新模型目录与当前选择
        if (event === 'command_applied') {
          // 【2026-09-20】命令输出是终端风格纯文本（靠缩进对齐），要标记出来
          // 让渲染用 <pre> —— 否则 Markdown 折叠空格，缩进层级全丢，
          // 用户感受就是「web 的 slash 命令比 CLI 敷衍」。
          if (message && !data?.select && !data?.wizard) {
            setMessagesFor(conversationId!, prev => {
              const newMsgs = [...prev];
              const last = newMsgs[newMsgs.length - 1];
              if (last && last.role === 'assistant') last.isCommandOutput = true;
              return newMsgs;
            });
          }
          if (data?.session?.model) setCurrentModelString(data.session.model);
          if (data?.session?.thinkingEffort) setThinkingEffort(data.session.thinkingEffort);
          if (typeof data?.session?.thinking === 'boolean') setThinkingEnabled(data.session.thinking);
          if (data?.refreshModels) window.dispatchEvent(new CustomEvent('webModelsChanged'));
        }
        // TodoWrite 进度
        if (event === 'todos' && Array.isArray(data?.todos)) {
          setTodoItems(data.todos as TodoItem[]);
        }
        // 【2026-10-08 加】自动压缩等系统通知 —— 显示为一条 assistant 气泡。
        // 服务端在 run 结束后跑 autoCompact（与 CLI 同源），产出
        // 「[自动压缩: N → M 条消息]」这类文本，原来 Web 侧没有事件通道会静默丢弃。
        if (event === 'notice' && data?.text) {
          setMessagesFor(conversationId!, prev => [
            ...prev,
            { id: `notice-${Date.now()}`, role: 'assistant', content: String(data.text), isNotice: true } as any,
          ]);
        }
        // plan / deep 模式真实状态
        if (event === 'modes' && data) {
          setPlanMode(!!data.plan);
          setDeepMode(!!data.deep);
        }
        // Handle metadata (update user message ID)
        if (event === 'metadata' && data && data.user_message_id) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        // Handle system/status events (e.g. web search status)
        if (event === 'status' && message) {
          if (!isSearchStatusMessage(message)) return;
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.searchStatus = message;
              lastMsg._contentLenBeforeSearch = (lastMsg.content || '').length;
            }
            return newMsgs;
          });
        }
        // Handle thinking summary
        if (event === 'thinking_summary' && message) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        // Handle auto compaction progress
        if (event === 'compaction_start') {
          setCompactStatus({ state: 'compacting' });
        }
        if (event === 'compaction_done') {
          if (data && data.messagesCompacted > 0) {
            setCompactStatus({ state: 'done', message: `Compacted ${data.messagesCompacted} messages, saved ~${data.tokensSaved} tokens` });
            setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
          } else {
            setCompactStatus({ state: 'idle' });
          }
        }
        // Handle compact_boundary from engine auto-compact during normal chat
        if (event === 'compact_boundary') {
          const meta = data?.compact_metadata || {};
          const preTokens = meta.pre_tokens || 0;
          const saved = preTokens ? Math.round(preTokens * 0.7) : 0;
          setCompactStatus({ state: 'done', message: saved > 0 ? `已自动压缩，节省约${saved} tokens` : '上下文已自动压缩' });
          setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
          // Reload messages to reflect compacted state
          if (activeId) {
            loadConversation(activeId);
            getContextSize(activeId).then(setContextInfo).catch(() => {});
          }
        }
        // Present 工具：Agent 主动推送的可视内容（SVG/HTML/图表/图片/视频），挂到当前助手消息上内联渲染
        if (event === 'present' && data && data.kind) {
          setMessagesFor(conversationId!, prev => {
            const newMsgs = [...prev];
            for (let i = newMsgs.length - 1; i >= 0; i--) {
              if (newMsgs[i]?.role === 'assistant') {
                const prevList = Array.isArray(newMsgs[i].presents) ? newMsgs[i].presents : [];
                newMsgs[i] = { ...newMsgs[i], presents: [...prevList, data] };
                break;
              }
            }
            return newMsgs;
          });
        }
        if (event === 'turn_limit' && data) {
          setTurnLimitToast(data.deep
            ? `已跑 ${data.turns}/${data.max} 轮，接近上限。deep 模式已开，可继续；如已空转可让它收尾。`
            : `已跑 ${data.turns}/${data.max} 轮，接近上限。输入 /deep 可提至 3000 轮继续，或让它收尾汇报。`);
        }
        if (event === 'steering_accepted' && data) {
          // 服务端确认入队。本地已乐观显示，这里只兜底刷新一次历史对齐。
          if (viewingIdRef.current === conversationId) {
            setMessagesFor(conversationId!, prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'user') return prev;
              return [...prev, { id: `steer-${Date.now()}`, role: 'user', content: String(data.content || ''), steering: true } as any];
            });
          }
        }
        if (event === 'metrics' && data) setRunMetrics(data);
        if (event === 'context_size' && data) {
          setContextInfo({ tokens: data.tokens, limit: data.limit, exact: !!data.exact });
        }
        if (event === 'stream_gap') {
          // 断线太久，服务端缓冲已覆盖不到缺口：整体重载这条会话，避免中间内容缺失
          getConversation(conversationId!).then(fresh => {
            const msgs = (fresh.messages || []).map((m: any) => sanitizeInlineArtifactMessage(m));
            setMessagesFor(conversationId!, () => msgs);
          }).catch(() => { });
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          setMessages(prev => applyResearchEvent(prev, event, data));
        }
        // AskUserQuestion — engine needs user input
        if (event === 'ask_user' && data) {
          setAskUserDialog({
            request_id: data.request_id,
            tool_use_id: data.tool_use_id,
            questions: data.questions || [],
            answers: {},
          });
        }
        // Task/Agent progress
        if (event === 'task_event' && data) {
          setActiveTasks(prev => {
            const next = new Map(prev);
            if (data.subtype === 'task_started') {
              next.set(data.task_id, { description: data.description || '任务运行中…' });
            } else if (data.subtype === 'task_progress') {
              const existing = next.get(data.task_id);
              if (existing) {
                next.set(data.task_id, { ...existing, last_tool_name: data.last_tool_name, summary: data.summary });
              }
            } else if (data.subtype === 'task_notification') {
              next.delete(data.task_id);
            }
            return next;
          });
        }
      },
      (sources, query, tokens) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // Handle search_sources — collect citation sources
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            const existing = lastMsg.citations || [];

            // 去重合并
            const existingUrls = new Set(existing.map((s: any) => s.url));
            const newSources = sources.filter((s: any) => !existingUrls.has(s.url));
            lastMsg.citations = [...existing, ...newSources];

            if (query) {
              const logs = lastMsg.searchLogs || [];
              // 检查是否已存在相同的 query
              const existingLogIndex = logs.findIndex((log: any) => log.query === query);
              if (existingLogIndex !== -1) {
                // 更新现有 log 的 results 和 tokens
                const existingLog = logs[existingLogIndex];
                const currentResults = existingLog.results || [];
                const currentUrls = new Set(currentResults.map((r: any) => r.url));
                const uniqueNewResults = sources.filter((s: any) => !currentUrls.has(s.url));
                existingLog.results = [...currentResults, ...uniqueNewResults];
                if (tokens !== undefined) {
                  existingLog.tokens = tokens;
                }
              } else {
                // 添加新 log
                logs.push({ query, results: sources, tokens });
              }
              lastMsg.searchLogs = logs;
            }
          }
          return newMsgs;
        });
      },
      (doc) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      async (data) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;
        // Handle code_execution / code_result events
        if (data.type === 'code_execution') {
          // 收到代码执行请求 — 更新消息状态 + 在 Pyodide 中执行
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.codeExecution = {
                code: data.code || '',
                status: 'running' as const,
                stdout: '',
                stderr: '',
                images: [],
                error: null,
              };
            }
            return newMsgs;
          });

          // 构建文件列表（附件 URL）
          const authToken = localStorage.getItem('auth_token') || '';
          const files = (data.files || []).map((f: any) => ({
            name: f.name,
            url: (() => {
              const baseUrl = getAttachmentUrl(f.id);
              if (!authToken) return baseUrl;
              return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`;
            })(),
          }));

          try {
            const result = await executeCode(data.code || '', files, data.executionId);
            // 发送结果回后端
            await sendCodeResult(data.executionId, result);
          } catch (e: any) {
            // 发送错误结果回后端
            await sendCodeResult(data.executionId, {
              stdout: '',
              stderr: '',
              images: [],
              error: e.message || 'Pyodide 执行失败',
            });
          }
        }

        if (data.type === 'code_result') {
          // 收到执行结果 — 更新消息状态
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.codeExecution) {
              lastMsg.codeExecution = {
                ...lastMsg.codeExecution,
                status: data.error ? 'error' as const : 'done' as const,
                stdout: data.stdout || '',
                stderr: data.stderr || '',
                images: data.images || [],
                error: data.error || null,
              };
            }
            return newMsgs;
          });
        }
      },
      // Handle tool use events from SDK
      (toolEvent) => {
        if (!isStreamSessionActive(conversationId!, streamRequestId)) return;

        // Track plan mode from tool events
        if (toolEvent.type === 'done' && toolEvent.tool_name === 'EnterPlanMode') setPlanMode(true);
        if (toolEvent.type === 'done' && toolEvent.tool_name === 'ExitPlanMode') setPlanMode(false);

        // Don't add internal tools to UI tool list
        // 只隐藏纯内部任务工具；Plan/Deep 等模式切换要让用户看到 Agent 做了什么
        // 官方把 Task 工具当 subagent 内部调度管道隐藏；我们的 Task 是显式协作待办，
        // 用户就是要看到 AI 在派活/领活/交付，全隐藏等于协作过程变黑箱。
        // 另外 Team 那半（SendMessage/CheckMessages）本来就没被隐藏，
        // 一半可见一半不可见比全显示更让人困惑。这里改成不隐藏任何协作工具。
        const INTERNAL_TOOLS = new Set<string>([]);
        if (INTERNAL_TOOLS.has(toolEvent.tool_name || '')) return;

        setMessagesFor(conversationId!, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') return prev;

          const toolCalls = lastMsg.toolCalls || [];

          if (toolEvent.type === 'start') {
            // Dedupe by id (we may receive a placeholder tool_use_start before
            // the input has finished streaming, then a tool_use_input later)
            let existing = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (existing) {
              existing.name = toolEvent.tool_name || existing.name;
              if (toolEvent.tool_input && Object.keys(toolEvent.tool_input).length > 0) existing.input = toolEvent.tool_input;
              if (toolEvent.textBefore) existing.textBefore = toolEvent.textBefore;
            } else {
              toolCalls.push({
                id: toolEvent.tool_use_id,
                name: toolEvent.tool_name || 'unknown',
                input: toolEvent.tool_input || {},
                status: 'running' as const,
                textBefore: toolEvent.textBefore || '',
              });
            }
          } else if (toolEvent.type === 'input') {
            // Update an existing tool's input after the JSON has fully streamed
            const tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (tc) tc.input = toolEvent.tool_input || {};
          } else if (toolEvent.type === 'done') {
            let tc = toolCalls.find((t: any) => t.id === toolEvent.tool_use_id);
            if (!tc) {
              // tool_use_start was missed — back-fill the entry so the card still renders
              tc = { id: toolEvent.tool_use_id, name: toolEvent.tool_name || 'unknown', input: {}, status: 'done' as const, result: toolEvent.content };
              toolCalls.push(tc);
            } else {
              tc.status = toolEvent.is_error ? 'error' as const : 'done' as const;
              tc.result = toolEvent.content;
            }
          }

          lastMsg.toolCalls = toolCalls;
          return newMsgs;
        });
      },
      controller.signal
    );
  };


  // Auto-send initialMessage from Project page navigation
  useEffect(() => {
    if (pendingInitialMessageRef.current && activeId && !loading) {
      const msg = pendingInitialMessageRef.current;
      pendingInitialMessageRef.current = null;
      // Small delay to let conversation finish loading
      setTimeout(() => handleSend(msg), 150);
    }
  }, [activeId, loading]);

  // 停止生成（双模式：SSE 直连 or 轮询模式）
  const handleStop = () => {
    if (abortStreamSession(activeId || undefined)) {
      if (activeId) removeStreaming(activeId);
      return;
    }
    if (pollingRef.current && activeId) {
      // 轮询模式：调用后端停止接口
      stopGeneration(activeId).catch(e => console.error('[Stop] error:', e));
      stopPolling();
    }
    if (activeId) removeStreaming(activeId);
    setLoading(false);
    isCreatingRef.current = false;
  };

  // 复制消息内容
  // 复制消息内容
  const handleCopyMessage = (content: string, idx: number) => {
    copyToClipboard(content).then((success) => {
      if (success) {
        setCopiedMessageIdx(idx);
        setTimeout(() => setCopiedMessageIdx(null), 2000);
      }
    });
  };

  const extractMessageAttachments = (msg: any) => {
    const raw = Array.isArray(msg?.attachments)
      ? msg.attachments.filter((att: any) => att && ((typeof att.id === 'string' && att.id.trim()) || (typeof att.fileId === 'string' && att.fileId.trim())))
      : [];
    // Normalize to snake_case for component compatibility
    const attachments = raw.map((att: any) => ({
      ...att,
      id: att.id || att.fileId || '',
      file_name: att.file_name || att.fileName || 'file',
      file_type: att.file_type || att.fileType || 'document',
      mime_type: att.mime_type || att.mimeType || '',
      file_size: att.file_size || att.size || 0,
    }));
    const attachmentIds = attachments.map((att: any) => att.id);
    return {
      attachmentIds,
      attachmentsPayload: attachments.length > 0
        ? attachments.map((att: any) => ({ fileId: att.id, fileName: att.file_name, fileType: att.file_type, mimeType: att.mime_type, size: att.file_size }))
        : null,
      optimisticAttachments: attachments,
    };
  };

  // 重新发送消息
  const handleResendMessage = async (content: string, idx: number) => {
    if (loading) return;
    if (activeRequestCountRef.current >= 2) {
      alert('最多同时进行 2 个对话，请等待其他对话完成');
      return;
    }
    const msg = messages[idx];
    const { attachmentIds, attachmentsPayload, optimisticAttachments } = extractMessageAttachments(msg);
    const conversationId = activeId;
    if (!conversationId) {
      alert('当前没有活动对话，无法重新发送');
      return;
    }
    // 先真实截断服务端历史。此前先 slice 前端、删除失败仍照样发送，
    // 导致表面像新分支，Agent 却仍携带旧后续上下文。
    try {
      if (msg.id) await deleteMessagesFrom(conversationId, msg.id, attachmentIds);
      else {
        const tailCount = messages.length - idx;
        if (tailCount > 0) await deleteMessagesTail(conversationId, tailCount, attachmentIds);
      }
    } catch (err) {
      console.error('Failed to truncate messages before resend:', err);
      alert(err instanceof Error ? `无法重新发送：${err.message}` : '无法重新发送：历史截断失败');
      return;
    }
    const tempUserMsg: any = { role: 'user', content, created_at: new Date().toISOString(), model: currentModelString };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }
    // 服务端确认截断后再更新前端，随后重新发送。
    setMessages(prev => [
      ...prev.slice(0, idx),
      tempUserMsg,
      createAssistantPlaceholder({ model: tempUserMsg.model }),
    ]);
    // 直接重新发送
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);
    const controller = new AbortController();
    const streamRequestId = beginStreamSession(conversationId);
    abortControllerRef.current = controller;
    setLoading(true);
    addStreaming(conversationId);
    activeRequestCountRef.current += 1;
    await sendMessage(
      conversationId,
      content,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        messagesBufferRef.current.delete(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllerRef.current = null;
        clearStreamSession(conversationId, streamRequestId);
        getContextSize(conversationId).then(setContextInfo).catch(() => { });
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });
      },
      (err) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setLoading(false);
        abortControllerRef.current = null;
        clearStreamSession(conversationId, streamRequestId);
        setMessages(prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantThinkingUpdate(lastMsg, thinkingFull);
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (event === 'metadata' && data && data.user_message_id) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        if (event === 'thinking_summary' && message) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        // Present 工具：Agent 主动推送的可视内容（SVG/HTML/图表/图片/视频），挂到当前助手消息上内联渲染
        if (event === 'present' && data && data.kind) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            for (let i = newMsgs.length - 1; i >= 0; i--) {
              if (newMsgs[i]?.role === 'assistant') {
                const prevList = Array.isArray(newMsgs[i].presents) ? newMsgs[i].presents : [];
                newMsgs[i] = { ...newMsgs[i], presents: [...prevList, data] };
                break;
              }
            }
            return newMsgs;
          });
        }
        if (event === 'context_size' && data) {
          setContextInfo({ tokens: data.tokens, limit: data.limit, exact: !!data.exact });
        }
        if (event === 'stream_gap') {
          // 断线太久，服务端缓冲已覆盖不到缺口：整体重载这条会话，避免中间内容缺失
          getConversation(conversationId).then(fresh => {
            const msgs = (fresh.messages || []).map((m: any) => sanitizeInlineArtifactMessage(m));
            setMessagesFor(conversationId, () => msgs);
          }).catch(() => { });
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          setMessages(prev => applyResearchEvent(prev, event, data));
        }
      },
      undefined,
      (doc) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      undefined,
      undefined,
      controller.signal
    );
  };

  // 编辑消息 — 进入原地编辑模式（不立即删除后续消息）
  const handleEditMessage = (content: string, idx: number) => {
    if (loading) return;
    setEditingMessageIdx(idx);
    setEditingContent(content);
  };

  // 取消编辑
  const handleEditCancel = () => {
    setEditingMessageIdx(null);
    setEditingContent('');
  };

  // 保存编辑 — 删除当前及后续消息，用新内容重新发送
  const handleEditSave = async () => {
    if (editingMessageIdx === null || !editingContent.trim() || loading) return;
    if (activeRequestCountRef.current >= 2) {
      alert('最多同时进行 2 个对话，请等待其他对话完成');
      return;
    }
    const idx = editingMessageIdx;
    const msg = messages[idx];
    const newContent = editingContent.trim();
    const { attachmentIds, attachmentsPayload, optimisticAttachments } = extractMessageAttachments(msg);
    const conversationId = activeId;
    if (!conversationId) {
      alert('当前没有活动对话，无法保存编辑');
      return;
    }
    // 后端截断是编辑事务的第一步。失败时保留编辑框和原消息，
    // 绝不假装已经建立了新分支。
    try {
      if (msg.id) await deleteMessagesFrom(conversationId, msg.id, attachmentIds);
      else {
        const tailCount = messages.length - idx;
        if (tailCount > 0) await deleteMessagesTail(conversationId, tailCount, attachmentIds);
      }
    } catch (err) {
      console.error('Failed to truncate messages before edit:', err);
      alert(err instanceof Error ? `无法保存编辑：${err.message}` : '无法保存编辑：历史截断失败');
      return;
    }

    // 截断确认后才退出编辑模式并切换本地 UI。
    setEditingMessageIdx(null);
    setEditingContent('');

    const tempUserMsg: any = { role: 'user', content: newContent, created_at: new Date().toISOString(), model: currentModelString };
    if (optimisticAttachments.length > 0) {
      tempUserMsg.has_attachments = 1;
      tempUserMsg.attachments = optimisticAttachments;
    }

    setMessages(prev => [
      ...prev.slice(0, idx),
      tempUserMsg,
      createAssistantPlaceholder({ model: tempUserMsg.model }),
    ]);

    // 直接发送新内容
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom('auto'), 50);

    const controller = new AbortController();
    const streamRequestId = beginStreamSession(conversationId);
    abortControllerRef.current = controller;
    setLoading(true);
    addStreaming(conversationId);
    activeRequestCountRef.current += 1;
    await sendMessage(
      conversationId,
      newContent,
      attachmentsPayload,
      (delta, full) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });
      },
      (full) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        messagesBufferRef.current.delete(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (viewingIdRef.current === conversationId) setLoading(false);
        abortControllerRef.current = null;
        clearStreamSession(conversationId, streamRequestId);
        getContextSize(conversationId).then(setContextInfo).catch(() => { });
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantTextUpdate(lastMsg, full);
          }
          return newMsgs;
        });
      },
      (err) => {
        // Always clean up streaming state and request count
        removeStreaming(conversationId);
        activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setLoading(false);
        abortControllerRef.current = null;
        clearStreamSession(conversationId, streamRequestId);
        setMessages(prev => {
          const newMsgs = [...prev];
          if (newMsgs[newMsgs.length - 1] && newMsgs[newMsgs.length - 1].role === 'assistant') {
            newMsgs[newMsgs.length - 1].content = formatChatError(err);
            newMsgs[newMsgs.length - 1].isThinking = false;
          }
          return newMsgs;
        });
      },
      (thinkingDelta, thinkingFull) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastMsg = newMsgs[newMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            applyAssistantThinkingUpdate(lastMsg, thinkingFull);
          }
          return newMsgs;
        });
      },
      (event, message, data) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        if (event === 'metadata' && data && data.user_message_id) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const userIdx = newMsgs.length - 2;
            if (userIdx >= 0 && newMsgs[userIdx].role === 'user') {
              newMsgs[userIdx] = { ...newMsgs[userIdx], id: data.user_message_id };
            }
            return newMsgs;
          });
        }
        if (event === 'thinking_summary' && message) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.thinking_summary = message;
            }
            return newMsgs;
          });
        }
        // Present 工具：Agent 主动推送的可视内容（SVG/HTML/图表/图片/视频），挂到当前助手消息上内联渲染
        if (event === 'present' && data && data.kind) {
          setMessagesFor(conversationId, prev => {
            const newMsgs = [...prev];
            for (let i = newMsgs.length - 1; i >= 0; i--) {
              if (newMsgs[i]?.role === 'assistant') {
                const prevList = Array.isArray(newMsgs[i].presents) ? newMsgs[i].presents : [];
                newMsgs[i] = { ...newMsgs[i], presents: [...prevList, data] };
                break;
              }
            }
            return newMsgs;
          });
        }
        if (event === 'context_size' && data) {
          setContextInfo({ tokens: data.tokens, limit: data.limit, exact: !!data.exact });
        }
        if (event === 'stream_gap') {
          // 断线太久，服务端缓冲已覆盖不到缺口：整体重载这条会话，避免中间内容缺失
          getConversation(conversationId).then(fresh => {
            const msgs = (fresh.messages || []).map((m: any) => sanitizeInlineArtifactMessage(m));
            setMessagesFor(conversationId, () => msgs);
          }).catch(() => { });
        }
        if (event === 'tool_text_offset' && data && data.offset != null) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const lastMsg = newMsgs[newMsgs.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.toolTextEndOffset = data.offset;
            }
            return newMsgs;
          });
        }
        if (event && event.startsWith('research_')) {
          setMessages(prev => applyResearchEvent(prev, event, data));
        }
      },
      undefined,
      (doc) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentsIntoMessage(newMsgs[lastIdx], doc);
          }
          return newMsgs;
        });
      },
      (draft) => {
        if (!isStreamSessionActive(conversationId, streamRequestId)) return;
        setMessagesFor(conversationId, prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (newMsgs[lastIdx] && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = mergeDocumentDraftIntoMessage(newMsgs[lastIdx], draft);
          }
          return newMsgs;
        });
      },
      undefined,
      undefined,
      controller.signal
    );
  };

  // 切换消息展开/折叠
  const toggleMessageExpand = (idx: number) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // === 文件上传相关 ===
  const ACCEPTED_TYPES = 'image/png,image/jpeg,image/jpg,image/gif,image/webp,application/pdf,.docx,.xlsx,.pptx,.odt,.rtf,.epub,.txt,.md,.csv,.json,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.java,.cpp,.c,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.scala,.html,.css,.scss,.less,.sql,.sh,.bash,.vue,.svelte,.lua,.r,.m,.pl,.ex,.exs';

  const handleFilesSelected = (files: FileList | File[], defaults?: Partial<PendingFile>) => {
    const fileArray = Array.from(files);
    const maxFiles = 20;
    const currentCount = pendingFiles.length;
    const allowed = fileArray.slice(0, maxFiles - currentCount);

    for (const file of allowed) {
      const id = Math.random().toString(36).slice(2);
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

      const pending: PendingFile = {
        id,
        file,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        progress: 0,
        status: 'uploading',
        previewUrl,
        ...(defaults || {}),
      };

      setPendingFiles(prev => [...prev, pending]);

      // Calculate lines for text files
      const textExtensions = /\.(txt|md|csv|json|xml|yaml|yml|js|jsx|ts|tsx|py|java|cpp|c|h|cs|go|rs|rb|php|swift|kt|scala|html|css|scss|less|sql|sh|bash|vue|svelte|lua|r|m|pl|ex|exs)$/i;
      if (file.size < 5 * 1024 * 1024 && (file.type.startsWith('text/') || textExtensions.test(file.name))) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target?.result as string;
          if (text) {
            const lines = text.split(/\r\n|\r|\n/).length;
            setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, lineCount: lines } : f));
          }
        };
        reader.readAsText(file);
      }

      uploadFile(file, (percent) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, progress: percent } : f));
      }, activeId).then((result) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? {
          ...f,
          fileId: result.fileId,
          fileType: result.fileType || (file.type.startsWith('image/') ? 'image' : 'document'),
          mimeType: result.mimeType || file.type,
          status: 'done' as const,
          progress: 100,
        } : f));
      }).catch((err) => {
        setPendingFiles(prev => prev.map(f => f.id === id ? {
          ...f,
          status: 'error' as const,
          error: err.message,
        } : f));
      });
    }
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles(prev => {
      const file = prev.find(f => f.id === id);
      if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
      // 已上传的文件调后端删除，释放存储空间
      if (file?.fileId) {
        deleteAttachment(file.fileId).catch(() => { });
      }
      return prev.filter(f => f.id !== id);
    });
  };

  // Handle "Add from GitHub" confirmation: resolve/create conversation,
  // materialize files into its workspace, then add a visual-only card.
  const handleGithubAdd = async (payload: GithubAddPayload): Promise<void> => {
    let convId = activeId;
    let createdNewConv = false;
    if (!convId) {
      const modelForCreate = isModelSelectable(currentModelString)
        ? currentModelString
        : resolveModelForNewChat(currentModelString);
      const newConv = await createConversation(undefined, modelForCreate, { research_mode: researchMode });
      if (!newConv || !newConv.id) throw new Error('Failed to create conversation');
      convId = newConv.id;
      createdNewConv = true;
      warmEngine(convId);
      onNewChat();
    }

    const result = await materializeGithub(
      convId,
      payload.repoFullName,
      payload.ref,
      payload.selections,
    );

    const githubCard: PendingFile = {
      id: Math.random().toString(36).slice(2),
      file: new File([], 'github-placeholder'),
      fileName: payload.repoFullName,
      mimeType: 'application/x-github',
      size: 0,
      progress: 100,
      status: 'done',
      source: 'github',
      ghRepo: payload.repoFullName,
      ghRef: payload.ref,
      lineCount: result.fileCount,
    };

    if (createdNewConv) {
      // Stash the card into draftsStore under the NEW conv key so the mount
      // effect restores it. Then navigate — the useEffect will pick it up.
      const text = inputTextRef.current || '';
      const height = textareaHeightRef.current || inputBarBaseHeight;
      draftsStore.set(convId, { text, files: [githubCard], height });
      navigate(`/chat/${convId}`, { replace: true });
    } else {
      setPendingFiles(prev => [...prev, githubCard]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    // 1. 优先检查图片
    const items = e.clipboardData?.items;
    if (items) {
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleFilesSelected(imageFiles);
        return;
      }
    }

    // 2. 检查长文本 (超过 10000 字符或 100 行自动转为附件)
    const text = e.clipboardData.getData('text');
    if (text) {
      const lineCount = text.split('\n').length;
      if (text.length > 10000 || lineCount > 100) {
        e.preventDefault();
        const blob = new Blob([text], { type: 'text/plain' });
        const file = new File([blob], 'Pasted-Text.txt', { type: 'text/plain' });
        handleFilesSelected([file]);
      }
    }
  };

  const resizeLandingInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
    el.style.overflowY = el.scrollHeight > 300 ? 'auto' : 'hidden';
  }, []);

  const updateInputFromVoice = useCallback((nextValue: string) => {
    setInputText(nextValue);
    requestAnimationFrame(() => resizeLandingInput());
  }, [resizeLandingInput]);

  const stopVoiceDictation = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {}
  }, []);

  const handleVoiceDictationToggle = useCallback(() => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setVoiceToast('当前环境暂不支持语音听写。');
      return;
    }

    if (isVoiceListening) {
      stopVoiceDictation();
      return;
    }

    try {
      const recognition = new SpeechRecognitionCtor() as BrowserSpeechRecognition;
      recognitionRef.current = recognition;
      voiceBaseInputRef.current = inputText.trimEnd();
      voiceCommittedTranscriptRef.current = '';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'zh-CN';

      recognition.onstart = () => {
        setIsVoiceListening(true);
      };

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const transcript = event.results[i]?.[0]?.transcript ?? '';
          if (!transcript) continue;
          if (event.results[i].isFinal) {
            voiceCommittedTranscriptRef.current += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        const nextTranscript = `${voiceCommittedTranscriptRef.current}${interimTranscript}`.trim();
        const nextValue = [voiceBaseInputRef.current, nextTranscript].filter(Boolean).join(' ').trim();
        updateInputFromVoice(nextValue);
      };

      recognition.onerror = (event: any) => {
        const message = formatVoiceError(event?.error);
        if (message) setVoiceToast(message);
        recognitionRef.current = null;
        setIsVoiceListening(false);
      };

      recognition.onend = () => {
        recognitionRef.current = null;
        setIsVoiceListening(false);
      };

      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsVoiceListening(false);
      setVoiceToast('当前环境暂时无法启动语音听写。');
    }
  }, [inputText, isVoiceListening, stopVoiceDictation, updateInputFromVoice]);


  // --- Render Logic ---

  const closePlusMenu = () => {
    setShowPlusMenu(false);
    setShowSkillsSubmenu(false);
    setShowProjectsSubmenu(false);
  };

  const landingPlusMenuShellClass = "absolute left-0 top-full mt-2 z-50 w-[218px] rounded-[12px] border border-[rgba(31,31,30,0.3)] dark:border-white/15 bg-white dark:bg-claude-input px-[7px] pb-px pt-[7px] shadow-[0_2px_8px_rgba(0,0,0,0.08)]";
  const landingPlusMenuItemClass = "flex h-[32px] w-full items-center gap-[8px] rounded-[8px] px-[8px] py-[6px] text-left transition-colors hover:bg-[#F5F4F1] dark:hover:bg-white/5";
  const landingPlusMenuTextClass = "text-[14px] leading-[20px] tracking-[-0.1504px] text-[#121212] dark:text-claude-text";
  const landingPlusMenuSubmenuClass = "absolute left-full top-0 ml-2 z-50 w-[218px] max-h-[30vh] overflow-y-auto rounded-[12px] border border-[rgba(31,31,30,0.3)] dark:border-white/15 bg-white dark:bg-claude-input px-[7px] pb-px pt-[7px] shadow-[0_2px_8px_rgba(0,0,0,0.08)]";
  const conversationPlusMenuShellClass = "absolute bottom-full left-0 mb-2 z-50 w-[218px] rounded-[12px] border border-[rgba(31,31,30,0.3)] dark:border-white/15 bg-white dark:bg-claude-input px-[7px] pb-px pt-[7px] shadow-[0_2px_8px_rgba(0,0,0,0.08)]";
  const conversationPlusMenuSubmenuClass = "absolute left-full bottom-0 ml-2 z-50 w-[218px] max-h-[30vh] overflow-y-auto rounded-[12px] border border-[rgba(31,31,30,0.3)] dark:border-white/15 bg-white dark:bg-claude-input px-[7px] pb-px pt-[7px] shadow-[0_2px_8px_rgba(0,0,0,0.08)]";
  const landingSendButtonClass = "flex h-[32px] w-[40px] items-center justify-center rounded-[8px] border border-transparent bg-[#efcbc0] text-white transition-colors hover:bg-[#e7bcaf] dark:border-[#4F4540] dark:bg-[#34312E] dark:text-[#F5D7CA] dark:hover:bg-[#3E3935] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] disabled:cursor-not-allowed disabled:opacity-40";
  const conversationSendButtonClass = "p-2 rounded-lg border border-transparent bg-[#C6613F] text-white transition-colors hover:bg-[#D97757] dark:border-[#4F4540] dark:bg-[#34312E] dark:text-[#F5D7CA] dark:hover:bg-[#3E3935] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] disabled:opacity-40 disabled:cursor-not-allowed";

  const renderSharedPlusMenu = (shellClass: string, submenuClass: string) => (
    <div
      ref={plusMenuRef}
      className={shellClass}
    >
      <button
        onMouseEnter={() => { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); }}
        onClick={() => { closePlusMenu(); fileInputRef.current?.click(); }}
        className={landingPlusMenuItemClass}
      >
        <img src={plusMenuAttachIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
        <span className={landingPlusMenuTextClass}>添加文件或照片</span>
      </button>
      <button
        onMouseEnter={() => { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); }}
        onClick={async () => {
          // 【原来是个死按钮】onClick 只调 closePlusMenu()，点了什么都不发生。
          // 手机上的「截屏」应该走 Termux API：抓当前屏幕 → 作为附件塞进输入框。
          closePlusMenu();
          try {
            const resp = await fetch('/api/screenshot', { method: 'POST' });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data?.error || `截屏失败（HTTP ${resp.status}）`);
            // 直接把截图当附件（服务端已存成上传文件，这里只登记元信息）
            //
            // 【2026-09-19 修】原来这个对象同时塞了 snake_case 和 camelCase 两套字段名，
            // 既冗余又漏了 PendingFile 的**必填** file / progress ——
            // 结果是「截取屏幕」后附件卡片缺字段，渲染/预览会异常（TS 报 TS2345）。
            // 统一成 PendingFile 的 camelCase 形态 + 补一个占位 File（服务端已存好文件，
            // 前端只需要 id 去引用它，不需要真的字节）。
            const shotName = data.file_name || `screenshot-${Date.now()}.png`;
            setPendingFiles(prev => [...prev, {
              id: data.id,
              fileId: data.id,
              file: new File([], shotName, { type: 'image/png' }),
              fileName: shotName,
              fileType: 'image' as const,
              mimeType: 'image/png',
              size: data.size || 0,
              progress: 100,
              status: 'done' as const,
            }]);
          } catch (e) {
            window.alert(e instanceof Error ? e.message : '截屏失败');
          }
        }}
        className={landingPlusMenuItemClass}
      >
        <img src={plusMenuScreenshotIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
        <span className={landingPlusMenuTextClass}>截取屏幕</span>
      </button>
      <div className="relative" onMouseLeave={() => setShowProjectsSubmenu(false)}>
        <button
          onMouseEnter={() => { setShowProjectsSubmenu(true); setShowSkillsSubmenu(false); }}
          onClick={() => setShowProjectsSubmenu(prev => !prev)}
          className={`${landingPlusMenuItemClass} justify-between`}
        >
          <div className="flex items-center gap-[8px]">
            <img src={plusMenuProjectIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
            <span className={landingPlusMenuTextClass}>添加到项目</span>
          </div>
          <img src={plusMenuChevronIcon} alt="" aria-hidden="true" className="h-[16px] w-[16px] shrink-0 dark:invert dark:brightness-150" />
        </button>
        {showProjectsSubmenu && (
          <div className={submenuClass}>
            {projectList.length > 0 ? projectList.map(p => {
              const isSelected = (activeId && currentProjectId === p.id) || (!activeId && pendingProjectId === p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => handleAttachToProject(p)}
                  className="flex h-[32px] w-full items-center justify-between gap-2 rounded-[8px] px-[8px] text-left transition-colors hover:bg-[#F5F4F1] dark:hover:bg-white/5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <IconProjects size={20} className="text-claude-textSecondary shrink-0 dark:[filter:brightness(0)_invert(1)_brightness(0.68)_sepia(0.18)]" />
                    <span className="truncate text-[14px] leading-[20px] tracking-[-0.1504px] text-[#121212] dark:text-claude-text">{p.name}</span>
                  </div>
                  {isSelected && <Check size={14} className="shrink-0 text-[#2977D6]" />}
                </button>
              );
            }) : (
              <div className="px-[8px] py-[6px] text-[13px] italic text-[#7B7974] dark:text-claude-textSecondary">暂无项目</div>
            )}
            <div className="mx-[8px] my-[7px] h-px bg-[rgba(31,31,30,0.15)] dark:bg-white/10" />
            <button
              onClick={() => {
                setShowProjectsSubmenu(false);
                closePlusMenu();
                setNewProjectName('');
                setNewProjectDescription('');
                setShowNewProjectDialog(true);
              }}
              className="flex h-[32px] w-full items-center gap-[8px] rounded-[8px] px-[8px] text-left transition-colors hover:bg-[#F5F4F1] dark:hover:bg-white/5"
            >
              <Plus size={14} className="text-[#7B7974] dark:text-claude-textSecondary" />
              <span className="text-[14px] leading-[20px] tracking-[-0.1504px] text-[#121212] dark:text-claude-text">新建项目</span>
            </button>
          </div>
        )}
      </div>
      <div className="mx-[8px] my-[7px] h-px bg-[rgba(31,31,30,0.15)] dark:bg-white/10" />
      <div className="relative" onMouseLeave={() => setShowSkillsSubmenu(false)}>
        <button
          onMouseEnter={() => { setShowSkillsSubmenu(true); setShowProjectsSubmenu(false); }}
          onClick={() => setShowSkillsSubmenu(prev => !prev)}
          className={`${landingPlusMenuItemClass} justify-between`}
        >
          <div className="flex items-center gap-[8px]">
            <img src={plusMenuSkillsIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
            <span className={landingPlusMenuTextClass}>技能</span>
          </div>
          <img src={plusMenuChevronIcon} alt="" aria-hidden="true" className="h-[16px] w-[16px] shrink-0 dark:invert dark:brightness-150" />
        </button>
        {showSkillsSubmenu && (
          <div className={submenuClass}>
            {enabledSkills.length > 0 ? enabledSkills.map(skill => (
              <button
                key={skill.id}
                onClick={() => {
                  closePlusMenu();
                  const slug = skill.name.toLowerCase().replace(/\s+/g, '-');
                  setSelectedSkill({ name: skill.name, slug, description: skill.description });
                  setInputText(prev => prev ? `/${slug} ${prev}` : `/${slug} `);
                  inputRef.current?.focus();
                }}
                className="flex h-[32px] w-full items-center rounded-[8px] px-[8px] text-left transition-colors hover:bg-[#F5F4F1] dark:hover:bg-white/5"
              >
                <span className="truncate text-[14px] leading-[20px] tracking-[-0.1504px] text-[#121212] dark:text-claude-text">{skill.name}</span>
              </button>
            )) : (
              <div className="px-[8px] py-[6px] text-[13px] italic text-[#7B7974] dark:text-claude-textSecondary">暂无已启用技能</div>
            )}
            <div className="mx-[8px] my-[7px] h-px bg-[rgba(31,31,30,0.15)] dark:bg-white/10" />
            <button
              onClick={() => {
                closePlusMenu();
                window.location.hash = '#/customize';
              }}
              className="flex h-[32px] w-full items-center gap-[8px] rounded-[8px] px-[8px] text-left transition-colors hover:bg-[#F5F4F1] dark:hover:bg-white/5"
            >
              <img src={plusMenuSkillsIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
              <span className="text-[14px] leading-[20px] tracking-[-0.1504px] text-[#121212] dark:text-claude-text">管理技能</span>
            </button>
          </div>
        )}
      </div>
      <button
        onMouseEnter={() => { setShowSkillsSubmenu(false); setShowProjectsSubmenu(false); }}
        onClick={() => { closePlusMenu(); navigate('/customize'); }}
        className={landingPlusMenuItemClass}
      >
        <img src={plusMenuConnectorsIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] shrink-0 dark:invert dark:brightness-200" />
        <span className={landingPlusMenuTextClass}>添加连接器</span>
      </button>
      <div className="mx-[8px] my-[7px] h-px bg-[rgba(31,31,30,0.15)] dark:bg-white/10" />
      {/* 【2026-09-20 用户要求】这里原来有「网页搜索」和「使用风格」两个按钮，
          但用户反馈「选了也不会改变什么，去掉」。
          核实：
            · 「网页搜索」只切 researchMode 一个 UI 开关，实际搜索能力由 Provider
              的 supportsWebSearch 决定（设置页里配），这个按钮改不了任何行为；
            · 「使用风格」onClick 只有 closePlusMenu()，**什么都没做**（死代码）。
          两者都是"看着能点、点了没用"的装饰，删掉比留着让人困惑好。 */}
    </div>
  );

  // Shared overlays rendered in both MODE 1 and MODE 2
  const sharedProjectOverlays = (
    <>
      {showNewProjectDialog && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
          onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
        >
          <div className="bg-claude-bg border border-claude-border rounded-2xl shadow-xl w-[560px] max-w-[92vw] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-7 pt-6 pb-4">
              <h2 className="font-[Spectral] text-[22px] text-claude-text" style={{ fontWeight: 600 }}>创建项目</h2>
              <button
                onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
                className="p-1 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-7 pb-4 space-y-5">
              <div>
                <label className="block text-[15px] font-medium text-claude-textSecondary mb-2">你正在做什么？</label>
                <input
                  type="text"
                  placeholder="项目名称"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newProjectName.trim()) handleCreateProjectFromMenu(); }}
                  className="w-full px-4 py-3 bg-white dark:bg-claude-input border border-gray-200 dark:border-claude-border rounded-xl text-claude-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[15px] font-medium text-claude-textSecondary mb-2">What are you trying to achieve?</label>
                <textarea
                  placeholder="描述你的项目、目标、主题等..."
                  rows={3}
                  value={newProjectDescription}
                  onChange={e => setNewProjectDescription(e.target.value)}
                  className="w-full px-4 py-3 bg-white dark:bg-claude-input border border-gray-200 dark:border-claude-border rounded-xl text-claude-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px] resize-none"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-7 pb-6 pt-2">
              <button
                onClick={() => { setShowNewProjectDialog(false); setNewProjectName(''); setNewProjectDescription(''); }}
                className="px-5 py-2.5 text-[15px] font-medium text-claude-text bg-white dark:bg-claude-bg border border-gray-300 dark:border-claude-border hover:bg-gray-50 dark:hover:bg-claude-hover rounded-xl transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreateProjectFromMenu}
                disabled={!newProjectName.trim()}
                className="px-5 py-2.5 text-[15px] font-medium text-claude-bg bg-black dark:bg-white dark:text-black hover:opacity-90 rounded-xl transition-opacity disabled:opacity-40"
              >
                创建项目
              </button>
            </div>
          </div>
        </div>
      )}
      {projectAddToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 bg-claude-input border border-claude-border rounded-lg shadow-lg text-[13px] text-claude-text flex items-center gap-2">
          <Check size={14} className="text-[#C6613F]" />
          {projectAddToast}
        </div>
      )}
      {webSearchToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 bg-claude-input border border-claude-border rounded-lg shadow-lg text-[13px] text-claude-text flex items-center gap-2">
          <IconWebSearch size={14} className="text-claude-textSecondary" />
          {webSearchToast}
        </div>
      )}
      {turnLimitToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2.5 bg-amber-500/95 text-white rounded-lg shadow-lg text-[13px] font-medium flex items-center gap-2 max-w-[90vw]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{turnLimitToast}</span>
        </div>
      )}
      {voiceToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 bg-claude-input border border-claude-border rounded-lg shadow-lg text-[13px] text-claude-text flex items-center gap-2">
          <IconVoice size={14} className="text-[#121212]" />
          {voiceToast}
        </div>
      )}
    </>
  );

  // MODE 1: Landing Page (No ID)
  if (!activeId && messages.length === 0) {
    const canSend = (inputText.trim() || pendingFiles.some(f => f.status === 'done')) && !loading && !pendingFiles.some(f => f.status === 'uploading');
    const promptTabs = LANDING_PROMPT_SECTIONS;
    const activePromptSection = promptTabs.find((tab) => tab.label === activeLandingPromptSection) ?? null;

    return (
      <div className={`flex-1 bg-claude-bg h-full flex flex-col relative overflow-hidden text-claude-text chat-font-scope ${showEntranceAnimation ? 'animate-slide-in' : ''}`}>
        {/* 移动端横向内距收到 8px：配合整体 zoom 后 px-4 会让两侧各空 37px，输入框只剩 315/390 */}
        <div className="flex-1 flex flex-col items-center pt-[64px] md:pt-[179px] px-2 md:px-0 overflow-y-auto">
          <div className="flex w-full max-w-[672px] flex-col items-center">
            <div className="mb-[20px] md:mb-[28px] flex min-h-[60px] md:h-[60px] w-full max-w-[672px] items-center justify-center gap-[12px]">
              <div className="flex h-[32px] w-[32px] items-center justify-center shrink-0">
                <IconCoworkSparkle size={32} className="text-claude-accent" />
              </div>
              <h1
                className="text-center md:whitespace-nowrap text-[#373734] dark:!text-[#d6cec3]"
                style={{
                  fontFamily: '"Anthropic Serif", "Source Serif 4", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
                  fontStyle: 'normal',
                  fontWeight: 400,
                  // 字号随视口连续变化：320px→21px，768px 及以上→40px（桌面原值）
                  fontSize: 'clamp(19px, 4.8vw, 40px)',
                  lineHeight: 1.32,
                }}
              >
                {welcomeGreeting}
              </h1>
            </div>

            <div className="relative w-full max-w-[672px] group">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                accept={ACCEPTED_TYPES}
                onChange={(e) => {
                  if (e.target.files) handleFilesSelected(e.target.files);
                  e.target.value = '';
                }}
              />
              <div
                className={`w-full max-w-[672px] border transition-all duration-200 flex flex-col max-h-[60vh] font-sans bg-white dark:bg-claude-input ${isDragging ? 'border-[#D97757] bg-orange-50/30 dark:bg-orange-900/20' : 'border-transparent'} focus-within:border-[#d9d7d0] dark:focus-within:border-claude-border`}
                style={{
                  borderRadius: '20px',
                  boxShadow: '0px 4px 20px rgba(0, 0, 0, 0.04), 0px 0px 0px rgba(31, 31, 30, 0.15)',
                }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="flex flex-col px-[15px] py-[15px]">
                  <div className="flex-1 min-h-0 overflow-visible">
                    <FileUploadPreview files={pendingFiles} onRemove={handleRemoveFile} />
                    <div className="relative min-h-[48px]">
                      {filteredSlashSuggestions.length > 0 && (
                        <SlashCommandMenu
                          suggestions={filteredSlashSuggestions}
                          hiddenSkills={hiddenSkillCount}
                          activeIndex={slashIndex}
                          onSelect={selectSlashSuggestion}
                          onHover={setSlashIndex}
                        />
                      )}
                      <SkillInputOverlay
                        text={inputText}
                        subcommands={slashSubcommands}
                        className="pl-[6px] pr-0 pt-[4px] pb-0 text-[16px] leading-[24px] font-sans font-normal tracking-[-0.3125px] overflow-hidden"
                        style={{ minHeight: '48px' }}
                      />
                      <textarea
                        ref={inputRef}
                        className={`w-full pl-[6px] pr-0 pt-[4px] pb-0 placeholder:text-[#7b7974] dark:placeholder:text-claude-textSecondary text-[16px] leading-[24px] tracking-[-0.3125px] outline-none resize-none overflow-hidden bg-transparent font-sans font-normal ${inputText.match(/^\/[a-zA-Z0-9_-]+/) ? 'text-transparent caret-claude-text' : 'text-[#373734] dark:text-claude-text'}`}
                        style={{ minHeight: '48px' }}
                        placeholder={selectedSkill ? `告诉 ${selectedSkill.name} 你想做什么…` : "今天需要什么帮助？"}
                        value={inputText}
                        onChange={(e) => {
                          setInputText(e.target.value);
                          setSlashIndex(0);
                          e.target.style.height = 'auto';
                          e.target.style.height = Math.min(e.target.scrollHeight, 300) + 'px';
                          e.target.style.overflowY = e.target.scrollHeight > 300 ? 'auto' : 'hidden';
                        }}
                        onKeyDown={(e) => {
                          // Backspace deletes entire /skill-name as a unit
                          if (e.key === 'Backspace' && selectedSkill) {
                            const pos = (e.target as HTMLTextAreaElement).selectionStart;
                            const skillPrefix = `/${selectedSkill.slug} `;
                            if (pos > 0 && pos <= skillPrefix.length && inputText.startsWith(skillPrefix.slice(0, pos))) {
                              e.preventDefault();
                              setInputText(inputText.slice(skillPrefix.length));
                              setSelectedSkill(null);
                              return;
                            }
                          }
                          // Enter is intentionally left untouched so textarea inserts a newline.
                        }}
                        onPaste={handlePaste}
                      />
                    </div>
                  </div>
                  <div className="mt-[12px] flex h-[32px] items-center justify-between">
                    <div className="relative flex items-center">
                      <button
                        ref={plusBtnRef}
                        onClick={() => setShowPlusMenu(prev => !prev)}
                        className="flex h-[32px] w-[34px] items-center justify-center rounded-[8px] transition-colors hover:bg-[#f5f4f1] dark:hover:bg-white/5"
                      >
                        <img src={inputPlusIcon} alt="" aria-hidden="true" className="h-[20px] w-[20px] dark:invert dark:brightness-200" />
                      </button>
                      {showPlusMenu && renderSharedPlusMenu(landingPlusMenuShellClass, landingPlusMenuSubmenuClass)}
                      {/* Blue research badge next to + button when enabled */}
                      {researchMode && (
                        <div className="group/research relative ml-1 flex items-center bg-[#DBEAFE] dark:bg-[#1E3A5F] rounded-lg p-1.5">
                          <IconResearch size={16} className="text-[#2E7CF6] flex-shrink-0" />
                          <span className="inline-flex items-center overflow-hidden w-0 group-hover/research:w-[18px] transition-[width] duration-150 ease-out">
                            <button
                              onClick={toggleResearchMode}
                              className="ml-1 flex-shrink-0 flex items-center justify-center hover:opacity-70 transition-opacity"
                              aria-label="禁用研究模式"
                            >
                              <X size={14} className="text-[#2E7CF6]" />
                            </button>
                          </span>
                          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 bg-[#2a2a2a] text-white dark:bg-[#e8e8e8] dark:text-[#1a1a1a] rounded-md text-[11px] whitespace-nowrap opacity-0 group-hover/research:opacity-100 pointer-events-none transition-opacity">
                            研究模式
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-[8px]">
                      <ModelSelector
                        currentModelString={currentModelString}
                        models={selectorModels}
                        onModelChange={handleModelChange}
                        isNewChat={true}
                        variant="landing"
                        caretIconSrc={modelCaretIcon}
                        thinkingEnabled={thinkingEnabled}
                        onThinkingChange={handleThinkingChange}
                        thinkingEffort={thinkingEffort}
                        onThinkingEffortChange={handleThinkingEffortChange}
                      />
                      {canSend && !isVoiceListening ? (
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { void handleSend(); }}
                          disabled={!canSend}
                          className={landingSendButtonClass}
                        >
                          <ArrowUp size={18} strokeWidth={2.3} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={isVoiceListening ? '停止语音输入' : '使用语音模式'}
                          aria-pressed={isVoiceListening}
                          onClick={handleVoiceDictationToggle}
                          className={`group relative flex h-[32px] w-[36px] items-center justify-center rounded-[8px] transition-all duration-200 ${isVoiceListening ? 'bg-[#f4e3dc] shadow-[inset_0_0_0_1px_rgba(198,97,63,0.08)]' : 'hover:-translate-y-[1px] hover:bg-[#f5f4f1] dark:hover:bg-white/5'}`}
                        >
                          {isVoiceListening && (
                            <span className="absolute inset-0 rounded-[8px] bg-[#f7d9ce] opacity-60 animate-pulse" aria-hidden="true" />
                          )}
                          <IconVoice size={20} className="relative text-[#121212] dark:text-claude-text" active={isVoiceListening} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {activePromptSection && (
              <div className="mt-[12px] w-full max-w-[672px] overflow-hidden rounded-[16px] border border-[rgba(31,31,30,0.15)] dark:border-claude-border bg-white dark:bg-claude-input shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
                <div className="flex items-center justify-between px-[16px] py-[12px]">
                  <div className="flex items-center gap-[8px]">
                    <img src={activePromptSection.icon} alt="" aria-hidden="true" className="h-[20px] w-[18px] shrink-0 dark:invert dark:brightness-200" />
                    <span className="text-[14px] leading-[19.6px] tracking-[-0.1504px] text-[#605E5A] dark:text-claude-textSecondary">
                      {activePromptSection.label}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveLandingPromptSection(null)}
                    className="flex h-[20px] w-[20px] items-center justify-center rounded-full text-[#7B7974] dark:text-claude-textSecondary transition-colors hover:bg-[#f5f4f1] dark:hover:bg-white/5 hover:text-[#373734] dark:hover:text-claude-text"
                    aria-label={`Close ${activePromptSection.label} suggestions`}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="border-t border-[rgba(31,31,30,0.12)] dark:border-white/10" />
                <div className="flex flex-col">
                  {activePromptSection.items.map((item, index) => (
                    <button
                      key={item.artifact_id}
                      type="button"
                      onClick={() => {
                        setActiveLandingPromptSection(null);
                        setInputText(item.starting_prompt);
                        requestAnimationFrame(() => {
                          resizeLandingInput();
                          inputRef.current?.focus();
                        });
                      }}
                      className={`flex min-h-[44px] items-center px-[16px] py-[10px] text-left transition-colors hover:bg-[#f8f7f4] dark:hover:bg-white/5 ${index < activePromptSection.items.length - 1 ? 'border-b border-[rgba(31,31,30,0.12)] dark:border-white/10' : ''}`}
                    >
                      <span className="text-[14px] leading-[19.6px] tracking-[-0.1504px] text-[#373734] dark:text-claude-text">
                        {localizeInspiration(item).description || localizeInspiration(item).name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 移动端：5 个标签总宽超出可用宽度，改横向滚动并左对齐；桌面端保持居中 */}
            <div className="landing-prompt-tabs mt-[16px] flex h-[32px] w-full items-center justify-start md:justify-center gap-[8px] overflow-x-auto md:overflow-visible">
              {promptTabs.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  onClick={() => setActiveLandingPromptSection((prev) => prev === tab.label ? null : tab.label)}
                  className={`group flex h-[32px] items-center gap-[6px] overflow-hidden rounded-[8px] border px-[10px] text-[#373734] dark:text-claude-text transition-all duration-200 hover:-translate-y-[1px] ${activeLandingPromptSection === tab.label ? 'bg-white dark:bg-claude-input border-[rgba(31,31,30,0.25)] dark:border-white/20 shadow-[0_4px_12px_rgba(0,0,0,0.06)]' : 'bg-[#f8f8f6] dark:bg-claude-bg border-[rgba(31,31,30,0.15)] dark:border-white/10 hover:bg-[#f3f2ee] dark:hover:bg-claude-hover'}`}
                  style={{
                    width: `${tab.width}px`,
                  }}
                >
                  <img src={tab.icon} alt="" aria-hidden="true" className="h-5 w-[18px] shrink-0 transition-transform duration-200 group-hover:-translate-y-[1px] dark:invert dark:brightness-150" />
                  <span className="truncate text-[14px] font-normal leading-[19.6px] tracking-[-0.1504px]">
                    {tab.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <AddFromGithubModal
          isOpen={showGithubModal}
          onClose={() => setShowGithubModal(false)}
          currentContextTokens={contextInfo?.tokens || 0}
          contextLimit={contextInfo?.limit || 200000}
          onConfirm={handleGithubAdd}
        />
        {sharedProjectOverlays}
        {/* 向导弹窗 —— 复用 CLI 的向导定义（core/wizard-steps.mjs）。
            MODE 1（新对话 / landing）也要渲染：用户在这里敲
            /config provider add 一样要能弹出表单。
            原来只加在 MODE 2，导致新会话里敲命令毫无反应。 */}
        <WizardDialog
          isOpen={!!wizard}
          wizardId={wizard?.id || ''}
          title={wizard?.title || ''}
          steps={wizard?.steps || []}
          onClose={() => setWizard(null)}
          onDone={message => {
            window.dispatchEvent(new CustomEvent('webModelsChanged'));
            setWizard(null);
            if (message) {
              setMessagesFor(activeId!, prev => [
                ...prev,
                { id: `wizard-${Date.now()}`, role: 'assistant', content: message } as any,
              ]);
            }
          }}
        />
      </div>
    );
  }

  // MODE 2: Chat Interface (Has ID or Messages)
  return (
    <div className="flex-1 bg-claude-bg h-full flex flex-col overflow-clip text-claude-text chat-root chat-font-scope">
      {/* Content area - positioning container for scroll + bottom bars
          【2026-10-06 看板定稿】改为 flex-col：第一项是常驻 TodoPanel 条，
          滚动区从 absolute inset-0 改成 flex-1 —— 看板占的高度由滚动区让出，
          既常驻又不遮挡（浮层方案盖正文、进文档流方案不常驻，都不行）。 */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <TodoPanel todos={todoItems} running={loading} />
        <div
          className="flex-1 min-h-0 overflow-y-auto chat-scroll"
          style={{ paddingBottom: `${inputHeight}px` }}
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          <div
            className="w-full mx-auto px-4 py-8 pb-2"
            style={{ maxWidth: `${tunerConfig?.mainContentWidth || 768}px` }}
          >
            <MessageList
              messages={messages}
              loading={loading}
              currentModelString={currentModelString}
              expandedMessages={expandedMessages}
              editingMessageIdx={editingMessageIdx}
              editingContent={editingContent}
              copiedMessageIdx={copiedMessageIdx}
              compactStatus={compactStatus}
              onSetEditingContent={setEditingContent}
              onEditCancel={handleEditCancel}
              onEditSave={handleEditSave}
              onToggleExpand={toggleMessageExpand}
              onResend={handleResendMessage}
              onEdit={handleEditMessage}
              onCopy={handleCopyMessage}
              onOpenDocument={onOpenDocument}
              onSetMessages={setMessages}
              messageContentRefs={messageContentRefs}
              onOpenResearch={setOpenedResearchMsgId}
            />
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* 底部状态行：与 CLI 状态行同口径（轮 / 首token平均 / tok/s / LLM / 工具）。
            原来这里写死一句「Claude 是 AI，可能会出错」—— 对用户没有信息量，
            换成真实的运行指标。无数据时保留免责声明作为兜底。 */}
        <div className="absolute bottom-0 left-0 z-10 bg-claude-bg flex items-center justify-center text-[11px] text-claude-textSecondary h-7 pointer-events-none font-sans gap-2 overflow-hidden whitespace-nowrap" style={{ right: `${scrollbarWidth}px` }}>
          {runMetrics && (runMetrics.turns || runMetrics.tps != null || runMetrics.avgFirstTokenMs != null) ? (
            <span className="flex items-center gap-2">
              {runMetrics.turns > 0 && <span>{runMetrics.turns} 轮</span>}
              {runMetrics.avgFirstTokenMs != null && <span>平均首字 {runMetrics.avgFirstTokenMs >= 1000 ? `${(runMetrics.avgFirstTokenMs / 1000).toFixed(1)}s` : `${runMetrics.avgFirstTokenMs}ms`}</span>}
              {runMetrics.tps != null && <span>平均吞吐 {runMetrics.tps} tok/s</span>}
            </span>
          ) : (
            <span>Claude 是 AI，可能会出错。请核对回复内容。</span>
          )}
        </div>

        {/* 【2026-10-10 加】「回到底部」按钮 —— 对齐 APK 的同款功能。
            用户上翻阅读历史时出现，点击回到最新消息并恢复自动跟随。
            位置：输入框上方居中（与 APK 的 BottomCenter 对齐）。
            样式：accent 实底 + 反色文字（对比度拉满，对齐 APK 2026-10-07 的改进）。 */}
        {showScrollButton && (
          <div
            className="absolute left-0 right-0 z-30 pointer-events-none flex justify-center"
            style={{ bottom: `${inputBarBottom + 96}px` }}
          >
            <button
              onClick={handleScrollToBottomClick}
              className="pointer-events-auto flex items-center justify-center w-9 h-9 rounded-full bg-[#D97757] text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)] hover:bg-[#c96a4d] active:scale-95 transition-all"
              title="回到底部"
              aria-label="回到底部"
            >
              <ChevronDown size={18} />
            </button>
          </div>
        )}

        {/* 输入框 - 浮动在内容上方，底部距离可调 */}
        <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ bottom: `${inputBarBottom + 28}px`, paddingLeft: '16px', paddingRight: `${16 + scrollbarWidth}px` }}>
          <div
            className="mx-auto pointer-events-auto"
            style={{ maxWidth: `${inputBarWidth}px` }}
          >
            <div className="w-full relative group" ref={inputWrapperRef}>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                accept={ACCEPTED_TYPES}
                onChange={(e) => {
                  if (e.target.files) handleFilesSelected(e.target.files);
                  e.target.value = '';
                }}
              />
              <div
                className={`bg-claude-input border shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] hover:border-[#CCC] dark:hover:border-[#5a5a58] focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.08)] focus-within:border-[#CCC] dark:focus-within:border-[#5a5a58] transition-all duration-200 flex flex-col font-sans ${isDragging ? 'border-[#D97757] bg-orange-50/30' : 'border-claude-border dark:border-[#3a3a38]'}`}
                style={{ borderRadius: `${inputBarRadius}px` }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileUploadPreview files={pendingFiles} onRemove={handleRemoveFile} />
                <div className="relative">
                  {filteredSlashSuggestions.length > 0 && (
                    <SlashCommandMenu
                      suggestions={filteredSlashSuggestions}
                          hiddenSkills={hiddenSkillCount}
                      activeIndex={slashIndex}
                      onSelect={selectSlashSuggestion}
                      onHover={setSlashIndex}
                    />
                  )}
                  <SkillInputOverlay
                    text={inputText}
                    subcommands={slashSubcommands}
                    className="px-4 pt-4 pb-0 text-[16px] font-sans font-[350]"
                    style={{ height: `${inputBarBaseHeight}px`, minHeight: '16px', boxSizing: 'border-box', overflow: 'hidden' }}
                  />
                  <textarea
                    ref={inputRef}
                    className={`w-full px-4 pt-4 pb-0 placeholder:text-claude-textSecondary text-[16px] outline-none resize-none bg-transparent font-sans font-[350] ${inputText.match(/^\/[a-zA-Z0-9_-]+/) ? 'text-transparent caret-claude-text' : 'text-claude-text'}`}
                    style={{ height: `${inputBarBaseHeight}px`, minHeight: '16px', boxSizing: 'border-box', overflowY: 'hidden' }}
                    placeholder={selectedSkill ? `告诉 ${selectedSkill.name} 你想做什么…` : "今天需要什么帮助？"}
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      setSlashIndex(0);
                      adjustTextareaHeight();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Backspace' && selectedSkill) {
                        const pos = (e.target as HTMLTextAreaElement).selectionStart;
                        const skillPrefix = `/${selectedSkill.slug} `;
                        if (pos > 0 && pos <= skillPrefix.length && inputText.startsWith(skillPrefix.slice(0, pos))) {
                          e.preventDefault();
                          setInputText(inputText.slice(skillPrefix.length));
                          setSelectedSkill(null);
                          return;
                        }
                      }
                      handleKeyDown(e);
                    }}
                    onPaste={handlePaste}
                  />
                </div>
                <div className="px-4 pb-3 pt-1 flex items-center justify-between">
                  <div className="relative flex items-center">
                    <button
                      ref={plusBtnRef}
                      onClick={() => setShowPlusMenu(prev => !prev)}
                      className="p-2 text-claude-textSecondary hover:text-claude-text hover:bg-claude-hover rounded-lg transition-colors"
                    >
                      <IconPlus size={20} />
                    </button>
                    {showPlusMenu && renderSharedPlusMenu(conversationPlusMenuShellClass, conversationPlusMenuSubmenuClass)}
                    {/* Blue research badge next to + button when enabled */}
                    {researchMode && (
                      <div className="group/research relative ml-1 flex items-center bg-[#DBEAFE] dark:bg-[#1E3A5F] rounded-lg p-1.5">
                        <IconResearch size={16} className="text-[#2E7CF6] flex-shrink-0" />
                        <span className="inline-flex items-center overflow-hidden w-0 group-hover/research:w-[18px] transition-[width] duration-150 ease-out">
                          <button
                            onClick={toggleResearchMode}
                            className="ml-1 flex-shrink-0 flex items-center justify-center hover:opacity-70 transition-opacity"
                            aria-label="禁用研究模式"
                          >
                            <X size={14} className="text-[#2E7CF6]" />
                          </button>
                        </span>
                        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 bg-[#2a2a2a] text-white dark:bg-[#e8e8e8] dark:text-[#1a1a1a] rounded-md text-[11px] whitespace-nowrap opacity-0 group-hover/research:opacity-100 pointer-events-none transition-opacity">
                          研究模式
                        </div>
                      </div>
                    )}
                    {contextInfo && contextInfo.tokens > 0 && (() => {
                      const pct = Math.min(contextInfo.tokens / contextInfo.limit, 1);
                      const color = pct > 0.8 ? '#dc2626' : pct > 0.5 ? '#d97706' : '#6b7280';
                      const r = 7, c = 2 * Math.PI * r, dash = pct * c;
                      const label = contextInfo.tokens.toLocaleString() + ' tokens';
                      const pctLabel = (pct * 100).toFixed(1) + '% 上下文已使用';
                      return (
                        <div className="flex items-center gap-1 ml-1 select-none" title={pctLabel}>
                          <svg width="18" height="18" viewBox="0 0 18 18">
                            <circle cx="9" cy="9" r={r} fill="none" stroke="#d4d4d4" strokeWidth="2" />
                            <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2"
                              strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
                              transform="rotate(-90 9 9)" />
                          </svg>
                          <span className="text-[11px] whitespace-nowrap" style={{ color: '#6b7280' }}>{label}</span>
                        </div>
                      );
                    })()}
                  </div>
                  {/* min-w-0：允许这行压缩，否则模型选择器会把发送按钮顶出去 */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                    <ModelSelector
                      currentModelString={currentModelString}
                      models={selectorModels}
                      onModelChange={handleModelChange}
                      isNewChat={false}
                      dropdownPosition="top"
                      thinkingEnabled={thinkingEnabled}
                      onThinkingChange={handleThinkingChange}
                      thinkingEffort={thinkingEffort}
                      onThinkingEffortChange={handleThinkingEffortChange}
                    />
                    </div>
                    {loading ? (
                      <button
                        onClick={handleStop}
                        className="p-2 text-claude-text hover:bg-claude-hover rounded-lg transition-colors"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { void handleSend(); }}
                        disabled={(!inputText.trim() && !pendingFiles.some(f => f.status === 'done')) || pendingFiles.some(f => f.status === 'uploading')}
                        className={`${conversationSendButtonClass} shrink-0`}
                      >
                        <ArrowUp size={22} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {false && (
                <div className="mx-4 flex items-center justify-between px-4 py-1.5 bg-claude-bgSecondary border-x border-b border-claude-border rounded-b-xl text-claude-textSecondary text-xs pointer-events-auto">
                  <span>您当前没有可用套餐，无法发送消息</span>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('open-upgrade'))}
                    className="px-2 py-0.5 bg-claude-btnHover hover:bg-claude-hover text-claude-text text-xs font-medium rounded transition-colors border border-claude-border hover:border-blue-500 hover:text-blue-600"
                  >
                    购买套餐
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Plan / Deep 模式横幅 */}
      {(planMode || deepMode) && (
        <div className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 pointer-events-none" style={{ paddingLeft: 'var(--sidebar-width, 260px)' }}>
          {planMode && (
            <div className="mt-2 px-4 py-1.5 bg-amber-500/90 text-white text-[13px] font-medium rounded-full shadow-lg pointer-events-auto flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              计划模式 — 先给方案，不执行
            </div>
          )}
          {deepMode && (
            <div className="mt-2 px-4 py-1.5 bg-indigo-500/90 text-white text-[13px] font-medium rounded-full shadow-lg pointer-events-auto flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20"/><path d="M5 7l7-5 7 5"/><path d="M5 17l7 5 7-5"/></svg>
              深度模式 — 长任务多轮执行
            </div>
          )}
        </div>
      )}

      {/* 中断残局提示：上一轮没跑完（进程重启/断连）。给一条明路而不是静默装正常 */}
      {interruptedInfo?.detected && !loading && (
        <div className="mx-auto max-w-[720px] px-4 pt-3">
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-claude-text">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-amber-500"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
            <span className="flex-1">上一轮任务似乎被打断了（{interruptedInfo.reason}）。</span>
            <button
              onClick={() => { setInterruptedInfo(null); handleSend('继续'); }}
              className="rounded-md bg-amber-500/90 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-amber-500"
            >继续</button>
            <button
              onClick={() => setInterruptedInfo(null)}
              className="rounded-md px-2 py-1 text-[12px] text-claude-textSecondary hover:bg-claude-hover"
            >忽略</button>
          </div>
        </div>
      )}

      {/* 目标契约横幅：goal 是跨轮推进的，用户必须随时能看到「目标是什么、跑了几轮」 */}
      {goalInfo && goalInfo.status === 'active' && (
        <div className="fixed top-0 left-0 right-0 z-[99] flex items-center justify-center pointer-events-none" style={{ paddingLeft: 'var(--sidebar-width, 260px)' }}>
          <div className="mt-12 px-4 py-1.5 bg-claude-input/95 border border-claude-border text-claude-text text-[12px] rounded-full shadow-lg pointer-events-auto flex items-center gap-2 max-w-[70vw]">
            <span className="text-[#C6613F] font-semibold flex-shrink-0">◎ 目标</span>
            <span className="truncate">{goalInfo.objective}</span>
            <span className="text-claude-textSecondary flex-shrink-0">{goalInfo.turnsUsed}{goalInfo.turnBudget ? `/${goalInfo.turnBudget}` : ''} 轮</span>
          </div>
        </div>
      )}


      {/* Active tasks progress */}
      {activeTasks.size > 0 && (
        <div className="fixed bottom-[140px] right-6 z-[90] flex flex-col gap-1.5 max-w-[320px]">
          {Array.from(activeTasks.entries()).map(([taskId, task]) => (
            <div key={taskId} className="bg-claude-bg border border-claude-border rounded-lg px-3 py-2 shadow-lg flex items-center gap-2 text-[12px] text-claude-textSecondary animate-pulse">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin flex-shrink-0"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              <span className="truncate">{task.last_tool_name ? `${task.description} (${task.last_tool_name})` : task.description}</span>
            </div>
          ))}
        </div>
      )}

      {/* AskUserQuestion dialog */}
      {askUserDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40">
          <div className="bg-claude-bg border border-claude-border rounded-2xl shadow-xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-semibold text-claude-text mb-1 flex items-center gap-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                需要你的输入
              </h3>
            </div>
            <div className="px-5 pb-4 flex flex-col gap-4">
              {askUserDialog.questions.map((q, qi) => (
                <div key={qi} className="flex flex-col gap-1.5">
                  <label className="text-[13px] font-medium text-claude-text">{q.question}</label>
                  {/* 【2026-10-06 改：选项与输入框**并存**】
                      原来是二选一（有选项就不给输入框）—— 用户只能从
                      Agent 给的选项里挑，想补充说明或都不满意时无处可写。
                      现在选项按钮照常点选（点了就填进输入框），
                      输入框始终存在，可自由改写/补充。
                      options 兼容两种形态：字符串数组（工具侧传的）与
                      {label,description} 对象数组（老格式）。 */}
                  {q.options && q.options.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {q.options.map((opt, oi) => {
                        const label = typeof opt === 'string' ? opt : opt.label;
                        const desc = typeof opt === 'string' ? '' : (opt.description || '');
                        const selected = askUserDialog.answers[q.question] === label;
                        return (
                          <button
                            key={oi}
                            onClick={() => setAskUserDialog(prev => prev ? { ...prev, answers: { ...prev.answers, [q.question]: label } } : null)}
                            className={`text-left px-3 py-2 rounded-lg border text-[13px] transition-colors ${selected ? 'border-[#C6613F] bg-[#C6613F]/10 text-claude-text' : 'border-claude-border hover:bg-claude-hover text-claude-textSecondary'}`}
                          >
                            <div className="font-medium text-claude-text">{label}</div>
                            {desc && <div className="text-[12px] text-claude-textSecondary mt-0.5">{desc}</div>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <input
                    type="text"
                    className="w-full bg-claude-input border border-claude-border rounded-lg px-3 py-2 text-[13px] text-claude-text outline-none focus:border-claude-textSecondary/40 transition-colors"
                    placeholder={q.options && q.options.length > 0 ? '或直接输入你的回答…' : '输入你的回答…'}
                    value={askUserDialog.answers[q.question] || ''}
                    onChange={e => setAskUserDialog(prev => prev ? { ...prev, answers: { ...prev.answers, [q.question]: e.target.value } } : null)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        document.getElementById('ask-user-submit-btn')?.click();
                      }
                    }}
                    autoFocus={qi === 0}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 pb-4">
              <button
                id="ask-user-submit-btn"
                onClick={async () => {
                  if (!askUserDialog || !activeId) return;
                  const { request_id, tool_use_id, answers } = askUserDialog;
                  setAskUserDialog(null);
                  try {
                    await answerWebQuestion(activeId, request_id, answers);
                  } catch (err) {
                    console.error('Failed to send answer:', err);
                  }
                }}
                className="px-4 py-1.5 text-[13px] text-white bg-[#C6613F] hover:bg-[#D97757] rounded-lg transition-colors font-medium"
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}

      <AddFromGithubModal
        isOpen={showGithubModal}
        onClose={() => setShowGithubModal(false)}
        currentContextTokens={contextInfo?.tokens || 0}
        contextLimit={contextInfo?.limit || 200000}
        // 【2026-09-19 修】原来这里自己写了一段处理，读 `bundle.file` ——
        // 但 GithubAddPayload 没有 file 字段（它是 {repoFullName, ref, selections}），
        // 所以 `if (!bundle.file) return` 一进来就退出，「从 GitHub 添加」整条流程是空转的：
        // 用户选完文件点确认，弹窗关掉了，但什么都没发生。
        // 正确入口是 handleGithubAdd（用 payload.selections + materializeGithub 落文件 + 生成卡片）。
        onConfirm={handleGithubAdd}
      />

      {/* 选择列表弹窗 —— CLI 的 runSelect 在 Web 的对应物。
          命令返回 kind:'select' 时打开（/model 无参拉模型列表）。
          点选后 POST /api/command-select，服务端拼成等价的带参命令重新执行 ——
          复用 CLI 那条落盘路径，配置结构两端必然一致。 */}
      <SelectDialog
        request={selectReq}
        onClose={() => setSelectReq(null)}
        onPick={async (value, req) => {
          // 路径必须是 /api/sessions/<id>/command-select ——
          // 服务端路由白名单在 web/server.mjs 的
          //   /^\/api\/sessions\/([a-f0-9-]+)(?:\/(events|messages|...))?$/
          // 里，端点定义在 sessions 分支内部。写成顶层 /api/command-select 会 404
          // （实测前端会显示「Not found」）。
          const res = await fetch(`/api/sessions/${activeId}/command-select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: req.action || 'rerun',
              meta: req.meta || {},
              value,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error || `选择失败（HTTP ${res.status}）`);
          }
          setSelectReq(null);
          // 选完可能改了模型/Provider，通知下拉框刷新
          window.dispatchEvent(new CustomEvent('webModelsChanged'));
        }}
      />

      {/* 向导弹窗 —— 复用 CLI 的向导定义（core/wizard-steps.mjs）。
          命令返回 kind:'wizard' 时打开，提交走 /api/wizards/<id>。 */}
      <WizardDialog
        isOpen={!!wizard}
        wizardId={wizard?.id || ''}
        title={wizard?.title || ''}
        steps={wizard?.steps || []}
        onClose={() => setWizard(null)}
        onDone={message => {
          // 向导落盘后可能新增/改了 Provider，通知模型下拉框刷新
          window.dispatchEvent(new CustomEvent('webModelsChanged'));
          setWizard(null);
          if (message) {
            setMessagesFor(activeId!, prev => [
              ...prev,
              { id: `wizard-${Date.now()}`, role: 'assistant', content: message } as any,
            ]);
          }
        }}
      />

      {/* Clawparrot login-required modal: shown when a non-logged-in clawparrot
          user tries to send their first message. Lets them go to login page or
          switch to self-hosted mode in settings. */}
      {showLoginRequired && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-claude-input border border-claude-border rounded-2xl shadow-xl w-[460px] overflow-hidden">
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-[16px] font-semibold text-claude-text mb-3">需要登录 Clawparrot 账号</h3>
              <p className="text-[14px] text-claude-textSecondary leading-relaxed">
                你当前在 <span className="text-claude-text font-medium">Clawparrot</span> 模式下，需要登录 <span className="font-mono text-claude-text">clawparrot.com</span> 账号才能使用。
                <br /><br />
                如果你还没有账号，请先去 <span className="font-mono text-claude-text">clawparrot.com</span> 注册一个。
                <br /><br />
                或者你也可以在设置的 General 页面切换到 <span className="text-claude-text font-medium">自部署</span> 模式，用你自己的 API Key。
              </p>
            </div>
            <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
              <button
                onClick={() => {
                  pendingLoginSendRef.current = null;
                  setShowLoginRequired(false);
                  navigate('/login');
                }}
                className="w-full px-5 py-2.5 text-[14px] font-medium bg-claude-text text-claude-bg hover:opacity-90 rounded-lg transition-opacity"
              >
                去登录
              </button>
              <button
                onClick={() => {
                  pendingLoginSendRef.current = null;
                  setShowLoginRequired(false);
                }}
                className="w-full px-5 py-1.5 text-[12px] text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Compact conversation dialog */}
      {showCompactDialog && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={() => setShowCompactDialog(false)}>
          <div className="bg-claude-bg border border-claude-border rounded-2xl shadow-xl w-[440px] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-semibold text-claude-text mb-1">Compact conversation</h3>
              <p className="text-[13px] text-claude-textSecondary leading-snug">
                Summarize the conversation history to free up context space. The engine will preserve key decisions and context.
              </p>
            </div>
            <div className="px-5 pb-3">
              <textarea
                className="w-full bg-claude-input border border-claude-border rounded-lg px-3 py-2 text-[13px] text-claude-text placeholder:text-claude-textSecondary/50 outline-none focus:border-claude-textSecondary/40 transition-colors resize-none"
                rows={3}
                placeholder="Optional: add instructions for the summary (e.g. 'preserve all API endpoint details')"
                value={compactInstruction}
                onChange={e => setCompactInstruction(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    document.getElementById('compact-confirm-btn')?.click();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 pb-4">
              <button
                onClick={() => setShowCompactDialog(false)}
                className="px-3.5 py-1.5 text-[13px] text-claude-textSecondary hover:text-claude-text rounded-lg hover:bg-claude-hover transition-colors"
              >
                Cancel
              </button>
              <button
                id="compact-confirm-btn"
                onClick={async () => {
                  setShowCompactDialog(false);
                  if (!activeId || compactStatus.state === 'compacting') return;
                  setCompactStatus({ state: 'compacting' });
                  try {
                    const instruction = compactInstruction.trim() || undefined;
                    const result = await compactConversation(activeId, instruction);
                    await loadConversation(activeId);
                    const newContextInfo = await getContextSize(activeId);
                    setContextInfo(newContextInfo);
                    setCompactStatus({ state: 'done', message: `Compacted ${result.messagesCompacted} messages, saved ~${result.tokensSaved} tokens` });
                    setTimeout(() => setCompactStatus({ state: 'idle' }), 4000);
                  } catch (err) {
                    console.error('Compact failed:', err);
                    setCompactStatus({ state: 'error', message: 'Compaction failed' });
                    setTimeout(() => setCompactStatus({ state: 'idle' }), 3000);
                  }
                }}
                className="px-3.5 py-1.5 text-[13px] text-white bg-[#C6613F] hover:bg-[#D97757] rounded-lg transition-colors font-medium"
              >
                Compact
              </button>
            </div>
          </div>
        </div>
      )}

      {sharedProjectOverlays}

      {/* Research panel — fixed right-side drawer */}
      {openedResearchMsgId && (() => {
        const liveMsg = messages.find(m => m.id === openedResearchMsgId);
        if (!liveMsg || !liveMsg.research) return null;
        return (
          <>
            <div
              className="fixed inset-0 z-[60] bg-black/20"
              onClick={() => setOpenedResearchMsgId(null)}
            />
            <div className="fixed top-0 right-0 bottom-0 w-[440px] z-[61] bg-claude-bg border-l border-claude-border shadow-2xl flex flex-col">
              <ResearchPanel research={liveMsg.research} onClose={() => setOpenedResearchMsgId(null)} />
            </div>
          </>
        );
      })()}
    </div>
  );
};

export default MainContent;
