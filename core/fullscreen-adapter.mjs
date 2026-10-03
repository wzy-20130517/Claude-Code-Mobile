// 全屏模式适配器：把 FullscreenRenderer 包装成 index.mjs 现有的输出接口。
// 目的是让 index.mjs 只在几个点上分叉，不改流式模式的任何行为。
//
// 全屏界面固定启用；FullscreenSession 负责初始化与清理 alternate screen。

import { FullscreenRenderer, wrapToWidth } from './fullscreen.mjs';
// 宽度/排版的单一权威实现。全屏输入区是**虚拟屏幕**，满行时需要真实
// 占一行来承载光标（否则光标会画到下边框上），所以传 reserveWrapRow:true；
// 裸 readline 直接对接真终端、依赖 deferred wrap，传 false。
import * as W from './width.mjs';
import { pickSpinnerVerb } from './spinner-verbs.mjs';
// 性能埋点用（见 refreshInput 里的统计）：卡死排查时写 render-slow.log
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 是否启用全屏。优先看环境变量（临时覆盖），再看 config.fullscreen（持久化）。
 * 必须支持 config：Restart 会新起进程，process.env 不继承。
 */
export function isFullscreenEnabled(config = null) {
  const v = process.env.CCM_FULLSCREEN;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  // 默认开启（用户 2026-08-22 指令）：只有显式写 fullscreen=false 才退回旧样式。
  return config?.fullscreen !== false;
}

export class FullscreenSession {
  constructor(options = {}) {
    this.renderer = new FullscreenRenderer({ out: options.out || process.stdout });
    this.readline = options.readline || null;
    this.welcomeLines = options.welcomeLines || [];
    this.statusLine = '';
    // 输入框上下边框的颜色（ANSI 前缀）。官方用 getBorderColor() 按模式变色
    // （普通/plan/bypass 等）；这里默认灰，由调用方按需覆盖。
    this.borderColor = options.borderColor ?? '\x1b[2m';
    this.todos = [];
    this.todoCompletionTimes = new Map(); // taskId -> timestamp
    // 性能优化：缓存计算结果，避免高频重复渲染
    this._cachedPanels = null;
    this._cacheInvalidated = true;
    // 活动看板：正在跑的 slash 命令 / 自主任务 / 子 Agent。
    // 三者同时存在时横向排成三栏，只有一两个时压缩成单行，省屏幕空间。
    this.activity = { command: null, auto: null, agents: [] };
    // 官方 Claude Code 的动态吉祥物：字形帧 + 动词消息。
    // SpinnerGlyph 官方帧是 6 个字符正向再反向，共 12 帧，120ms/帧。
    this.spinner = {
      active: false,
      startedAt: 0,
      lastProgressAt: 0,
      frame: 0,
      message: 'Thinking…',
      mode: 'thinking',
      reducedMotion: false,
      verbIndex: 0,
      // 括号里显示的真实动作（Reading / Writing / Running…），由 onToolUse 传入
      verbHint: null,
      // 本次 spinner 周期抽中的随机动词，停止时清空
      randomVerb: null,
    };
    this._spinnerTimer = null;
    // 实时块的「按时间刷新」回调。
    // 背景：Edit 类预览文案是「准备修改 X · 已传 NKB · Ns」，参数传完后
    // 就再没人调 render()，秒数冻在原地。让它搭 spinner 的 120ms 定时器搭车。
    this._liveTick = null;
    // 顶部欢迎页吉祥物动画（官方 AnimatedClawd.tsx）。
    // 官方靠鼠标点击触发，但 Termux 禁用了鼠标追踪（开了唤不起软键盘），
    // 所以改成：启动播一次、空闲随机播、每轮回答结束播一次。
    // 只替换 header 里那 3 行，帧间隔 60ms 与官方一致。
    this.clawd = {
      poseLines: options.clawdPoseLines || null,  // (pose) => string[3]
      rowIndex: Number.isInteger(options.clawdRowIndex) ? options.clawdRowIndex : -1,
      pose: 'default',
      frame: -1,        // -1 = 静止
      sequence: null,
      reducedMotion: false,
    };
    this._clawdTimer = null;
    this._clawdIdleTimer = null;
    // 看板折叠开关：两块可以独立收起，屏幕小的时候很有用。
    // 收起只影响显示，状态照常更新，展开后立刻看到最新值。
    this.collapsed = { todo: false, activity: false };
    this.commands = [];       // 可补全的 slash 命令（不含 /）
    this.commandDesc = {};    // 命令说明，显示在候选右侧
    this.commandArgHint = {}; // 参数格式提示（对齐官方 argumentHint），显示在命令名后
    this.active = false;
    // 【2026-09-22 移除】headerCollapsed（Ctrl+H 折叠）已删：
    // 欢迎页现在是滚动内容，会随正文滚走，不需要折叠。
    // 用户发过消息后，欢迎页不再显示（对标官方：Logo 只在会话开头出现）
    this.welcomeDismissed = false;
    // statusLine 防抖：避免 token/cost 高频更新导致无谓重绘
    this._statusLineDebounce = null;
    this._lastStatusText = '';
  }

  /** 进入全屏。welcomeLines 作为固定 header */
  start() {
    if (this.active) return;
    this.active = true;
    this._syncHeader();
    // 终端尺寸变化后（Termux 软键盘弹出/收起）重画输入区并把光标放回去，
    // 否则光标停在 render 最后写入的位置 = footer 底部那条边框上。
    this.renderer.onResized = () => { this.refreshInput(); };
    this.renderer.enter();
    this.refreshInput();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    // 必须清掉：否则退出全屏后定时器还会 fire，往已恢复的主屏写定位序列
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this._stopSpinnerTimer();
    this.spinner.active = false;
    if (this._clawdTimer) { clearTimeout(this._clawdTimer); this._clawdTimer = null; }
    this.stopClawdIdle();
    this.clawd.frame = -1;
    this.clawd.sequence = null;
    this.renderer.exit();
  }

  /**
   * 同步欢迎页到渲染器。
   *
   * 【2026-09-19 改：从固定 header 改为 body 前置块】
   * 官方（claude-code-main/components/Messages.tsx:678）把 Logo 放在**消息列表的第一个
   * 兄弟节点**里，随消息一起滚动 —— 发第一条消息就被正文推上去、滚出视野。
   * 我们原来放在 headerLines（固定顶部、body 高度要减掉它），所以欢迎页永远悬浮。
   * 用户明确要求对齐：「官方的欢迎页会随着正文被推上去消失不见，我们的一直悬浮在这里」。
   *
   * 现在它属于滚动内容，不占额外高度，正文多了自然顶出去。
   *
   * 【2026-09-22】原来的 headerCollapsed（Ctrl+H 折叠）已移除：
   * 欢迎页既然会随正文滚走，折叠就没意义了（那是悬浮版才需要的能力）。
   */
  _syncHeader() {
    // 欢迎页总是作为前置块参与滚动；发消息不收起，跟着正文往上滚。
    this.renderer.setBodyPrefix(this.welcomeLines);
  }

  /**
   * 【2026-09-20 改：不再"立即消失"，改为跟随正文滚动】
   *
   * 我第一版做的是「发消息 → 欢迎页立刻清掉」，用户反馈「还是没修好」——
   * 因为他要的是**官方那样**：欢迎页留在原位，跟着正文一起往上滚，
   * 正文超过一屏才自然被顶出视野（`bodyPrefix` 机制已经能做到这一点）。
   *
   * 这个函数现在**什么都不做**，保留它只为兼容调用点（index.mjs 的 processInput）。
   * 真正让欢迎页消失的是 `bodyPrefix` 随正文滚出可视区 —— 见 fullscreen.mjs 的
   * `_wrappedBody()`（prefix 拼在 bodyLines 前面）和 render 的 slice 逻辑。
   */
  dismissWelcome() {
    // 故意留空：让欢迎页跟着正文滚，而不是发消息就抹掉。
  }

  // ── 输出通道（对应流式模式的各个 write 路径）──────────
  /**
   * 正文流式输出。流式回复是一个 token 一次 write，每次都整帧 render 太重，
   * 所以只把内容写进 body，渲染合并到下一个 tick（16ms 内的连续写只画一次）。
   */
  write(text) {
    if (!this.active) { process.stdout.write(text); return; }
    this.renderer.appendBody(text);
  }

  /**
   * 光标是否已在行首。非全屏时无法探知裸 stdout 状态，返回 null 表示"不知道"，
   * 调用方按原有行为处理即可。
   */
  isAtLineStart() {
    if (!this.active) return null
    return this.renderer.isAtLineStart()
  }

  /** 实时块：固定高度的可替换视窗（流式写文件/命令输出用） */
  beginLiveBlock() {
    if (!this.active) return;
    this.renderer.beginLiveBlock();
  }

  /**
   * 就地改写某条正文行（工具行变色用：执行中灰 → 成功绿/失败红）。
   * 对齐官方 ToolUseLoader.tsx:20 的 `isUnresolved ? undefined : isError ? error : success`。
   *
   * ⚠ **必须立即 flush，不能只 _scheduleRender**：
   * `_scheduleRender` 用的是 `unref` 的 16ms 定时器，主循环回到 stdin 等待后
   * 不保证执行 —— 于是改行只改了内存里的 bodyLines，屏幕还是旧的。
   * 表现就是「工具行颜色不变、`Read…` 占位行一直挂着不消失」
   * （2026-10-03 用户反馈的老问题，根因在这里，不在 index.mjs 的行号计算）。
   * 工具结果渲染完就 flush 一次的开销可忽略（不是每 token 都调）。
   */
  updateBodyLine(idx, text, opts) {
    if (!this.active) return false;
    const ok = this.renderer.updateBodyLine(idx, text, opts);
    if (ok) {
      try { this.flushRender(); } catch {}
    }
    return ok;
  }

  /** 当前 body 逻辑行数（上层记「工具行在第几行」用） */
  bodyLineCount() {
    if (!this.active) return 0;
    return this.renderer.bodyLineCount();
  }

  /**
   * 用多行替换某行（工具结果写回工具行位置用）。
   * 同 updateBodyLine：必须立即 flush，不能只 _scheduleRender（unref 定时器不保证执行）。
   * @returns {number|null} 新增行数（可正可负）；失败 null
   */
  replaceBodyLines(idx, lines, opts) {
    if (!this.active) return null;
    const delta = this.renderer.replaceBodyLines(idx, lines, opts);
    if (delta !== null) {
      try { this.flushRender(); } catch {}
    }
    return delta;
  }

  updateLiveBlock(lines) {
    if (!this.active) return;
    // 【真实的「窗里写过内容」标记】
    // 不能靠 index 侧在 beginLiveBlock 旁边自己记：
    // renderer.updateLiveBlock 在无活动块时会【自己】调 beginLiveBlock
            // （fullscreen.mjs:171），绕过所有外部赋值点 —— 实测就是这么出现
    // used=false 但 open=true 的。写在这里才能盖住隐式开窗。
    this.liveBlockPainted = true;
    const wasScrolled = this.renderer.bodyScroll > 0;
    this.renderer.updateLiveBlock(lines);
    // 用户正在上翻历史时，refreshInput() 会重算五块 footer + 输入区并把光标强行
    // 放到底部，和手势滚动抢画面，表现为「一拉输入框整个画面就崩」。
    // 此时工具窗口只改 body，走轻量 render，保留用户正在看的位置；贴底时仍走
    // refreshInput，维持实时预览 + 输入光标的传统行为。
    if (wasScrolled || this.renderer.bodyScroll > 0) {
      this.renderer.render();
      if (this.readline) this._placeInputCursor();
    } else {
      this.refreshInput();
    }
  }

  endLiveBlock(opts) {
    if (!this.active) return;
    this.liveBlockPainted = false;
    this.renderer.endLiveBlock(opts);
    this.refreshInput();
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._renderTimer) return;
    // 合并 16ms 内的连续渲染请求，减少 CPU 占用
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      if (!this.active) return;
      try {
        this.refreshInput();   // 内部含 render，不要再单独调
      } catch (err) {
        console.error('[FullscreenSession] render error:', err.message);
      }
    }, 16);
    this._renderTimer.unref?.();
  }

  /** 立即渲染（等用户输入前必须刷干净，不能留在定时器里） */
  flushRender() {
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    // 同时应用挂起的状态行更新。
    // 注意：statusLine 的同步【不能】只在防抖挂起时做。setStatus 被去重 return 时
    // 防抖压根没开，但 statusLine 可能仍落后于 _lastStatusText（比如上一次 flush
    // 之后有过被去重的更新），只在挂起分支里赋值会漏掉这种情况。
    if (this._statusLineDebounce) {
      clearTimeout(this._statusLineDebounce);
      this._statusLineDebounce = null;
    }
    if (this.statusLine !== this._lastStatusText) {
      this.statusLine = this._lastStatusText;
    }
    if (!this.active) return;
    this.refreshInput();   // 内部含 render
  }

  /** 整行输出（工具结果、错误行等） */
  writeLine(line) {
    this.write(String(line).endsWith('\n') ? line : line + '\n');
  }

  /** 状态行（footer 最下方，显示 token/耗时/排队数）
   * 官方 StatusLine 防抖 300ms，避免高频更新
   */
  setStatus(text, force = false) {
    const next = String(text || '');
    // 【为什么需要 force】
    // 去重（next === _lastStatusText 就 return）本意是省渲染，但它会吃掉这种情况：
    // /compact 或 /config 切换后调 setStatus，此时内部统计（token 数、provider 名）
    // 可能还没算出新值，生成的字符串跟上次一模一样 → 这里直接 return，
    // 既不更新 _lastStatusText 也不开防抖，随后 flushRender 的挂起判断也不成立，
    // 结果状态条一直停在旧内容，直到下次恰好有别的变化才刷新
    // ——用户看到的就是「compact 完 / 切完 config，底部状态条老不更新」。
    // force=true 时跳过去重，强制走一遍渲染。
    if (!force && next === this._lastStatusText) return;
    this._lastStatusText = next;
    if (this._statusLineDebounce) clearTimeout(this._statusLineDebounce);
    this._statusLineDebounce = setTimeout(() => {
      this._statusLineDebounce = null;
      this.statusLine = next;
      if (this.active) this.refreshInput();
    }, 300);
  }

  /**
   * 待办常驻区：显示在输入框上方。全屏模式的好处之一就是这块不会被滚走。
   * todos: [{id, content, status}]，status = pending|in_progress|completed
   * 官方 TaskListV2：最近 30 秒完成的任务置顶高亮
   */
  setTodos(todos) {
    const now = Date.now();
    const next = Array.isArray(todos) ? todos : [];
    // 追踪刚完成的任务时间戳
    const prevCompleted = new Set(this.todos.filter(t => t.status === 'completed').map(t => t.id));
    for (const t of next) {
      if (t.status === 'completed' && !prevCompleted.has(t.id)) {
        this.todoCompletionTimes.set(t.id, now);
      }
    }
    // 清理已不存在的任务
    const currentIds = new Set(next.map(t => t.id));
    for (const id of this.todoCompletionTimes.keys()) {
      if (!currentIds.has(id)) this.todoCompletionTimes.delete(id);
    }
    this.todos = next;
    if (this.active) this.refreshInput();
  }

  /**
   * 更新官方风格的动态吉祥物。
   * mode: thinking | requesting | tool-use | responding
   * message: 稳定的动词文案，如 Thinking… / Reading…；不传则从动词池轮播
   * reducedMotion: 遵循用户的减少动态偏好，只保留缓慢明暗点。
   * 
   * 官方动词轮播：每 8 秒换一个动词（VERB_INTERVAL_MS）
   */
  setSpinner({ active = true, mode = 'thinking', message = null, reducedMotion = false, progress = false, verbHint = undefined } = {}) {
    const now = Date.now();
    // undefined = 不改动（沿用上次）；null = 显式清空
    if (verbHint !== undefined) this.spinner.verbHint = verbHint;
    // spinner 从「停」转「启」= 新的一轮，清掉上轮的随机词让它重抽。
    // 不清的话整个进程生命周期都是同一个词，失去趣味性。
    if (active && !this.spinner.active) this.spinner.randomVerb = null;
    let visualChanged = false;
    if (active) {
      if (!this.spinner.active) {
        this.spinner.startedAt = now;
        this.spinner.lastProgressAt = now;
        this.spinner.frame = 0;
        this.spinner.verbIndex = Math.floor(Math.random() * 1000); // 随机起点
        visualChanged = true;
      }
      const nextMode = String(mode || 'thinking');
      // message 为 null 时启用动词轮播（官方默认行为）
      const nextMessage = message !== null ? String(message) : null;
      const nextReducedMotion = !!reducedMotion;
      visualChanged ||= this.spinner.mode !== nextMode || this.spinner.message !== nextMessage || this.spinner.reducedMotion !== nextReducedMotion;
      this.spinner.active = true;
      this.spinner.mode = nextMode;
      this.spinner.message = nextMessage;
      this.spinner.reducedMotion = nextReducedMotion;
      if (progress) this.spinner.lastProgressAt = now;
      this._ensureSpinnerTimer();
    } else {
      visualChanged = this.spinner.active;
      this.spinner.active = false;
      this._stopSpinnerTimer();
    }
    // token 级 progress 只更新停滞检测时间戳，不每个 chunk 重画 footer。
    if (this.active && visualChanged) this.refreshInput();
  }

  // ── 顶部欢迎页吉祥物动画 ─────────────────────────────
  /**
   * 官方 AnimatedClawd 的两套序列（每帧 60ms）：
   *   JUMP_WAVE   蹲2 → 抬臂3 → 站1 → 蹲2 → 抬臂3 → 站1
   *   LOOK_AROUND 右看5 → 左看5 → 回正1
   * offset=1 表示蹲下（官方用 marginTop 让脚那行被裁掉）；这里等价成
   * 「整体下移一行、最后一行不画」，容器恒为 3 行，布局不跳。
   */
  static get CLAWD_SEQUENCES() {
    const hold = (pose, offset, n) => Array.from({ length: n }, () => ({ pose, offset }));
    return {
      jump: [
        ...hold('default', 1, 2), ...hold('arms-up', 0, 3), ...hold('default', 0, 1),
        ...hold('default', 1, 2), ...hold('arms-up', 0, 3), ...hold('default', 0, 1),
      ],
      look: [...hold('look-right', 0, 5), ...hold('look-left', 0, 5), ...hold('default', 0, 1)],
    };
  }

  /** 播一段吉祥物动画。which = 'jump' | 'look' | 'random' */
  playClawd(which = 'random') {
    const c = this.clawd;
    if (!c.poseLines || c.rowIndex < 0) return false;
    if (c.reducedMotion) return false;
    if (c.frame >= 0) return false;            // 正在播，不打断（官方同样忽略）
    const seqs = FullscreenSession.CLAWD_SEQUENCES;
    const key = which === 'random' ? (Math.random() < 0.5 ? 'jump' : 'look') : which;
    c.sequence = seqs[key] || seqs.look;
    c.frame = 0;
    this._stepClawd();
    return true;
  }

  _stepClawd() {
    const c = this.clawd;
    if (!c.sequence || c.frame < 0) return;
    if (c.frame >= c.sequence.length) {
      // 收尾：回到静止姿态，重画一次，清掉定时器
      c.frame = -1;
      c.sequence = null;
      c.pose = 'default';
      this._applyClawdFrame({ pose: 'default', offset: 0 });
      if (this._clawdTimer) { clearTimeout(this._clawdTimer); this._clawdTimer = null; }
      return;
    }
    const f = c.sequence[c.frame];
    c.pose = f.pose;
    this._applyClawdFrame(f);
    c.frame++;
    if (this._clawdTimer) clearTimeout(this._clawdTimer);
    this._clawdTimer = setTimeout(() => { this._clawdTimer = null; this._stepClawd(); }, 60);
    this._clawdTimer.unref?.();
  }

  /**
   * 把当前帧写进 welcomeLines 的那 3 行并重画 header。
   * 只动这 3 行，不重排其它欢迎页内容 —— header 的行数必须恒定，
   * 否则 body 高度会变，正文每帧上下跳。
   */
  _applyClawdFrame(frame) {
    const c = this.clawd;
    if (!c.poseLines || c.rowIndex < 0) return;
    const lines = c.poseLines(frame.pose);
    if (!Array.isArray(lines) || lines.length < 3) return;
    // offset=1（蹲下）：整体下移一行，末行丢掉 → 视觉上「沉到框下面」
    const rows = frame.offset === 1 ? ['', lines[0], lines[1]] : [lines[0], lines[1], lines[2]];
    for (let i = 0; i < 3; i++) {
      const idx = c.rowIndex + i;
      if (idx >= 0 && idx < this.welcomeLines.length) this.welcomeLines[idx] = rows[i];
    }
    if (!this.active) return;
    // 欢迎页已发过消息时吉祥物不在屏上，省掉整帧渲染
    if (this.welcomeDismissed) return;
    this._syncHeader();
    this.renderer.render();
    this._placeInputCursor();
  }

  /**
   * 空闲时随机播放。只在真正空闲（没有 spinner 在跑）时触发，
   * 每次随机 45~90 秒，避免规律性闪动和无谓重绘。
   */
  startClawdIdle() {
    if (this._clawdIdleTimer || this.clawd.reducedMotion) return;
    const schedule = () => {
      const delay = 45000 + Math.floor(Math.random() * 45000);
      this._clawdIdleTimer = setTimeout(() => {
        this._clawdIdleTimer = null;
        // 有任务在跑就跳过这一轮：那时用户注意力在 spinner 和正文上
        if (this.active && !this.spinner.active) this.playClawd('random');
        schedule();
      }, delay);
      this._clawdIdleTimer.unref?.();
    };
    schedule();
  }

  stopClawdIdle() {
    if (this._clawdIdleTimer) { clearTimeout(this._clawdIdleTimer); this._clawdIdleTimer = null; }
  }

  /**
   * 补全面板里「描述」被允许截断显示的最小剩余宽度（列）。
   * 低于这个值就整条丢掉描述——剩 3~4 列的残句（如 `压缩…`）信息量近零，
   * 比不显示更难看。8 列 ≈ 4 个汉字，是能读出意思的下限。
   * 视觉取向由 ArtDirector 定，技术上改这一个常量即可。
   */
  static get MIN_DESC_W() { return 8; }

  /** 官方 6 字形往返序列：正向 + reverse，帧宽稳定为 1 列 */
  static get SPINNER_FRAMES() {
    // Termux/Android 不采用官方 macOS 的 ✳，改用 * 避免宽度和字形偏移。
    // 官方是 DEFAULT_CHARACTERS + DEFAULT_CHARACTERS.reverse()，中间会经过两次 ✽。
    return ['·', '✢', '*', '✶', '✻', '✽', '✽', '✻', '✶', '*', '✢', '·'];
  }

  _spinnerLine(cols) {
    if (!this.spinner.active) return [];
    const dim = '\x1b[2m', reset = '\x1b[0m';
    const frames = FullscreenSession.SPINNER_FRAMES;
    const now = Date.now();
    const mascotColor = '\x1b[38;2;215;119;87m'; // 官方 Claude/主题强调色
    let glyph;
    if (this.spinner.reducedMotion) {
      // 官方 reduced-motion：● 以 2 秒周期做 1 秒亮 / 1 秒暗。
      const dimmed = Math.floor((now - this.spinner.startedAt) / 1000) % 2 === 1;
      // ⚠ 这里的「dim + 橙色」叠加是**故意的**：暗的那一秒就是靠 dim 压暗橙色
      //   实现明暗交替。样式审查脚本会把「暗+彩叠加」标成可疑，这一处是例外，
      //   不要"顺手修掉"（2026-09-13 审查时确认）。
      glyph = `${dimmed ? dim : ''}${mascotColor}●${reset}`;
    } else {
      glyph = `${mascotColor}${frames[this.spinner.frame % frames.length]}${reset}`;
    }
    const elapsed = Math.max(0, now - this.spinner.startedAt);
    const stalled = now - this.spinner.lastProgressAt > 3000 && this.spinner.mode !== 'tool-use';
    // 动词轮播：message 为 null 时每 8 秒换一个动词（官方 VERB_INTERVAL_MS）
    let label = this.spinner.message;
    if (label === null) {
      const verbCycle = Math.floor(elapsed / 8000);
      if (verbCycle !== this.spinner.verbIndex) {
        this.spinner.verbIndex = verbCycle;
      }
      // 【随机词整个 spinner 周期只抽一次】
      // 官方 Spinner.tsx:165-166 就是这么做的：用 useState 的 initializer
      // 在组件挂载那一刻抽一次，之后永不更换。
      // 我原来写在 render 里每帧调 pickSpinnerVerb()，于是每 120ms 换一个词，
      // 表现就是「随机词一直在切」。
      if (!this.spinner.randomVerb) this.spinner.randomVerb = pickSpinnerVerb();
      label = this.spinner.randomVerb;
      // 【随机词右边补上正在做什么】
      // 随机动词（Percolating… / Noodling…）好看但不说明在干什么。
      // 括号里补真实动作：✳ Percolating… (Reading) 3s
      // 动词表就是官方 bridge/sessionRunner.ts:70 的 TOOL_VERBS。
      // 已经同词的不重复标注（随机到 Thinking 不会写成 Thinking (thinking)）。
      const hint = this.spinner.verbHint
        || { thinking: 'Thinking', responding: 'Responding' }[this.spinner.mode];
      if (hint) {
        const bare = String(label).replace(/[….\s]+$/, '').toLowerCase();
        // ⚠ 这里【不能】用 reset 收尾：label 后面会被整体套一层 labelColor
        //   （见下方 return 那行），内层 reset 会把外层的橙色提前关掉，
        //   导致 (Reading) 之后的 suffix 丢色。用 22m 只关 dim 属性，
        //   前景色留给外层管。（2026-09-13 修，用户报「颜色混到一起」）
        // hint 是「正在做什么」的次要说明，设计上只该是暗色、不带 labelColor 的橙。
        // 所以要先 39m 关掉外层橙（label 整体会被套 labelColor），再上 dim；
        // 收尾用 22m 关 dim + 重新上橙，让后面的内容回到 label 的颜色。
        // ⚠ 不能用 reset：那会把外层橙一起清掉，suffix 就丢色了。
        if (bare !== String(hint).toLowerCase()) {
          label = `${label} \x1b[39m${dim}(${hint})\x1b[22m`;
        }
      }
    }
    label = label || 'Thinking…';
    // 官方是超过 30 秒才显示计时（SHOW_TOKENS_AFTER_MS）。这里从 1 秒起就显示：
    // 工具行已经不带单次耗时了，这一行是唯一的耗时来源，藏 30 秒等于没有。
    // 1 秒内不显示，避免刚发出去就跳一个 0s。
    const secs = Math.floor(elapsed / 1000);
    // 【自带耗时的文案要跳过 suffix】
    // 「thought for 1s」这类 label 本身就是耗时结论，再追加 spinner 的运行时长
    // 会变成「thought for 1s 17s」，而且后面那个数字还在涨（spinner 仍在跑）。
    // 官方的 thought for 是整行替换、不叠加计时，这里对齐。
    const labelHasOwnDuration = /\bfor \d+(?:\.\d+)?[sm]/.test(String(label || ''));
    const suffix = (secs >= 1 && !labelHasOwnDuration)
      ? ` ${dim}${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`}${reset}`
      : '';
    const stalledMark = stalled ? ` ${'\x1b[38;2;171;43;63m'}·${reset}` : '';

    // ── 文字配色（对齐官方 Spinner.tsx:211 `defaultColor = 'claude'`）──────
    // 官方 spinner 文字默认就是 Claude 橙，不是白色；卡住时渐变到红。
    // 渐变逻辑抄 components/Spinner/useStalledAnimation.ts：
    //   token 停 3 秒后开始变红，再用 2 秒线性过渡到满红。
    //   （不是一到 3 秒就跳红 —— 那样太突兀，渐变才有「正在失速」的感觉）
    const stalledMs = now - this.spinner.lastProgressAt;
    const intensity = stalled ? Math.min((stalledMs - 3000) / 2000, 1) : 0;
    const CLAUDE_RGB = [215, 119, 87];
    const ERROR_RGB = [171, 43, 63];
    const mix = (a, b, t) => Math.round(a + (b - a) * t);
    const labelColor = `\x1b[38;2;${CLAUDE_RGB.map((c, i) => mix(c, ERROR_RGB[i], intensity)).join(';')}m`;
    // 符号跟文字用同一个插值色，避免一橙一红割裂
    if (intensity > 0) glyph = `${labelColor}${frames[this.spinner.frame % frames.length]}${reset}`;

    return [`${glyph} ${labelColor}${label}${reset}${suffix}${stalledMark}`];
  }

  _ensureSpinnerTimer() {
    if (this._spinnerTimer || !this.spinner.active) return;
    // 字形每 120ms 前进一帧；无需用 50ms 定时器重复重绘相同帧。
    // 动词轮播在 _spinnerLine() 内按时间计算，不依赖更高频时钟。
    this._spinnerTimer = setInterval(() => {
      if (!this.spinner.active || !this.active) return;
      // 先给实时块一次按时间重算的机会（耗时类文案靠这个跑秒数）。
      // 回调自己停节流：内容没变就不触发重绘。
      if (this._liveTick) { try { this._liveTick(); } catch {} }
      const nextFrame = Math.floor((Date.now() - this.spinner.startedAt) / 120);
      if (nextFrame === this.spinner.frame) return;
      this.spinner.frame = nextFrame;
      this._refreshSpinnerOnly();
    }, 120);
    this._spinnerTimer.unref?.();
  }

  /**
   * 【2026-09-27 新增】只重绘 spinner 那一行的轻量路径。
   *
   * ══════════════════════════════════════════════════════════════
   *  为什么需要 —— 用户报「终端又卡死了，只能重启」
   * ══════════════════════════════════════════════════════════════
   *
   * 实测证据（~/.claude-code-mobile/render-slow.log，2000 样本）：
   *   refreshInput 单次耗时  中位数 41ms / P90 96ms / 最大 1051ms
   *   而 spinner 是 120ms 一帧 → 每秒 8.3 次
   *   → 每秒约 456ms 花在全量重绘上（45% 的事件循环时间）
   *   → 表现就是「什么都动不了，Ctrl+C 也无效」
   *
   * 关键洞察：spinner 换帧**只改 footer 的第 0 行**（_fitPanels 里
   * `spinner = spinnerLines.slice(0, 1)`，永远最多 1 行，且排在最前），
   * 其余五块（活动/待办/提示/补全/输入区）**一个字节都不会变**。
   * 却每次都走 refreshInput 重算全部 → 纯浪费。
   *
   * 这和「滚动时只重绘 body」是同一类优化（见 _scheduleScrollRender），
   * 只是方向相反：那边只动 body，这边只动 footer 第 0 行。
   *
   * 安全退化：以下情况退回完整 refreshInput ——
   *   · footer 还没初始化（刚启动，footerLines 为空）
   *   · spinner 行数发生变化（启动/停止那一帧，面板预算要重算）
   *   · 任何异常（宁可慢，不可画错）
   */
  _refreshSpinnerOnly() {
    if (!this.active) return;
    try {
      const fl = this.renderer.footerLines;
      // footer 未初始化 → 必须走完整路径（和 _scheduleScrollRender 同策略）
      if (!fl || fl.length === 0) { this.refreshInput(); return; }

      const cols = this.renderer._size().cols;
      const spinnerLines = this._spinnerLine(cols);   // 只算这一块，其余全跳过
      const next = spinnerLines.slice(0, 1);

      // spinner 启停时行数会从 0→1 或 1→0，面板预算（_fitPanels）要重算，
      // 这时不能走轻量路径 —— 否则 footer 总行数变了但 _panelRowCount 没更新，
      // 光标会定位到错行（历史踩过同类问题）。
      const prevCount = this._footerSpinnerCount ?? 0;
      if (next.length !== prevCount) { this.refreshInput(); return; }
      // 行数都是 0（spinner 已停）→ 没什么可重绘的，直接返回
      if (next.length === 0) return;

      // 行数没变（都是 1）：只替换第 0 行，其余 footer 原样复用
      fl[0] = next[0];

      // render() 用 footerLines 缓存，不重算任何面板
      const rendered = this.renderer.render();
      if (rendered && this.readline) this._placeInputCursor();
      else if (!rendered) this._scheduleRender();
    } catch (err) {
      // 轻量路径出错不能让画面卡住 —— 退回完整路径
      try { this.refreshInput(); } catch {}
      console.error('[FullscreenSession] spinner-only render error:', err.message);
    }
  }

  _stopSpinnerTimer() {
    if (this._spinnerTimer) clearInterval(this._spinnerTimer);
    this._spinnerTimer = null;
  }

  /**
   * 更新活动看板。传部分字段即可（未传的保持原值）。
   *   command: { name, startedAt } | null   正在执行的 slash 命令
   *   auto:    { pid, label } | null        自主任务守护进程
   *   agents:  [{ id, description }]        运行中的子 Agent
   */
  setActivity(patch) {
    if (!patch || typeof patch !== 'object') return;
    if ('command' in patch) this.activity.command = patch.command || null;
    if ('auto' in patch) this.activity.auto = patch.auto || null;
    if ('agents' in patch) this.activity.agents = Array.isArray(patch.agents) ? patch.agents : [];
    if (this.active) this.refreshInput();
  }

  /**
   * 折叠/展开看板。which = 'todo' | 'activity' | 'all'
   * 'all' 的语义：只要还有一块是展开的就全部收起，否则全部展开
   * （比「各自取反」直观 —— 用户按它就是想一键清屏或一键看全）。
   * @returns {string} 给用户看的状态描述
   */
  toggleBoard(which) {
    if (which === 'all') {
      const anyOpen = !this.collapsed.todo || !this.collapsed.activity;
      this.collapsed.todo = anyOpen;
      this.collapsed.activity = anyOpen;
    } else if (which === 'todo' || which === 'activity') {
      this.collapsed[which] = !this.collapsed[which];
    } else {
      return '';
    }
    if (this.active) this.refreshInput();
    const st = (b) => (b ? '收起' : '展开');
    return `待办 ${st(this.collapsed.todo)} · 活动 ${st(this.collapsed.activity)}`;
  }

  /**
   * 设置可补全的命令列表（用于实时提示面板）。
   * commands: ['help','compact',...]（不含前导 /）
   * descriptions: { compact: '压缩上下文', ... } 可选
   */
  setCommands(commands, descriptions = {}, subMap = {}, argHints = {}) {
    this.commands = Array.isArray(commands) ? commands : [];
    this.commandDesc = descriptions || {};
    this.commandArgHint = argHints || {};
    this.subMap = subMap || {};
  }

  /**
   * 实时补全面板：输入以 / 开头且还没打空格时，显示匹配的命令。
   * 不需要按 Tab —— 打 /c 那一刻就列出 /compact /context /clear …
   * 返回若干行；无匹配或不在命令输入态时返回空数组。
   */
  _completionLines(cols) {
    const rl = this.readline;
    if (!rl || !Array.isArray(this.commands) || !this.commands.length) return [];
    const line = String(rl.line ?? '');
    if (!line.startsWith('/')) return [];
    // 子命令提示：输入了空格 → 列出该命令的子命令候选。
    // 原来面板只在打命令名时出现，打完 /config 就消失——用户根本不知道
    // 后面还能接什么（/config test 4 就是这么被藏住的）。
    if (line.includes(' ')) {
      const spaceIdx = line.indexOf(' ');
      const cmdName = line.slice(1, spaceIdx);
      let frag = line.slice(spaceIdx + 1);
      // 二级嵌套：/config provider <空格> —— 第一段子命令命中 subMap 里的嵌套定义时继续下钻
      const subDef0 = this.subMap?.[cmdName];
      if (frag.includes(' ')) {
        const firstSub = frag.slice(0, frag.indexOf(' '));
        const rest = frag.slice(frag.indexOf(' ') + 1);
        const nested = !Array.isArray(subDef0) && subDef0?.nested?.[firstSub];
        if (!nested || rest.includes(' ')) return [];
        return this._renderSubHits(nested, rest, cols);
      }
      const subDef = subDef0;
      if (!subDef) return [];
      // 两种形态：['a','b'] 纯数组；{candidates:[...], desc:{a:'说明'}} 带描述
      const hits = this._renderSubHits(subDef, frag, cols);
      if (hits.length) return hits;
      return this._completionLinesRest(line, cols);
    }
    return this._completionLinesRest(line, cols);
  }

  /**
   * 渲染子命令候选（带可选描述）。subDef: 数组 或 {candidates, desc}
   */
  _renderSubHits(subDef, frag, colsIn) {
    const rl = this.readline;
    const dim = '\x1b[2m', r = '\x1b[0m';
    const ORANGE = '\x1b[38;2;215;119;87m';
    // candidates 支持**函数**（惰性求值），与 readline.mjs 的补全路径保持一致：
    // 角色卡、Provider 这类候选运行时会变（如 /agents reload 后新增的卡），
    // 静态数组在启动时就定死。两条路径必须同时支持，否则「补全能看到、
    // 面板看不到」——这类两处不一致正是本项目反复踩的坑。
    const rawSubs = Array.isArray(subDef) ? subDef : subDef.candidates;
    let subs = [];
    try {
      subs = typeof rawSubs === 'function' ? (rawSubs() || []) : (rawSubs || []);
    } catch { subs = []; }
    const subDesc = Array.isArray(subDef) ? null : (subDef.desc || {});
    if (!Array.isArray(subs) || !subs.length) return [];
    const cols = W.normCols(colsIn);
    const lower = String(frag || '').toLowerCase();
    const hits = subs.filter(x => String(x).toLowerCase().startsWith(lower));
    if (!hits.length) return [];
    return hits.slice(0, 8).map(sub => {
      const d = subDesc?.[sub];
      // ⚠ 缩进用 dim 只是为了让两个空格不显眼，但 ORANGE 紧跟其后会**叠在 dim 上**
      //   → 子命令名渲染成「暗橙」，比主命令面板的纯橙暗一档，看着像另一种状态。
      //   （2026-09-13 用户报「命令面板子命令颜色不对」。）
      //   缩进本来就是空格、上不上 dim 都看不出来，直接去掉 dim 最干净。
      const head = `  ${ORANGE}${sub}${r}`;
      if (W.strWidth(head) > cols) return W.truncAnsi(head, cols, '…');
      if (!d) return head;
      // 子命令说明也要按显示宽度降级：这一支原来【完全没做宽度检查】，
      // 中文说明（如 /config provider 的各项）在 40 列必折行，挤乱候选列表。
      // 与 _completionLinesRest 用同一套三档策略，两处行为必须一致——
      // 面板里这两种行长得一样，降级规则不同会让用户以为是随机错位。
      const spare = cols - W.strWidth(head) - 3;   // 3 = ' — ' 分隔符
      if (spare >= W.strWidth(d)) return `${head} ${dim}— ${d}${r}`;
      if (spare >= FullscreenSession.MIN_DESC_W) return `${head} ${dim}— ${W.truncAnsi(d, spare, '…')}${r}`;
      return head;
    });
  }

  _completionLinesRest(line, cols) {
    const rl = this.readline;
    // Tab 循环补全时，rl.line 已经是补全后的完整命令，用它当前缀会把候选集
    // 收窄到 1 个然后面板消失 —— 但用户正在 Tab 循环，面板必须留着。
    // 所以有 tabOriginalText 时用【进入补全前的原始输入】当过滤前缀。
    const inTabCycle = Array.isArray(rl.tabCandidates) && rl.tabCandidates.length > 0;
    const src = inTabCycle && rl.tabOriginalText ? String(rl.tabOriginalText) : line;
    const prefix = (src.startsWith('/') ? src.slice(1) : src).toLowerCase();
    // 【两级排序，对齐 Codex 的 command_popup.rs】
    // Codex 把候选分成 exact（完全相等）和 prefix（前缀匹配）两档，exact 永远排最前。
    // 好处：输入 /key 时 /key 自己排第一，而不是被 /keepalive 之类更长的挤下去
    // （纯 filter 保持的是 commands 数组原始顺序，谁先注册谁在前，跟输入无关）。
    const lowerHits = this.commands.filter((c) => c.toLowerCase().startsWith(prefix));
    const hits = [
      ...lowerHits.filter((c) => c.toLowerCase() === prefix),
      ...lowerHits.filter((c) => c.toLowerCase() !== prefix),
    ];
    if (!hits.length) return [];
    // 完全匹配且只有一个候选时不再提示（已经打完了）；Tab 循环中例外
    if (!inTabCycle && hits.length === 1 && hits[0].toLowerCase() === prefix) return [];

    const dim = '\x1b[2m', r = '\x1b[0m';
    const ORANGE = '\x1b[38;2;215;119;87m';
    const INVERSE = '\x1b[7m';
    const MAX = 5;

    // Tab 补全正在循环时高亮当前项。readline 的 tabCandidates/tabIndex 就是
    // Tab 键实际会补上的那个候选 —— 面板必须指向同一个，否则用户看到的第一项
    // 和 Tab 补出来的不是一个东西。
    let activeCmd = null;
    if (Array.isArray(rl.tabCandidates) && rl.tabCandidates.length && rl.tabIndex >= 0) {
      activeCmd = rl.tabCandidates[rl.tabIndex];
    }
    // 选中项要落在可见窗口内：候选多于 MAX 时把窗口滑到选中项附近
    let start = 0;
    if (activeCmd) {
      const idx = hits.indexOf(activeCmd);
      if (idx >= MAX) start = idx - MAX + 1;
    }
    const view = hits.slice(start, start + MAX);

    const out = [];
    for (const cmd of view) {
      const desc = this.commandDesc[cmd] || '';
      // 参数格式提示，对齐官方 argumentHint（如 /add-dir <path>）
      const argHint = this.commandArgHint[cmd] || '';
      const isActive = cmd === activeCmd;
      // 匹配到的前缀高亮，其余灰色；当前 Tab 选中项整行反显
      const head = isActive
        ? `${INVERSE} /${cmd} ${r}`
        : `${ORANGE}/${cmd.slice(0, prefix.length)}${r}${dim}${cmd.slice(prefix.length)}${r}`;
      const argPart = argHint ? `${dim} ${argHint}${r}` : '';
      // 【宽度必须按显示列算，不能用 .length】（2026-08-31 修，宽度第 5 处）
      // 原实现是 `(isActive?3:1) + cmd.length + argHint.length + desc.length`，
      // 汉字按 1 算实占 2 列 → 中文描述算出的值约等于真实宽度的一半。
      // 命令描述几乎全是中文，所以「超宽就丢描述」这个降级**在中文场景从未触发**：
      // 整行照常输出 → 终端强制折行 → 折行挤掉下一候选、破坏列表对齐
      //（历史上反复出现的「面板残字 / 候选错位」有这一处的份）。
      // 现在走 core/width.mjs（单一权威），head/argPart 自带 ANSI，strWidth 会
      // 整串剥离——正是要的行为（转义不占列）。
      // 极窄屏兜底：head + argHint 本身就超宽时（20 列下 `/cmd <参数一> [可选参数二]`
      // 实测 27 列），光降级描述没用，整行照样折行。优先级：命令名 > argHint > 描述。
      const headW = W.strWidth(head);
      if (headW > cols) {                                     // 命令名自己都装不下 → 硬截
        out.push(W.truncAnsi(head, cols, '…'));
        continue;
      }
      // 装不下就先丢 argHint（命令名 > argHint > 描述）
      const arg = headW + W.strWidth(argPart) > cols ? '' : argPart;
      const spare = cols - headW - W.strWidth(arg) - 2;       // 2 = 描述前的两个空格
      // 描述降级三档：装得下原样显示；装不下但还剩够写几个字 → 截断加 …；
      // 剩不下 MIN_DESC_W 就整条丢（残句如「压缩…」信息量近零，不如不显示）。
      if (!desc || spare < FullscreenSession.MIN_DESC_W) {
        out.push(`${head}${arg}`);
      } else if (spare >= W.strWidth(desc)) {
        out.push(`${head}${arg}${dim}  ${desc}${r}`);
      } else {
        out.push(`${head}${arg}${dim}  ${W.truncAnsi(desc, spare, '…')}${r}`);
      }
    }
    const hidden = hits.length - view.length - start;
    if (start > 0) out.unshift(`${dim}  ↑ 前面还有 ${start} 个${r}`);
    if (hidden > 0) out.push(`${dim}  ↓ 还有 ${hidden} 个${r}`);
    return out;
  }

  /** 把 todos 渲染成若干行；未完成的优先显示，超出上限折叠成计数
   * 官方 TaskListV2：最近完成优先显示（30 秒内），进行中次之，待办最后
   */
  _todoLines(cols) {
    if (this.collapsed?.todo) return [];
    if (!Array.isArray(this.todos) || !this.todos.length) return [];
    const dim = '\x1b[2m', r = '\x1b[0m';
    const now = Date.now();
    const RECENT_TTL = 30000; // 官方 30 秒
    const done = this.todos.filter((t) => t.status === 'completed').length;
    const total = this.todos.length;
    // 全部完成 → 整块收起。
    // 否则只剩一个「待办 1/1」的孤立表头，下面一条内容都没有，纯占屏幕。
    // 完成情况正文里已有汇总，看板不必再留个空壳。
    if (done >= total) return [];
    const out = [`${dim}待办 ${done}/${total}${r}`];
    
    // 官方优先级排序：最近完成 > 进行中 > 待办
    const recentDone = this.todos.filter(t => {
      if (t.status !== 'completed') return false;
      const ts = this.todoCompletionTimes.get(t.id);
      return ts && (now - ts < RECENT_TTL);
    });
    const inProgress = this.todos.filter(t => t.status === 'in_progress');
    const pending = this.todos.filter(t => t.status === 'pending');
    const prioritized = [...recentDone, ...inProgress, ...pending];
    const MAX = 10; // 官方截断阈值
    const visible = prioritized.slice(0, Math.min(MAX, 4)); // 实际显示最多 4 条（屏幕限制）
    
    for (const t of visible) {
      let mark = '·', color = dim;
      if (t.status === 'completed') {
        mark = '✓';
        color = '\x1b[38;2;152;195;121m'; // 绿色
      } else if (t.status === 'in_progress') {
        mark = '▸';
        color = '\x1b[38;2;215;119;87m'; // 橙色
      }
      // 【按显示宽度截断，不能用 .slice】待办内容基本都是中文，
      // slice(0, cols-4) 切出的字符数在中文下实占约 2 倍宽 → 超屏折行 → 挤乱看板。
      // 前缀 ' ▸ ' 占 3 列，留 1 列余量避免压到右边界。
      const text = W.truncAnsi(String(t.content || ''), Math.max(10, cols - 4), '…');
      out.push(`${color} ${mark} ${text}${r}`);
    }
    
    const hiddenCount = prioritized.length - visible.length;
    if (hiddenCount > 0) {
      const hiddenPending = pending.length - visible.filter(t => t.status === 'pending').length;
      const hiddenInProgress = inProgress.length - visible.filter(t => t.status === 'in_progress').length;
      const parts = [];
      if (hiddenInProgress > 0) parts.push(`${hiddenInProgress} 进行中`);
      if (hiddenPending > 0) parts.push(`${hiddenPending} 待办`);
      // 只有一种类型时简化为 "X 项"
      const text = parts.length === 1 && hiddenCount <= 5 ? `${hiddenCount} 项` : (parts.join(', ') || `${hiddenCount} 项`);
      out.push(`${dim}   还有 ${text}${r}`);
    }
    return out;
  }

  /**
   * 活动看板。三类并发活动各占一栏，横向排列成一个长方形：
   *   ┌ 命令 ──────┬ 自主任务 ───┬ 子 Agent ──┐
   *   │ /compact   │ 守护 #1234  │ 2 个运行中 │
   *   └────────────┴─────────────┴────────────┘
   * 只有一两类活动时退化成单行紧凑显示（三栏太占地方）。
   * 屏幕窄（< 46 列）时也强制单行，否则每栏挤成两三个字没意义。
   */
  _activityLines(cols, opts = {}) {
    if (this.collapsed?.activity) return [];
    const a = this.activity;
    if (!a || typeof a !== 'object') return [];
    const dim = '\x1b[2m', r = '\x1b[0m';
    const accent = '\x1b[38;2;215;119;87m';   // 与 in_progress todo 同色
    const cyan = '\x1b[38;2;108;174;196m';

    // 收集活动项：[图标, 标题, 内容, 颜色]
    const items = [];
    if (a.command) {
      const sec = a.command.startedAt ? Math.floor((Date.now() - a.command.startedAt) / 1000) : 0;
      items.push(['◆', '命令', `/${a.command.name}${sec > 1 ? ` ${sec}s` : ''}`, accent]);
    }
    if (a.auto) {
      items.push(['◈', '自主任务', a.auto.label || `守护 #${a.auto.pid || '?'}`, cyan]);
    }
    if (a.agents?.length) {
      const n = a.agents.length;
      // 18 是【列】不是字符数：子 Agent 描述常是中文，.slice(0,18) 实占 36 列，
      // 单行紧凑模式下直接顶爆屏宽（下面虽有兜底，但会退化成只剩图标，丢掉全部文字）。
      const label = n === 1
        ? W.truncAnsi(String(a.agents[0].description || '运行中'), 18, '…')
        : `${n} 个运行中`;
      items.push(['◇', '子 Agent', label, '\x1b[38;2;152;195;121m']);
    }
    if (!items.length) return [];

    // 单行紧凑模式：活动少于 3 类，或屏幕太窄摆不开三栏
    // forceCompact: footer 预算不够时由 _fitPanels 强制压成单行
    if (items.length < 3 || cols < 46 || opts.forceCompact) {
      const parts = items.map(([icon, , text, color]) => `${color}${icon} ${text}${r}`);
      let line = parts.join(`${dim} · ${r}`);
      // 超宽时退到只显示图标+数量，保证不折行破坏布局
      if (this._visibleWidth(line) > cols) {
        line = items.map(([icon, , , color]) => `${color}${icon}${r}`).join(' ')
          + `${dim} ${items.length} 项活动${r}`;
      }
      return [line];
    }

    // 三栏模式：等分屏宽，每栏内 [图标 标题] 一行、[内容] 一行
    const inner = cols - 4;                       // 两侧边框 + 两个分隔符
    const w = Math.floor(inner / 3);
    const widths = [w, w, inner - w * 2];         // 余数给最后一栏
    const pad = (s, width) => {
      const vis = this._visibleWidth(s);
      if (vis > width) return this._truncateToWidth(s, width);
      return s + ' '.repeat(width - vis);
    };
    const top = `${dim}┌${'─'.repeat(widths[0])}┬${'─'.repeat(widths[1])}┬${'─'.repeat(widths[2])}┐${r}`;
    const bottom = `${dim}└${'─'.repeat(widths[0])}┴${'─'.repeat(widths[1])}┴${'─'.repeat(widths[2])}┘${r}`;
    const titleCells = items.map(([icon, title, , color], i) =>
      pad(`${color}${icon} ${title}${r}`, widths[i]));
    const bodyCells = items.map(([, , text, color], i) =>
      pad(`${color}  ${text}${r}`, widths[i]));
    const v = `${dim}│${r}`;
    return [
      top,
      `${v}${titleCells.join(v)}${v}`,
      `${v}${bodyCells.join(v)}${v}`,
      bottom,
    ];
  }

  /**
   * footer 预算裁剪。五块面板全开时可能把正文挤没，这里按优先级降级。
   *
   * 优先级（越靠前越该保住）：
   *   1. 输入区    —— 用户正在打的字，绝不能砍
   *   2. 补全面板  —— 刚敲了 /，正等着看候选
   *   3. 待办      —— 当前进度，但可以只留表头
   *   4. 活动看板  —— 三栏可以压成单行，信息量损失最小
   *
   * 超预算时的降级顺序：活动三栏→单行 → 待办截断 → 补全截断 → 提示丢掉。
   */
  _fitPanels({ spinnerLines = [], actLines, todoLines, hintLines, compLines, cols }) {
    const MIN_BODY = 3;   // 正文至少留 3 行，否则等于没有正文
    const rows = this.renderer._size().rows;
    // 【2026-09-19】欢迎页从 header 移到了 body 前置块（随正文滚动，见 _syncHeader），
    // 所以 header 恒为 0 行、不再占预算。这里保留读取是为了兼容将来
    // 可能重新引入固定 header 的场景（那时这段逻辑自动生效，不用再改）。
    const headerN = this.renderer.headerLines.length;
    const inputN = Math.max(1, this._estimateInputRows(cols));
    // footer = 面板 + 上边框(1) + 输入区 + 下边框(1) + 状态行(N)
    //
    // 【状态行支持多行（2026-09-15）】原来固定算 1 行。setStatus 现在可以传
    // 含 \n 的字符串（第一行放模型/上下文，后续行放耗时/项目等次要信息），
    // 所以这里要按实际行数算，否则 budget 算多了会把正文挤掉。
    const statusRows = this.statusLine ? this.statusLine.split('\n').length : 0;
    const fixed = 1 + inputN + 1 + statusRows;
    let budget = rows - headerN - MIN_BODY - fixed;

    // spinner 是当前运行状态，优先级最高，永远保留；其他面板围绕它裁剪。
    let spinner = spinnerLines.slice(0, 1);
    let act = actLines, todo = todoLines, hint = hintLines, comp = compLines;
    const used = () => spinner.length + act.length + todo.length + hint.length + comp.length;
    if (budget < 0) budget = 0;
    if (used() <= budget) return { spinner, act, todo, hint, comp };

    // 1) 活动看板三栏(4行) → 强制单行
    if (act.length > 1) {
      act = this._activityLines(cols, { forceCompact: true });
      if (used() <= budget) return { spinner, act, todo, hint, comp };
    }
    // 2) 待办截断：保表头 + 尽量多的条目
    if (todo.length > 1) {
      const spare = budget - spinner.length - act.length - hint.length - comp.length;
      if (spare >= 2) {
        const keep = Math.min(todo.length, spare);
        todo = todo.slice(0, keep);
        // 被砍掉条目时把最后一行换成计数，避免"看着列完了其实还有"
        const cut = todoLines.length - keep;
        if (cut > 0) todo = [...todo.slice(0, keep - 1), `\x1b[2m   还有 ${cut} 项 ^T${'\x1b[0m'}`];
      } else {
        todo = [];
      }
      if (used() <= budget) return { spinner, act, todo, hint, comp };
    }
    // 3) 补全面板截断（保留前几个候选）
    if (comp.length > 1) {
      const spare = Math.max(0, budget - spinner.length - act.length - todo.length - hint.length);
      comp = comp.slice(0, spare);
      if (used() <= budget) return { spinner, act, todo, hint, comp };
    }
    // 4) 还是超 → 丢提示行，再不行就只留补全
    hint = [];
    if (used() <= budget) return { spinner, act, todo, hint, comp };
    todo = [];
    act = [];
    if (comp.length > Math.max(0, budget - spinner.length)) {
      comp = comp.slice(0, Math.max(0, budget - spinner.length));
    }
    return { spinner, act, todo, hint, comp };
  }

  /** 估算输入区折行后占几行（预算计算要用，不能等 _inputRows 算完） */
  _estimateInputRows(cols) {
    const rl = this.readline;
    if (!rl) return 1;
    const prompt = rl.prompt ?? '❯ ';
    const content = String(rl.getDisplayLine ? rl.getDisplayLine() : (rl.line ?? ''));
    let n = 0;
    const segs = content.split('\n');
    for (let i = 0; i < segs.length; i++) {
      const text = i === 0 ? prompt + segs[i] : segs[i];
      n += Math.max(1, wrapToWidth(text, cols).length);
    }
    // 【2026-09-20】必须和 refreshInput 的裁剪上限保持一致 ——
    // 那边超出 maxInputRows 就折叠成固定行数，这边若按全量估，
    // _fitPanels 会以为输入区要占几十行，把正文预算压到 0（正是"被拉长"的观感）。
    const rows = this.renderer._size().rows;
    const maxInputRows = Math.max(6, Math.min(15, Math.floor(rows / 3)));
    if (n > maxInputRows) n = maxInputRows;
    return Math.max(1, n);
  }

  /**
   * 折叠提示。只在「确实有内容被收起」时才占一行 ——
   * 收起了但本来也没内容（比如没有待办）就不提示，否则等于白占一行。
   */
  _collapsedHint(cols) {
    const dim = '\x1b[2m', r = '\x1b[0m';
    const parts = [];
    // 待办：只有存在未完成项才算"藏了东西"（全完成时本来就该收起）
    if (this.collapsed?.todo && this.todos?.length) {
      const undone = this.todos.filter((t) => t.status !== 'completed').length;
      if (undone > 0) parts.push(`待办 ${undone} 项 → ^T 展开`);
    }
    if (this.collapsed?.activity) {
      const a = this.activity;
      const n = (a.command ? 1 : 0) + (a.auto ? 1 : 0) + (a.agents?.length || 0);
      if (n > 0) parts.push(`活动 ${n} 项 → ^Y 展开`);
    }
    if (!parts.length) return [];
    const line = `${dim}⋯ ${parts.join(' · ')}${r}`;
    // 摆不下就退到简短版，再摆不下就只留省略号（绝不折行破坏布局）
    if (this._visibleWidth(line) <= cols) return [line];
    const brief = `${dim}⋯ ${parts.map((p) => p.split(' → ')[0]).join(' · ')} (^T/^Y)${r}`;
    if (this._visibleWidth(brief) <= cols) return [brief];
    return [`${dim}⋯ 已折叠 ^O${r}`];
  }

  /**
   * 计算字符串可见宽度。已收口到 core/width.mjs（单一权威）。
   *
   * 原实现有两个坑：
   *   1) 只 replace 掉 SGR（`\x1b[…m`），光标移动/OSC 等序列会被当可见字符计宽；
   *   2) 依赖 `this.readline?.strWidth`，readline 未挂载时**退化成 .length** ——
   *      中文按 1 算，宽度直接减半。面板在 readline 就绪前也会画。
   */
  _visibleWidth(s) {
    return W.strWidth(s);
  }

  /**
   * 按可见宽度截断并右填充到 width（栏位对齐用）。
   *
   * 原实现逐字符调 `readline.strWidth(ch)` —— 违反 width.mjs 铁律 1：
   * emoji 是代理对，`str[i]` 会把它劈成两个各算 1 列的半字符，宽度算多、
   * 还输出乱码。现在按码点走 W.truncAnsi。
   */
  _truncateToWidth(s, width) {
    const cap = Math.max(0, Math.floor(Number(width) || 0));
    const cut = W.truncAnsi(s, cap);
    // 填充到固定宽度：栏位边框要对齐，不足补空格（padEnd 对宽字符会算错，故用实测宽度）
    return cut + '\x1b[0m' + ' '.repeat(Math.max(0, cap - W.strWidth(cut)));
  }

  /**
   * 重画输入区（footer）。结构照官方 PromptInput.tsx：
   *   ─────────────────  上边框
   *   ❯ 输入内容           输入行（可多行）
   *   ─────────────────  下边框
   *   状态行               可选
   * 官方用 borderStyle="round" + borderLeft/Right={false}，等价于上下各一条
   * '─'.repeat(columns)，没有左右竖线。
   */
  refreshInput() {
    if (!this.active) return;
    const _t = process.hrtime.bigint();
    // 【细粒度埋点 2026-09-26】上一轮只记了 refreshInput 总耗时，结果
    // 发现 bodyLines=11 时也要 104ms —— 跟正文无关，瓶颈在 footer。
    // 但 footer 有五块（spinner/活动/待办/提示/补全）+ 输入区折行 + render()，
    // 光看总耗时无法定位。这里按段计时，用时最长的直接暴露。
    const _marks = [];
    const _m = (n) => _marks.push([n, Number(process.hrtime.bigint() - _t) / 1e6]);
    try {
      // 【性能埋点 2026-09-23】见 index.mjs 的 onText 埋点。
      // 这里统计 refreshInput 与 renderer.render 的耗时：单次 >30ms 或
      // 60 秒内累计 >500ms 就记一行，用来定位「Responding… 时卡死」。
      // 注意 finally 在函数末尾（不能在这里 return，会破坏原逻辑）。
      const rl = this.readline;
      const cols = this.renderer._size().cols;
      const rule = this.borderColor
        ? `${this.borderColor}${'─'.repeat(cols)}\x1b[0m`
        : '─'.repeat(cols);
      _m('init')
      // 待办区在输入框上方（正文和输入框之间），不会被正文滚走
      const todoLines = this._todoLines(cols);
      _m('todo')
      // 活动看板：正在跑的命令/自主任务/子 Agent，放在待办上方
      const actLines = this._activityLines(cols);
      _m('activity')
      // 折叠提示：有内容被收起时留一行，否则用户不知道藏了东西、也不知道怎么展开
      _m('hint')
      const hintLines = this._collapsedHint(cols);
      _m('collapsedHint')
      // 命令补全面板：打 /c 立刻显示候选，紧贴输入框上边框
      const compLines = this._completionLines(cols);
      _m('completion')
      // 预算控制：五块（活动/待办/提示/补全/输入）同时存在时能吃掉 19 行，
      // 20 行的屏幕正文就归零了 —— 用户看不到任何回复，只剩一屏面板。
      // 所以按优先级裁剪，保证正文至少留 MIN_BODY 行。
      const spinnerLines = this._spinnerLine(cols);
      _m('spinnerLine')
      const panels = this._fitPanels({ spinnerLines, actLines, todoLines, hintLines, compLines, cols });
      _m('fitPanels')
      // 存下裁剪后的面板总行数：placeCursor 要用它算输入区起始行，
      // 不能再各自重算（裁剪后行数会变，重算必然错位）。
      this._panelRowCount = panels.spinner.length + panels.act.length + panels.todo.length + panels.hint.length + panels.comp.length;
      // 【2026-09-27】记录 footer 里 spinner 占了几行（0 或 1）。
      // 轻量路径 _refreshSpinnerOnly 靠它判断「行数有没有变」——
      // 变了说明 spinner 启停，面板预算要重算，必须退回完整路径。
      this._footerSpinnerCount = panels.spinner.length;
      const lines = [...panels.spinner, ...panels.act, ...panels.todo, ...panels.hint, ...panels.comp, rule];

      // 输入区必须按屏宽折行后再交给 footer。
      // 之前直接 push 整行：内容超过屏宽时 VScreen.writeText 会截断（看不见后半段），
      // 光标列也会算出 >cols 的值，被终端钳到边界 → 光标跑到下面那条 ─ 上；
      // footer 行数还按 1 行算，布局整体错位，退格后残留旧字符。
      this._inputRows = [];      // 记录折行后的输入物理行，光标定位要用
      this._inputHiddenRows = 0; // 输入区被折叠掉的行数（见下方裁剪逻辑 + _placeInputCursor）
      if (rl) {
        const prompt = rl.prompt ?? '❯ ';
        const content = rl.getDisplayLine ? rl.getDisplayLine() : (rl.line ?? '');
        // 先按 \n 硬分段（续行），每段再按屏宽软折行
        const segs = String(content).split('\n');
        for (let i = 0; i < segs.length; i++) {
          const text = i === 0 ? prompt + segs[i] : segs[i];
          const wrapped = wrapToWidth(text, cols);
          for (const w of wrapped) this._inputRows.push(w);
        }
        // 光标恰好在满行边界时会落到「下一行行首」（见 _placeInputCursor），
        // 这里必须相应多留一个空行，否则光标会落到下边框那一行上。
        //
        // 【2026-08-30 修 Agent 运行中光标右移】原来这里用 `curW % cols === 0`
        // 判断满行，而 _placeInputCursor 已改用 _simulateLayout 逐字符模拟。
        // 两处用不同模型 → 宽字符（中英混排）跳格时结论不一致：一边认为该留空行、
        // 另一边算出的列不匹配。Agent 运行中每次输出都触发 refreshInput，
        // 偏差每次累积一点，光标就持续右移。现在统一走 _simulateLayout。
        // 同 _placeInputCursor：折叠粘贴时 rl.cursor 属于原始 line 坐标系，
        // 不能拿来切 getDisplayLine() 的短标签。
        const cursorPos = rl.collapsedPaste ? String(content).length : (rl.cursor ?? String(content).length);
        const beforeCur = String(content).slice(0, cursorPos);
        const lastSeg = beforeCur.split('\n').pop() ?? '';
        const isFirstSeg = !beforeCur.includes('\n');
        // 【留行判断必须和 _placeInputCursor 用同一个模型、同一组参数】
        // 历史教训：这里曾用 `curW % cols === 0`，而定位那边用逐字符模拟，
        // 两处结论在宽字符跳格时不一致 → 每次 refreshInput 累积偏差 → 光标持续右移。
        // 现在都走 W.layout(reserveWrapRow:true)。
        // 注意：reserveWrapRow:true 时满行已被换算成「下一行行首」，
        // 所以**不能**再用 `cursorCol >= cols` 判断（永不成立）；
        // 正确判据是「光标行超出了 wrapToWidth 铺出来的行数」——超了就补一行承载它。
        const lay = W.layout(isFirstSeg ? prompt : '', lastSeg, { cols, reserveWrapRow: true });
        const bodyRows = this._inputRows.length;
        if (lay.cursorRow >= bodyRows) this._inputRows.push('');

        // 【2026-09-20 修：输入区被夸张拉长】
        // 用户反馈「文本多了时聊天框被夸张地拉长」。原因：_inputRows 没有任何上限，
        // 贴一大段/多行输入时输入区会一路长高，把正文挤到看不见 ——
        // 而 _fitPanels 只给正文保留了 MIN_BODY=3 行，等于整屏几乎被输入框占满。
        //
        // 现在限制在屏高的 1/3（至少 6 行、至多 15 行）：
        // 超出部分**只保留光标附近**（尾部若干行），前面的用一行提示替代，
        // 这样用户仍能看到自己正在输入的位置，又没有失控的高度。
        // 注意：这只是"显示"层面的裁剪，rl.line 的内容完全不动，
        // 提交时仍是完整文本（不会因此丢字）。
        const rows = this.renderer._size().rows;
        const maxInputRows = Math.max(6, Math.min(15, Math.floor(rows / 3)));
        this._inputHiddenRows = 0;   // 供 _placeInputCursor 扣除偏移
        if (this._inputRows.length > maxInputRows) {
          const hiddenCount = this._inputRows.length - (maxInputRows - 1);
          // 【关键】只记「内容被藏了几行」——physRow 是全量内容坐标系里的行号，
          // 被折叠掉的是前 hiddenCount 行内容。提示行是**额外**插进来的显示占位，
          // 在全量坐标系里没有对应行，所以**不能**把它算进偏移
          //（多减 1 会让光标停在倒数第二行，实测复现过）。
          this._inputHiddenRows = hiddenCount;
          // 保留最后 maxInputRows-1 行（含光标所在行），前面换成提示行
          this._inputRows = [
            `\x1b[2m  ⋯ 前面还有 ${hiddenCount} 行（已折叠，内容不丢）\x1b[0m`,
            ...this._inputRows.slice(-(maxInputRows - 1)),
          ];
        }
      } else {
        this._inputRows.push('❯ ');
      }
      for (const row of this._inputRows) lines.push(row);
      lines.push(rule);
      if (this.statusLine) {
        // 多行状态：按 \n 拆开逐行 push（空行也保留，便于用空行做视觉分组）
        for (const l of this.statusLine.split('\n')) lines.push(l);
      }

      this.renderer.setFooter(lines);
      _m('setFooter')
      const rendered = this.renderer.render();
      _m('render')
      // render 被重入锁挡掉时（_rendering=true，说明外层已在渲染中）画面还是旧的，
      // 此时定位光标等于「用新算出的位置去指旧画面」→ 光标偶发压在字上/错行。
      // 这种情况下跳过定位，并安排下一帧重刷，由那一帧统一把画面和光标对齐。
      if (rl) {
        if (rendered) this._placeInputCursor();
        else this._scheduleRender();
      }
    } catch (err) {
      // 捕获渲染错误，避免崩溃
      console.error('[FullscreenSession] refreshInput error:', err.message);
    }
  
    // 性能埋点（见函数开头）
    try {
      const ms = Number(process.hrtime.bigint() - _t) / 1e6
      this._perfRefreshSum = (this._perfRefreshSum || 0) + ms
      this._perfRefreshMax = Math.max(this._perfRefreshMax || 0, ms)
      this._perfRefreshCnt = (this._perfRefreshCnt || 0) + 1
      const now = Date.now()
      if (!this._perfLastReport) this._perfLastReport = now
      if (ms > 30 || (now - this._perfLastReport > 60000 && this._perfRefreshSum > 500)) {
        // 各段耗时：相邻两个 mark 的差就是那一段的花费
        let seg = ''
        for (let i = 1; i < _marks.length; i++) {
          const d = _marks[i][1] - _marks[i-1][1]
          if (d >= 1) seg += ` ${_marks[i][0]}=${d.toFixed(0)}`
        }
        const detail = `refreshInput 单次${ms.toFixed(0)}ms max=${this._perfRefreshMax.toFixed(0)}ms 次数=${this._perfRefreshCnt} 累计=${this._perfRefreshSum.toFixed(0)}ms |${seg}`
        const line = `[${new Date().toISOString()}] ${detail} inputRows=${this._inputRows?.length} bodyLines=${this.renderer?.bodyLines?.length}\n`
        try { appendFileSync(join(homedir(), '.claude-code-mobile', 'render-slow.log'), line) } catch {}
        this._perfRefreshSum = 0; this._perfRefreshCnt = 0; this._perfLastReport = now
      }
    } catch {}
}

  /**
   * 把终端光标放到输入位置。
   * 必须考虑【软折行】：一段逻辑内容超过屏宽时会占多个物理行，
   * 只按 \n 分段会算出超出屏宽的列号 → 光标越界跑到边框上。
   */
  _placeInputCursor() {
    const rl = this.readline;
    if (!rl) return;
    try {
      const cols = this.renderer._size().cols;
    const prompt = rl.prompt ?? '❯ ';
    const content = String(rl.getDisplayLine ? rl.getDisplayLine() : (rl.line ?? ''));
    // 【坐标系必须对齐】content 来自 getDisplayLine()：折叠粘贴时它是短标签
    //（如「[粘贴 N 行]」），而 rl.cursor 是【原始 long line】里的索引——两个坐标系。
    // 直接用 rl.cursor 切短标签，索引远超标签长度 → 光标右移好几格。
    // readline.render() 对此有转换（见 readline.mjs:249 visualCursor），全屏适配器漏了。
    const cursor = rl.collapsedPaste ? content.length : (rl.cursor ?? content.length);
    const before = content.slice(0, cursor);
    const width = (s) => (rl.strWidth ? rl.strWidth(s) : String(s).length);

    // 按 \n 硬分段：先定位到光标所在的逻辑段
    const segsAll = content.split('\n');
    const segsBefore = before.split('\n');
    const segIdx = segsBefore.length - 1;              // 光标在第几个逻辑段

    // 【2026-08-30 bug2 修复】光标列不能再用「总宽 % cols」反推：
    // 宽字符（汉字/英文混排）在行尾放不下时终端会把它整体推到下一行、
    // 原行尾留空（跳格），取模完全感知不到 → 光标列逐行累积偏移 → 压字。
    // 已收口到 core/width.mjs（单一权威）：逐 cell 模拟终端排版。
    // 对光标之前的文本段做模拟（段前各行已累加），拿光标行列。
    if (true) {
      let physRow = 0;
      for (let i = 0; i < segIdx; i++) {
        const text = i === 0 ? prompt + segsAll[i] : segsAll[i];
        physRow += wrapToWidth(text, cols).length;
      }
      // 当前段：prompt 只在该段是第一段时才带。
      // 【关键】prompt 必须走第 1 个参数，不能拼进内容 —— 否则光标索引会多出
      // prompt 的长度，每次渲染都右移好几格（曾经的真实回归）。
      const segContent = segsBefore[segIdx];
      const layout = W.layout(segIdx === 0 ? prompt : '', segContent, {
        cols,
        reserveWrapRow: true,   // 全屏虚拟输入区：满行要真实占一行承载光标
      });
      physRow += layout.cursorRow;

      // footer 结构 [看板行..., todo 行..., 提示行?, 补全面板..., 上边框, 输入行..., 下边框, 状态行?]
      // 输入区起始行 = 面板总行数 + 1（跳过上边框）
      //
      // 必须用 refreshInput 里【裁剪后】的行数。之前这里重新调 _activityLines()
      // 等方法算原始行数，一旦预算裁剪生效（三栏压成单行、待办被截断），
      // 算出的偏移比实际多 3~5 行，光标就跑到输入框下面去了。
      const n = this._panelRowCount ?? 0;
      // 【2026-09-20】输入区被裁剪时（内容超出 maxInputRows，见 refreshInput）：
      //   physRow         = 全量内容坐标系里的光标行号
      //   _inputHiddenRows = 前面被藏掉的内容行数（不含提示行）
      // 显示行序是：[提示行] + 保留的尾部内容行，所以光标在屏幕上的位置是
      //   physRow - hiddenCount + 1   （+1 = 提示行占的那一行）
      // 漏了 +1 光标会停在倒数第二行；不给 hiddenCount 扣则指到输入框上方很远。
      const hidden = this._inputHiddenRows || 0;
      const clipBias = hidden > 0 ? 1 : 0;
      const targetRow = n + 1 + Math.max(0, physRow - hidden + clipBias);

      // 满行归属已由 width.layout(reserveWrapRow:true) 处理：满行时它直接返回
      // 下一行行首（row+1, col0），不会再吐出 >= cols 的列值。
      // 所以这里**不能**再 min(cols-1) 夹一次 —— 那会把正确的 col 0 之外的值
      // 压回末列，正是「光标压在宽字符右半格」的老毛病。
      const colInRow = Math.max(0, layout.cursorCol);
      // 告诉 renderer「光标在 footer 的第几行」—— 它绘制 footer 时要用这个
      // 决定视口（footer 比屏幕高时是保住末尾还是跟随光标）。
      // 必须在 placeCursor 之前设，因为 render 可能在这之前已经跑过一帧。
      this.renderer._pendingFooterRow = targetRow;
      this.renderer.placeCursor(colInRow, targetRow);
      return;
    }

    // 回退路径：无 _simulateLayout 的旧实现（理论上不可达，保底防崩）
    const inSeg = segsBefore[segIdx];                  // 该段内光标之前的内容
    let physRow2 = 0;
    for (let i = 0; i < segIdx; i++) {
      const text = i === 0 ? prompt + segsAll[i] : segsAll[i];
      physRow2 += wrapToWidth(text, cols).length;
    }
    const cursorText = segIdx === 0 ? prompt + inSeg : inSeg;
    const w = width(cursorText);
    // 满行时落到下一行行首，避免压在宽字符右半格（与 readline.render 同思路）
    const rowInSeg = w > 0 && w % cols === 0 ? Math.floor(w / cols) : Math.floor(w / cols);
    const colInRow2 = w % cols === 0 && w > 0 ? 0 : w % cols;
    physRow2 += rowInSeg;
    const n2 = this._panelRowCount ?? 0;
    this.renderer.placeCursor(Math.max(0, Math.min(cols - 1, colInRow2)), n2 + 1 + physRow2);
    } catch (err) {
      console.error('[FullscreenSession] cursor placement error:', err.message);
    }
  }

  // ── 滚动（查看历史）────────────────────────────────
  // 滚动：只改状态，渲染交给 _scheduleScrollRender 走轻量路径。
  //
  // 为什么单独开一条路径：滚动时 footer（活动看板/待办/补全/输入行/状态行）内容
  // 完全没变，只有 body 的可视窗口在动。但 refreshInput() 每次都会重算五块面板
  // + 输入区折行 + _fitPanels 裁剪，一次手指滑动 Termux 会连发十几个滚轮事件，
  // 即使 16ms 合帧，每帧仍在做这一整套无意义的重算 → 明显的滑动延迟卡顿。
  // 轻量路径复用上一帧算好的 footer，只做 render()，把每帧开销砍到只剩重绘。
  scrollUp(n = 3) { this.renderer.scrollBy(n); this._scheduleScrollRender(); }
  scrollDown(n = 3) { this.renderer.scrollBy(-n); this._scheduleScrollRender(); }
  scrollToBottom() { this.renderer.scrollToBottom(); this._scheduleScrollRender(); }

  // 滚动专用的合帧渲染：不重算 footer，只重绘 body。
  // footer 从没画过（刚启动就滑）时退化成完整 refreshInput，保证首帧正确。
  _scheduleScrollRender() {
    if (this._scrollTimer) return;
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null;
      if (!this.active) return;
      try {
        // footer 未初始化：必须走完整路径把面板算出来
        if (!this.renderer.footerLines || this.renderer.footerLines.length === 0) {
          this.refreshInput();
          return;
        }
        this.renderer.render();
        if (this.readline) this._placeInputCursor();
      } catch (err) {
        console.error('[FullscreenSession] scroll render error:', err.message);
      }
    }, 16);
    this._scrollTimer.unref?.();
  }

  clearBody() {
    this.renderer.clearBody();
    this.refreshInput();   // 内部含 render
  }
}
