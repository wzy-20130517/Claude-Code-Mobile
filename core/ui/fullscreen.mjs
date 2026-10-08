// 全屏渲染器：双缓冲 + diff + 光标路径优化
// 布局分三块（从上到下）：
//   header  固定，不滚动（欢迎页 / logo）
//   body    滚动区（对话内容），内容超出时自己往上滚
//   footer  固定在底部（输入框、状态行）
// 只把变化的格子写出去，输入框每帧画在同一位置 → 视觉上钉住。
//
// 与流式模式共存：由 index.mjs 按开关选择，默认不启用。

import stringWidth from 'string-width';
import { VScreen, CharPool, StylePool, diffEach } from './vscreen.mjs';

// body 保留的最大逻辑行数。超出后从头丢弃，避免长会话无限累积。
// 2 万行按平均每行 80 字算约 1.6MB 文本，向上回溯量也足够。
const MAX_BODY_LINES = 20000;

const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
// SGR 鼠标追踪。官方（src/ink/termio/dec.ts）开的是 1000+1002+1003+1006，
// 但那是桌面端假设 —— 有实体键盘，不靠点屏幕唤起输入法。
//
// Termux 触屏环境不能开 1002（拖动）和 1003（全部移动）：
// 它们让终端把整个屏幕当鼠标交互区，吞掉唤起软键盘的触摸手势
// （用户报告：点屏幕拉不起输入法，得长按粘贴才能唤出）。
//
// 只留 1000（按键/释放/滚轮）+ 1006（SGR 格式）：滚轮仍会作为鼠标事件上报，
// 不会被翻译成 ↑↓ 方向键去触发翻历史；普通点击照旧交给系统处理 → 输入法能唤起。
// 已开启 1000+1006：方向键翻历史，手指滑屏由滚轮事件滚动正文。
//
// 官方（src/ink/termio/dec.ts）开 1000+1002+1003+1006，那是桌面端假设：
// 有实体键盘，不靠点屏幕唤起输入法。
//
// Termux 触屏下实测：开任何鼠标模式（连最保守的 1000 也一样），点屏幕就唤不起
// 软键盘 —— 终端把触摸当鼠标事件上报给程序，而不是交给系统弹输入法。
// 用户只能长按粘贴文字才能把键盘弄出来。
//
// 开启 1000+1006 后，手指滑屏由 index.mjs 接收滚轮事件并滚动正文；↑↓ 由 readline 空处理，历史使用 Ctrl+P/N。
// 注意：部分 Termux 版本开启鼠标追踪后会影响点击唤起输入法。
const ENABLE_MOUSE = '';
const DISABLE_MOUSE = '';

export class FullscreenRenderer {
  constructor(options = {}) {
    this.out = options.out || process.stdout;
    this.charPool = new CharPool();
    this.stylePool = new StylePool();
    const { cols, rows } = this._size();
    // 双缓冲：front 是屏幕现状，back 是本帧要画的
    this.front = new VScreen(cols, rows, this.charPool, this.stylePool);
    this.back = new VScreen(cols, rows, this.charPool, this.stylePool);
    // 屏幕上光标的物理位置（我们自己维护，避免查询终端）
    this.curX = 0;
    this.curY = 0;
    // curStyleId 已废弃：样式状态改为 flush() 内的局部变量，每帧从零开始。
    // 保留字段只为兼容可能的外部读取；不要再用它做「跳过样式序列」的判断。
    this.curStyleId = 0;
    // 布局：header 固定行数，footer 固定行数，body 取剩余
    this.headerLines = [];
    // bodyPrefix：贴在 body **内容最前面**的块（欢迎页 / logo）。
    //
    // 【2026-09-19 加】对标官方（claude-code-main/components/Messages.tsx:678）：
    // Logo 是消息列表的**第一个兄弟节点**，随消息一起滚动，
    // 发第一条消息就被正文推上去、滚出视野（`renderRange[0] > 0` 时干脆不渲染）。
    //
    // 我们原来把它放在 headerLines（固定顶部不滚动），所以欢迎页一直悬浮 ——
    // 用户明确要求对齐官方：「官方的欢迎页会随着正文被推上去消失不见，
    // 我们的一直悬浮在这里」。
    //
    // 与 header 的区别：header 恒定占位、body 高度要减掉它；
    // bodyPrefix 属于滚动内容，**不占额外高度**，正文多了自然把它顶出去。
    this.bodyPrefix = [];
    this.footerLines = [];
    // body 是「逻辑行」数组，超出可视高度时只显示末尾部分（自动贴底）
    this.bodyLines = [];
    this.bodyScroll = 0;        // 0 = 贴底；>0 = 往上翻了几行
    this._openLine = false;     // 上一次 appendBody 是否未以换行结尾
    this._styleCarry = '';      // 跨行延续的 ANSI 样式（多行输出拆行后补到下一行）
    // 折行缓存：_wrappedBody() 原来每帧都把全部 bodyLines 重折一遍，
    // 而每帧只用到末尾几十行 —— 正文累积到几千行时单帧折行要上百毫秒，
    // 流式输出每个 token 触发一次 render，就成了肉眼可见的卡顿。
    // 这里缓存结果，只对新增的逻辑行做增量折行。
    this._liveStart = -1;       // 实时块起始下标（-1 = 无活动块）
    this._liveActive = false;
    this._wrapCache = [];       // 已折好的物理行
    this._wrapCacheCount = 0;   // 已折过的 bodyLines 条数
    this._wrapCacheCols = 0;    // 缓存对应的屏宽（变了要整体重折）
    // 每条逻辑行折出多少条物理行。原来只用一个 _lastWrapSpan 记「最后一条」，
    // 但流式输出会在两次 render 之间连续多次续接末行：第二次 _invalidateLastWrapped()
    // 拿到的 span 已被上一次置 0 → 一行都没截掉，_wrapCacheCount 却减了 1 →
    // 缓存里残留旧物理行、计数又偏小 → 下一轮从更早位置重折，把同一批内容
    // 再推一遍进缓存。表现就是「上一轮用户消息+thinking+回答整段重放且顺序错乱」。
    this._wrapSpans = [];
    this.active = false;
    this._pendingResize = null;
    this._rendering = false;
    // 渲染期间收到 resize 时的补偿标记（见 _handleResize / render 的注释）
    this._pendingResizeWhileRendering = false;
    this._onResize = () => this._handleResize();
  }

  _size() {
    return {
      cols: Math.max(20, this.out.columns || 80),
      rows: Math.max(6, this.out.rows || 24),
    };
  }

  /** 进入全屏：切 alternate screen，清屏，隐藏光标 */
  enter() {
    if (this.active) return;
    this.active = true;
    const { cols, rows } = this._size();
    this.front.reset(cols, rows);
    this.back.reset(cols, rows);
    this.curX = 0; this.curY = 0; this.curStyleId = 0;
    // ?1049h = 进 alternate screen（退出时主屏内容原样恢复）
    // 同时开鼠标跟踪，把滑屏/滚轮从「方向键」变成「鼠标事件」
    this.out.write(`${ESC}?1049h${ESC}2J${ESC}H${HIDE_CURSOR}${ENABLE_MOUSE}`);
    this.out.on?.('resize', this._onResize);
    this.render();
  }

  /** 退出全屏：恢复主屏，显示光标 */
  exit() {
    if (!this.active) return;
    this.active = false;
    this.out.off?.('resize', this._onResize);
    // 先关鼠标跟踪再退 alt screen，顺序反了会把跟踪状态留在主屏
    this.out.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${ESC}?1049l`);
  }

  _handleResize() {
    if (!this.active) return;
    // 【2026-09-20 修：渲染中不能直接丢弃 resize】
    // 原来这里是 `if (!this.active || this._rendering) return` ——
    // 渲染期间到达的 resize **整个被丢掉**，而 out.columns 已经变了：
    //   · front/back 缓冲仍是旧尺寸
    //   · 之后 refreshInput 按新 cols 算光标列 → 画到旧缓冲的错误位置
    // 用户看到的就是「拉起输入法时光标不对」（键盘弹出 = rows 变化 = resize），
    // 且键盘动画期间 resize 连发、撞上渲染中的概率很高。
    // 现在改成：正在渲染就打个标记，等这帧结束补做（不丢事件）。
    if (this._rendering) {
      this._pendingResizeWhileRendering = true;
      return;
    }
    // 立即重画一次，避免防抖期间画面消失（用户报告：拉输入法整个画面没了一大半）
    const { cols, rows } = this._size();
    if (this.front.width !== cols || this.front.height !== rows) {
      this.front.reset(cols, rows);
      this.back.reset(cols, rows);
      this.out.write(`${ESC}2J${ESC}H`);
      this.curX = 0; this.curY = 0; this.curStyleId = 0;
      this.render();
    }
    // 防抖最终确认：resize 会连发，只响应最后一次
    clearTimeout(this._pendingResize);
    this._pendingResize = setTimeout(() => {
      const { cols: c2, rows: r2 } = this._size();
      if (this.front.width !== c2 || this.front.height !== r2) {
        this.front.reset(c2, r2);
        this.back.reset(c2, r2);
        this.out.write(`${ESC}2J${ESC}H`);
        this.curX = 0; this.curY = 0; this.curStyleId = 0;
        this.render();
      }
      // render 结束时光标停在最后写入处（footer 最下面那条边框），
      // 必须通知上层重新定位到输入位置。Termux 上软键盘弹出/收起会改变 rows，
      // 每次都会走到这里 —— 不回调的话光标就卡在最后一行线上（用户报告）。
      try { this.onResized?.(); } catch {}
    }, 60);
  }

  // ── 内容设置 ──────────────────────────────────────
  setHeader(lines) { this.headerLines = Array.isArray(lines) ? lines : [lines]; }

  /**
   * 设置 body 前置块（欢迎页 / logo）。内容多了会随正文一起滚上去。
   * 传空数组 = 移除（例如用户已发过消息，不需要再显示欢迎页）。
   */
  setBodyPrefix(lines) {
    const next = Array.isArray(lines) ? lines : [lines];
    // 内容没变就不动 —— 吉祥物动画每 60ms 调一次，避免无谓的重折行缓存失效
    if (next.length === this.bodyPrefix.length && next.every((l, i) => l === this.bodyPrefix[i])) return;
    this.bodyPrefix = next;
    // 【清缓存必须同时重置 _wrapCacheCount！】
    // 踩过的坑（2026-09-20，用户报「发一条消息欢迎页和刚发的消息直接消失」）：
    // 只清了 _wrapCache/_wrapSpans，计数留在旧值（比如 50），
    // 而 _wrappedBody 的增量循环是 `for (i = _wrapCacheCount; i < bodyLines.length; i++)`
    // → 从 50 开始，bodyLines 只有 3 条 → **一条都不折** → 返回空缓存 → 屏幕全空。
    // 这个函数在「发消息 → dismissWelcome → setBodyPrefix([])」路径上被调用，
    // 所以现象是「一发消息正文就消失」。
    this._wrapCache = [];
    this._wrapCacheCount = 0;
    this._wrapSpans = [];
    this._liveStart = -1;
  }

  /** 当前是否显示了前置块（调用方据此决定要不要在发消息时清掉）。 */
  hasBodyPrefix() { return this.bodyPrefix.length > 0; }
  setFooter(lines) { this.footerLines = Array.isArray(lines) ? lines : [lines]; }
  /**
   * ── 实时块（live block）─────────────────────────────────
   * 固定高度的可替换视窗，用于流式显示「正在写的代码 / 命令输出」：
   * 每次更新都把上一次的内容整段换掉，而不是往下追加，
   * 所以视觉上是一个固定几行的窗口，新内容进、旧内容滚出去。
   *
   * 为什么不能用 appendBody 实现：它只会一直往下加，写 200 行文件就刷 200 行屏。
   * 也不能放 spinner —— spinner 是单行状态提示，塞不进多行代码。
   *
   * 实现方式是记住块的起始下标，更新时先把 bodyLines 截断回该下标再重写。
   */
  beginLiveBlock() {
    // 块必须从干净的行开始：上一次输出没换行就先补一个，
    // 否则截断时会把半行正文一起切掉。
    if (this._openLine) { this.appendBody('\n'); }
    this._liveStart = this.bodyLines.length;
    this._liveActive = true;
  }

  /**
   * 光标是否已在行首（即上次输出以换行结尾 / 还没输出过任何内容）。
   * 调用方据此决定要不要再补前导换行 —— 已在行首还补 '\n' 会多出一个空行，
   * 因为 appendBody('\n● ') 会 split 成 ['', '● ']，那个 '' 就是空行。
   */
  isAtLineStart() { return !this._openLine }

  /** 用新内容替换实时块。lines 是字符串数组，超出高度由调用方裁剪。 */
  updateLiveBlock(lines) {
    if (!this._liveActive) this.beginLiveBlock();
    const arr = Array.isArray(lines) ? lines : String(lines).split('\n');

    // 【距底增量 · 2026-09-29 与 appendBody 同步重写】
    // 旧实现用距顶锚定 + Math.max 钳制，在用户上翻后实时块增减行时会把视角
    // 拉动几行（见 appendBody 处的详细注释，同一根因）。改为测「修改前后总
    // 折行数之差 Δ」，bodyScroll += Δ 保持视角不动。bodyScroll=0 仍贴底跟随。
    const wasScrolled = this.bodyScroll > 0;
    const beforeLen = wasScrolled ? this._wrappedBody().length : 0;

    // 截回块起点，丢掉上一帧
    if (this.bodyLines.length > this._liveStart) {
      this.bodyLines.length = this._liveStart;
      // 只丢弃 _liveStart 之后失效的部分，保留前缀缓存。
      // 原来这里 `_wrapCache = []` 全清 → 下一帧重折全部 bodyLines，
      // 长会话上千行时单帧几百毫秒，而参数预览/输出窗每帧都调这里。
      this._truncateWrapCache(this._liveStart);
    }
    for (const l of arr) this.bodyLines.push(l);
    this._openLine = false;

    if (wasScrolled) {
      const after = this._wrappedBody();
      const delta = after.length - beforeLen;
      const max = Math.max(0, after.length - this._bodyHeight());
      this.bodyScroll = Math.min(max, Math.max(0, this.bodyScroll + delta));
    } else {
      this.bodyScroll = 0;
    }
  }

  /**
   * 结束实时块。keep=false 时连内容一起清掉（流式过程属于过渡状态，
   * 最终结果由工具结果行给出，留着是重复信息）。
   */
  endLiveBlock({ keep = false } = {}) {
    if (!this._liveActive) return;

    // 【2026-10-05 修：结束实时块时补偿 bodyScroll，否则视角被拉动】
    //
    // 症状：用户上翻脱离跟随后，流式输出结束 / 工具输出窗口收起那一刻，
    // 正文会「往上跳」几行（实时块占几行就跳几行）。
    //
    // 根因：下面 `bodyLines.length = _liveStart` 把实时块那几行删掉了，
    // 总行数减少 → render 里 `start = total - bodyH - bodyScroll` 的 total 变小
    // → 视角顶部行号前移 → 画面看起来往上跳。
    // bodyScroll 的定义是「距底几物理行」，总行数变了它必须等量补偿，
    // 视角才能定住 —— 这与 appendBody / updateLiveBlock 里的 delta 补偿是同一件事，
    // 但这两处都只在**内容增加**时补偿，删除路径漏了。
    //
    // 测法：上翻 5 行 → beginLiveBlock → 灌 4 行 → endLiveBlock
    //  修复前：视角从「第 31 行」跳到「第 27 行」（上移 4 行）
    //  修复后：保持「第 31 行」不动
    const wasScrolled = this.bodyScroll > 0;
    const beforeLen = wasScrolled ? this._wrappedBody().length : 0;

    if (!keep && this.bodyLines.length > this._liveStart) {
      this.bodyLines.length = this._liveStart;
      // 同 updateLiveBlock：局部失效，别把整个前缀缓存扔掉
      this._truncateWrapCache(this._liveStart);
    }
    this._liveActive = false;
    this._liveStart = -1;
    this._openLine = false;

    if (wasScrolled) {
      // 距底增量：Δ = 新总行数 − 旧总行数（负数 = 内容变少）。
      // 保持视角不动 = bodyScroll 加这个负数（即减少）。
      const after = this._wrappedBody();
      const delta = after.length - beforeLen;
      if (delta !== 0) {
        this.bodyScroll = Math.max(0, this.bodyScroll + delta);
      }
    }
  }

  setBody(lines) {
    this.bodyLines = Array.isArray(lines) ? lines : [lines];
    this._openLine = false;   // 整体替换后，下次 append 另起一行
    this._styleCarry = '';
    // 整体替换 → 折行缓存必须整体失效。
    // 行数可能与原来相同（如 ['aaa'] → ['aab']），
    // 光靠 _wrappedBody 里的长度比较发现不了，会导致渲染出旧内容。
    this._wrapCache = [];
    this._wrapCacheCount = 0;
    this._wrapSpans = [];
  }

  /**
   * 【2026-10-08 新增】上翻状态下的「编辑锚点」快照 —— 供
   * updateBodyLine / replaceBodyLines 补偿视角用（贴底时返回 null，零开销）。
   *
   * 快照三要素（都在修改前计算）：
   *   · editPos  修改点（第 idx 条逻辑行）在**折行后**的物理行号
   *   · start    当前视口顶部物理行号
   *   · total    当前总物理行数
   *
   * 【为什么要区分「修改点在视口上方 / 下方」】
   * 追加类操作（appendBody / updateLiveBlock）的修改点恒在末尾，无脑
   * scroll += Δ 就对了；但替换 / 改写类操作的修改点可以在视口上方
   * （工具结果写回工具行位置时，工具行常常在用户正在看的内容之上），
   * 两种情形规则相反：
   *   · 修改点在视口上方（editPos < start）：**不补偿** —— start 公式
   *     `total - bodyH - scroll` 里 total 增大 Δ 会让 start 同步后移 Δ，
   *     视口自动跟住原内容；补偿反而把视口往下推 Δ 行。
   *   · 修改点在视口内 / 下方（editPos >= start）：**补偿 scroll += Δ** ——
   *     修改点之后的内容被推走 Δ 行，不补偿视口就被拽走 Δ 行。
   *
   * @returns {{editPos:number,start:number,total:number}|null}
   */
  _editAnchorBefore(idx) {
    if (this.bodyScroll <= 0) return null;
    const wrapped = this._wrappedBody();   // 折行到最新，_wrapSpans 才有完整记录
    const total = wrapped.length;
    const start = Math.max(0, total - this._bodyHeight() - this.bodyScroll);
    const prefixLen = total - this._wrapCache.length;   // bodyPrefix 占的物理行
    let editPos = prefixLen;
    for (let i = 0; i < idx; i++) editPos += this._wrapSpans[i] || 0;
    return { editPos, start, total };
  }

  /**
   * 与 _editAnchorBefore 配对：修改完成后调用，按锚点决定是否补偿 bodyScroll。
   * anchor 为 null（贴底 / 无锚点）时什么都不做。
   */
  _compensateEdit(anchor) {
    if (!anchor) return;
    // 修改点在视口上方：total 增大 Δ 让 start 自动后移 Δ，视口已跟住原内容，
    // 补偿反而把视口往下推。直接返回（也省掉一次重折缓存）。
    if (anchor.editPos < anchor.start) return;
    const after = this._wrappedBody();
    const delta = after.length - anchor.total;
    if (delta === 0) return;
    const max = Math.max(0, after.length - this._bodyHeight());
    this.bodyScroll = Math.min(max, Math.max(0, this.bodyScroll + delta));
  }

  /**
   * 就地改写第 idx 条逻辑行（用于工具行变色：执行中灰 → 成功绿/失败红）。
   *
   * 【为什么需要】官方 ToolUseLoader.tsx:20 是
   *   `isUnresolved ? undefined : isError ? "error" : "success"`
   * 即工具行那个 ● 会随结果变色。我们原来是写完就不管（固定 dim），
   * 结果到了也没法回改那一行 —— 没有这个 API 就只能重画整段正文。
   *
   * 只失效这一行的折行缓存（含它之后的，因为 _wrapSpans 是按行下标对齐的，
   * 改动中间某行会让后面的 span 计数整体错位；保守起见截断到 idx）。
   * 工具行很短（不会折行），实际开销可忽略。
   *
   * @returns {boolean} 是否改成功（idx 越界返回 false）
   */
  updateBodyLine(idx, text, { expectContains = null } = {}) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.bodyLines.length) return false;
    // bodyLines 超过 MAX_BODY_LINES 时头部会被 splice 掉、行号整体前移 ——
    // 此时旧行号会指向别的行，靠内容校验挡住（工具名唯一性够用）。
    if (expectContains && !String(this.bodyLines[idx]).includes(expectContains)) return false;
    // 【2026-10-08 修：上翻时补偿视角】原来改写行数变化（如短行变超长行折行
    // 1→3 行）不补偿 bodyScroll，工具行变色时视角被拽几行。锚点判据见
    // _editAnchorBefore 的注释（修改点在视口上方时不能补偿）。
    const anchor = this._editAnchorBefore(idx);
    this.bodyLines[idx] = String(text);
    // 该行及其之后的折行缓存全部作废：下标对齐被破坏，必须从 idx 起重折。
    // （只影响尾部若干行，且工具行通常不折行，成本可忽略）
    this._truncateWrapCache(idx);
    this._openLine = false;
    this._compensateEdit(anchor);
    return true;
  }

  /** 当前 body 逻辑行数（上层记「工具行在第几行」用） */
  bodyLineCount() {
    return this.bodyLines.length;
  }

  /**
   * 用**多行**替换某一行（工具结果写回工具行位置用）。
   *
   * 【为什么需要】结果可能是多行（命令输出的尾部若干行），而
   * updateBodyLine 只支持单行替换。窗口机制（beginLiveBlock/updateLiveBlock）
   * 画出来的内容永远在 body 末尾，多工具并发时结果会全堆到最后，
   * 跟各自的工具行脱节（2026-10-03 用户截图反馈）。
   *
   * 调用方拿到 delta 后要**自行调整其它记录的行号**
   * （toolLineMap 里大于 idx 的 lineIdx/progressIdx 都要 += delta）。
   *
   * @returns {number|null} 新增行数（可正可负）；失败返回 null
   */
  replaceBodyLines(idx, lines, { expectContains = null } = {}) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.bodyLines.length) return null;
    if (expectContains && !String(this.bodyLines[idx]).includes(expectContains)) return null;
    const arr = Array.isArray(lines) ? lines.map(l => String(l)) : [String(lines)];
    const delta = arr.length - 1;
    // 【2026-10-08 修：上翻时补偿视角】工具结果写回（1 行 → 多行）改变总行数
    // 时不补偿 bodyScroll，视口被拽。锚点判据见 _editAnchorBefore 的注释
    // ——注意此处不能无脑 `bodyScroll += delta`：工具行在视口上方时，
    // 补偿反而把视口往下推（追加类操作无脑补偿是因为修改点恒在末尾）。
    const anchor = this._editAnchorBefore(idx);
    this.bodyLines.splice(idx, 1, ...arr);
    // 该行及其之后的折行缓存全部作废（下标对齐被破坏）
    this._truncateWrapCache(idx);
    this._openLine = false;
    this._compensateEdit(anchor);
    return delta;
  }

  /**
   * 追加内容。像终端一样处理换行：
   *   appendBody('a\n')  → 一行 'a'，下次追加另起一行
   *   appendBody('a')    → 一行 'a'，下次追加续在后面
   * 注意 'a\n'.split('\n') === ['a', '']，那个尾部空串是「换行标记」而不是
   * 一个新的空行，直接 push 会导致每行之间多一条空行。
   */
  appendBody(text) {
    const s = String(text);
    if (!s) return;
    const parts = s.split('\n');
    const endsWithNewline = parts[parts.length - 1] === '';
    if (endsWithNewline) parts.pop();     // 去掉换行标记，不是真的空行

    // 样式必须跨行延续。每行独立渲染，所以拆行后要把「当前活动样式」补到下一行开头，
    // 否则形如 "\x1b[2m第一行\n第二行\n第三行\x1b[0m" 的多行输出（工具结果常见）
    // 只有第一行是灰的，后面都用默认色（用户报告：只有第一行返回是灰色，后面偏白）。
    const styled = [];
    for (const part of parts) {
      // carry 是上一行结束时仍生效的样式（空 = 无样式）
      const line = this._styleCarry ? this._styleCarry + part : part;
      styled.push(line);
      this._styleCarry = trailingStyle(line);
    }

    // 【Sticky Scroll · 2026-09-29 重写为「距底增量」语义】
    //
    // 旧实现用「距顶锚定」：记 scrollAnchor=可视区顶行绝对行号，追加后反推
    // bodyScroll。两个缺陷导致「上滑脱离后视角仍被新内容拉动几行」（间歇）：
    //   ① Math.max(0, before.length - bodyH - bodyScroll) 在用户翻到接近
    //      顶部时把 anchor 钳成 0，反推丢失偏移 → 视角被拉。
    //   ② 末行改写（_openLine 续接）在算 before 之前就改了 bodyLines，
    //      改写新增的折行数没进锚点 → 恰好跨折行边界时视角被拉那几行
    //      （「有2行就被拉2行、不是每次都发生」正是这个——只在跨边界时触发）。
    //
    // bodyScroll 的定义本就是「距底几物理行」。用户上翻后，只要底部新增/
    // 改写产生了 Δ 个物理行，视角要保持不动就应 bodyScroll += Δ。直接测
    // 「修改前后总折行数之差」即为 Δ，不做距顶换算，天然避开上面两个坑。
    const wasScrolled = this.bodyScroll > 0;
    // 修改前的总物理行数（用户已上翻时才需要，省一次全量折行）
    const beforeLen = wasScrolled ? this._wrappedBody().length : 0;

    // 上一次没有以换行结尾 → 本次第一段续接到上一行
    if (this.bodyLines.length > 0 && this._openLine && styled.length) {
      // 末行被就地改写，它的折行结果失效（流式输出走的就是这条路径）
      this._invalidateLastWrapped();
      this.bodyLines[this.bodyLines.length - 1] += styled.shift();
    }

    for (const p of styled) this.bodyLines.push(p);
    // 下一次是否需要续接
    this._openLine = !endsWithNewline;

    if (wasScrolled) {
      // 距底增量：Δ = 新总行数 − 旧总行数（含末行改写带来的折行变化）。
      // 保持视角不动 = bodyScroll 增加 Δ。max 钳制仍需要（防越界）。
      const after = this._wrappedBody();
      const delta = after.length - beforeLen;
      const max = Math.max(0, after.length - this._bodyHeight());
      this.bodyScroll = Math.min(max, Math.max(0, this.bodyScroll + delta));
    } else {
      this.bodyScroll = 0;   // 贴底状态：继续跟随
    }
    // 上限保护：原来 bodyLines 无限增长，长会话下内存和折行缓存都会一直涨。
    // 保留最近 MAX_BODY_LINES 行（足够向上回溯），超出的从头丢弃。
    //
    // 【2026-09-15 修：溢出不再清空折行缓存】
    //
    // 原来这里直接把 _wrapCache 全清。看起来无害（缓存可以重建），实际是 O(n²) 陷阱：
    //   1. 溢出后 bodyLines.length 恒等于 MAX_BODY_LINES，而 _wrappedBody() 开头有
    //      `bodyLines.length < _wrapCacheCount → 全清缓存` 的保护，于是**每次 append**
    //      （流式输出时每 token 一次）都命中全清；
    //   2. 全清后下一帧 render 要对 MAX_BODY_LINES(2万) 行**整体重新折行**；
    //   3. 再加上 splice(0,n) 本身是 O(n) —— 一次 append 干两趟全量活。
    // 症状：长会话（7 万行）持续吃满 CPU，按任何键无响应（主线程全在折行里）。
    //
    // 正确做法跟 _truncateWrapCache 一致：前缀被丢掉多少条**逻辑行**，
    // 就把这些行对应的物理行从缓存头部等量砍掉。这样缓存计数与 bodyLines 同步，
    // 上面的「变短就全清」保护不会被误触发，增量折行继续生效。
    if (this.bodyLines.length > MAX_BODY_LINES) {
      const drop = this.bodyLines.length - MAX_BODY_LINES;
      // 【用 splice 而不是 copyWithin】—— 实测反直觉，别"优化"回去：
      //   copyWithin(0,1) x3000 (2万行) = 12917ms
      //   splice(0,1)     x3000 (2万行) =   332ms   ← 快 39 倍
      //   shift()         x3000 (2万行) =   516ms
      // V8 对 splice 的头部删除有专门优化；copyWithin 是逐元素拷贝，元素越多越慢。
      this.bodyLines.splice(0, drop);
      this._dropWrappedPrefix(drop);
      // 【2026-10-05 修：_liveStart 跟着前移】
      //
      // 截断从**头部**丢 drop 条逻辑行，所有行号整体前移 drop。
      // _liveStart（实时块起点下标）若不跟着减就指向错误位置。
      //
      // 【现实场景为什么仍要修】endLiveBlock 时实时块内容通常在 bodyLines 末尾
      // （工具执行阶段输出，中间不会插 appendBody），此时截断不会越过块起点，
      // 影响很小。但 updateLiveBlock 里 `bodyLines.length > _liveStart` 的
      // 截断判断依赖它 —— 块跨在截断边界上时（长会话 + 大量输出）会错位。
      //
      // 【公式说明】减 drop 是标准换算（行号整体前移）；上限钳到当前总长
      // （截断把块整个吞掉时，块内容已随头部丢弃，起点退化为末尾）。
      // ⚠ 别钳到 0 —— 那会让 endLiveBlock 把 [0, length) 全当块内容删掉。
      if (this._liveStart >= 0) {
        this._liveStart = Math.max(0, Math.min(this._liveStart - drop, this.bodyLines.length));
      }
    }
  }

  clearBody() {
    this.bodyLines = []; this.bodyScroll = 0; this._openLine = false; this._styleCarry = '';
    this._wrapCache = []; this._wrapCacheCount = 0; this._wrapSpans = [];
  }

  /** 往上翻 n 行（查看历史） */
  scrollBy(n) {
    const bodyH = this._bodyHeight();
    const max = Math.max(0, this._wrappedBody().length - bodyH);
    this.bodyScroll = Math.min(max, Math.max(0, this.bodyScroll + n));
  }
  scrollToBottom() { this.bodyScroll = 0; }

  _bodyHeight() {
    const { rows } = this._size();
    return Math.max(1, rows - this.headerLines.length - this.footerLines.length);
  }

  /**
   * 把逻辑行按屏宽折成物理行（带增量缓存）。
   *
   * 【bodyPrefix 的处理】前置块（欢迎页）折好后**拼在最前**，
   * 所以它随正文一起滚动 —— 正文多了自然把它顶出视野（对标官方行为）。
   * 折行缓存只缓存 bodyLines 部分，prefix 每次现折：
   * 它只有几十行、且几乎不变，现折的开销远小于维护两套缓存的复杂度。
   */
  _wrappedBody() {
    const { cols } = this._size();
    // 屏宽变了 → 缓存全部失效，整体重折
    if (cols !== this._wrapCacheCols) {
      this._wrapCache = [];
      this._wrapCacheCount = 0;
      this._wrapSpans = [];
      this._wrapCacheCols = cols;
    }
    // bodyLines 变短（clearBody / 截断）或最后一行被就地改写（_openLine 续接）
    // → 从安全点起重折。这里退一条重折，覆盖「末行被追加内容」的情况。
    if (this.bodyLines.length < this._wrapCacheCount) {
      this._wrapCache = [];
      this._wrapCacheCount = 0;
      this._wrapSpans = [];
    }
    // 只折新增部分，逐行记下各自占了几条物理行（不能只记最后一条）
    for (let i = this._wrapCacheCount; i < this.bodyLines.length; i++) {
      const chunks = wrapToWidth(this.bodyLines[i], cols);
      for (const c of chunks) this._wrapCache.push(c);
      this._wrapSpans[i] = chunks.length;
    }
    this._wrapCacheCount = this.bodyLines.length;
    if (this.bodyPrefix.length === 0) return this._wrapCache;
    // 前置块拼在最前。注意返回的是**新数组**，不能直接改 _wrapCache
    //（那是缓存本体，改了会污染下一帧）。
    const prefixWrapped = [];
    for (const line of this.bodyPrefix) {
      for (const c of wrapToWidth(line, cols)) prefixWrapped.push(c);
    }
    return prefixWrapped.concat(this._wrapCache);
  }

  /** 末行被就地修改后调用：丢弃该行的折行缓存，下次渲染重折它 */
  _invalidateLastWrapped() {
    if (this._wrapCacheCount === 0) return;
    const lastIdx = this._wrapCacheCount - 1;
    // 用【这一条逻辑行自己】记录的 span 截断。
    // 关键：连续两次失效（两次 render 之间多次续接末行，流式输出的常态）时，
    // 第二次仍能拿到正确 span；原来共用一个字段、失效后置 0，
    // 第二次就变成 n=0 不截行，但 _wrapCacheCount 照样减 1 → 缓存与计数错位，
    // 下一轮从更早位置重折 → 旧内容被重复推进缓存（整段重放）。
    const n = this._wrapSpans[lastIdx];
    if (n > 0) this._wrapCache.length = Math.max(0, this._wrapCache.length - n);
    this._wrapCacheCount = lastIdx;
    this._wrapSpans.length = lastIdx;   // 这条行的 span 记录一并作废
  }

  /**
   * 把折行缓存截断到「只保留前 keepCount 条逻辑行」。
   *
   * 【为什么需要它 —— 修卡顿】
   * updateLiveBlock / endLiveBlock 原来一律 `_wrapCache = []` 全清，
   * 下一帧就得把【全部】bodyLines 重折一遍。实测 wrapToWidth 单次 0.4~1ms，
   * 长会话正文上千行 → 单帧几百毫秒，而工具调用的参数预览/输出窗口每帧都调
   * updateLiveBlock，于是「按回车、调工具时卡一下」。
   *
   * 实际上截断只影响 _liveStart 之后的行，之前那些折好的物理行完全有效。
   * 这里按 span 逐条回退，只丢弃真正失效的部分，前缀缓存保留。
   */
  _truncateWrapCache(keepCount) {
    const keep = Math.max(0, Math.min(keepCount, this._wrapCacheCount));
    if (keep >= this._wrapCacheCount) return;   // 没有需要丢的
    let drop = 0;
    for (let i = keep; i < this._wrapCacheCount; i++) {
      const n = this._wrapSpans[i];
      if (n > 0) drop += n;
    }
    if (drop > 0) this._wrapCache.length = Math.max(0, this._wrapCache.length - drop);
    this._wrapCacheCount = keep;
    this._wrapSpans.length = keep;
  }

  /**
   * 从**头部**丢掉 n 条逻辑行对应的折行结果（bodyLines 溢出时用）。
   *
   * 跟 _truncateWrapCache 是镜像操作：那个从尾部回退，这个从头部前移。
   * 为什么不能沿用「全清」：见 append() 里溢出那段的注释 —— 会退化成 O(n²)。
   *
   * ⚠ _wrapSpans 是按**逻辑行下标**索引的（_wrapSpans[i] = 第 i 条逻辑行折出几条物理行）。
   *   头部裁掉 n 条后，剩下所有条目的下标都要减 n，否则：
   *     - 计数与实际错位 → _wrkedBody 的 `bodyLines.length < _wrapCacheCount` 判断失真
   *     - 后续增量折行会去读错位的 span，丢弃量算错 → 缓存里留下本不该有的旧物理行
   *   （症状同 _wrapSpans 注释里那条历史 bug：内容重放且顺序错乱）
   */
  _dropWrappedPrefix(n) {
    if (!(n > 0)) return;
    // 累计前 n 条逻辑行占了多少物理行
    let dropPhys = 0;
    for (let i = 0; i < n && i < this._wrapSpans.length; i++) {
      const c = this._wrapSpans[i];
      if (c > 0) dropPhys += c;
    }
    // _wrapCache 是 `let` 还是属性？它只在构造函数里初始化过，用可变数组操作即可
    if (dropPhys > 0) this._wrapCache.splice(0, dropPhys);
    if (this._wrapSpans.length > 0) {
      // 同样用 splice（copyWithin 在大数组上慢 39 倍，见 appendBody 里的实测数据）
      this._wrapSpans.splice(0, Math.min(n, this._wrapSpans.length));
    }
    this._wrapCacheCount = Math.max(0, this._wrapCacheCount - n);
  }

  // ── 渲染 ──────────────────────────────────────────
  /** 把当前内容画进 back，diff 后只输出变化 */
  /**
   * 把当前内容画进 back，diff 后只输出变化。
   * @returns {boolean} 是否真的渲染了。被 _rendering 重入锁挡掉时返回 false ——
   *   调用方必须据此跳过光标定位，否则会拿「新算出来的位置」去定位「还没更新的画面」，
   *   表现为光标偶发落在字符身上/错行（用户反复报的老问题，只在渲染重入时出现，所以很偶发）。
   */
  render() {
    if (!this.active || this._rendering) return false;
    this._rendering = true;
    try {
    const { cols, rows } = this._size();
    if (this.back.width !== cols || this.back.height !== rows) {
      this.back.reset(cols, rows);
    } else {
      this.back.reset();
    }

    let y = 0;
    // header（固定顶部）
    for (const line of this.headerLines) {
      if (y >= rows) break;
      this.back.writeText(0, y, line);
      y++;
    }
    // body（滚动区，贴底显示）
    const bodyH = this._bodyHeight();
    // 【跳行修复，对标官方 2.1.265】footer 行数变化（补全面板/看板开合、软键盘
    // resize）会改变 bodyH。用户上翻时（bodyScroll>0），视口顶部行号
    // start = total - bodyH - scroll 会随 bodyH 漂移 → 内容瞬移。
    // 补偿：bodyH 变化量等量加到 scroll，让 start 保持不动。贴底（scroll=0）不受影响。
    if (this._lastBodyH !== undefined && this._lastBodyH !== bodyH && this.bodyScroll > 0) {
      this.bodyScroll += this._lastBodyH - bodyH;
      if (this.bodyScroll < 0) this.bodyScroll = 0;
    }
    this._lastBodyH = bodyH;
    const wrapped = this._wrappedBody();
    const start = Math.max(0, wrapped.length - bodyH - this.bodyScroll);
    const slice = wrapped.slice(start, start + bodyH);
    for (let i = 0; i < bodyH; i++) {
      if (y >= rows) break;
      if (i < slice.length) this.back.writeText(0, y, slice[i]);
      y++;
    }
    // footer（固定底部）
    //
    // 【2026-09-20 修：与 placeCursor 对齐】原来无条件从 footerLines[0] 开始画，
    // footer 比屏幕高时超出部分被 `y >= rows` 丢掉 —— 丢的是**末尾**（输入框和边框），
    // 而输入框恰好在末尾。现在改成：溢出时丢**开头**（看板/待办那些），保住输入区。
    // 截断行数必须与 placeCursor 用同一个公式，否则光标又指偏。
    const footerLen = this.footerLines.length;
    // 视口顶部：默认保住末尾；光标在截掉区时跟随光标（见 _footerViewportTop）。
    // 这里必须和 placeCursor 用同一个函数，否则画的和光标指的又不是一个地方。
    const clipTop = this._footerViewportTop(rows, footerLen, this._pendingFooterRow ?? -1);
    const visibleFooter = clipTop > 0 ? this.footerLines.slice(clipTop) : this.footerLines;
    const footerStart = Math.max(y, rows - footerLen);
    y = footerStart;
    for (const line of visibleFooter) {
      if (y >= rows) break;
      this.back.writeText(0, y, line);
      y++;
    }

    // 【2026-09-27 修卡死：去掉「标整屏」】
    //
    // 原来这里写的是：
    //   this.back.damage = { x0:0, y0:0, x1:cols-1, y1:rows-1 };
    // 理由是「writeText 只 touch 有内容的格子，所以上一帧有字、本帧没字的位置
    // 扫不到 → 旧字符残留」。
    //
    // 但那个兜底代价太大：**每帧扫全屏**（80×45 = 3600 格）。
    // 流式输出每 token 触发一次 render，于是单帧 30~50ms，事件循环被占满，
    // 用户报「Responding… 又卡死了」。
    //
    // 【实测证据】render-slow.log（正文涨到 5000+ 行时）：
    //   单次31ms render=30  /  单次44ms render=43
    //   —— 耗时几乎全在 render（即 flush 的全屏 diff）
    //   freeze.log 同时段：卡死 3881ms / 4222ms，RSS 327~503MB
    //   （freeze.log 已于 2026-10-03 随卡死检测功能删除，此处为历史记录）
    //
    // 【为什么删掉是安全的】漏擦的担忧**已经被现有机制覆盖**：
    //   · flush() 末尾把 back 换给 front 时**故意不清 damage**
    //     （源码注释：「它记录屏幕上哪些格子被写过」）
    //   · diffEach(prev=front, next=back) 取 **两者的 damage 并集**
    //   · 所以「上一帧写过、本帧没写」的格子本来就在范围里，不会漏擦
    // 这行 `damage = 整屏` 是在已有机制之上做的冗余兜底 —— 也正是它把
    // 每帧成本从「实际改动范围」抬成了「整屏」。

    this.flush();
    } finally {
      this._rendering = false;
      // 【2026-09-20】渲染期间到达的 resize 不能丢（见 _handleResize 的注释）：
      // 键盘弹出/收起时 resize 连发，若恰好撞上渲染中，旧代码会把事件整个丢掉，
      // 导致缓冲尺寸与 out.columns 不一致 → 光标画错位。
      // 这里在这一帧收尾后补做一次（用微任务，让上层 render 调用栈先退干净）。
      if (this._pendingResizeWhileRendering) {
        this._pendingResizeWhileRendering = false;
        Promise.resolve().then(() => {
          try { this._handleResize(); } catch {}
        });
      }
    }
    return true;
  }

  /** diff front→back，输出最小 ANSI 序列，然后交换缓冲 */
  flush() {
    let buf = '';
    let lastY = -1;
    let lastX = -1;
    // 样式状态【每帧从零开始】。这是颜色污染的根因：
    // curStyleId 原来是实例字段跨帧保留，但上一帧末尾已经发过 \x1b[0m 把终端复位了，
    // 两者不一致 → 本帧第一个格子若 styleId 恰好等于残留的 curStyleId 就不发样式序列，
    // 于是继承了终端的实际状态（比如欢迎页底部那行的橙色）。
    // 表现：用户消息变橙、工具输出变橙、输入框上边染上背景色。
    let curStyle = 0;
    diffEach(this.front, this.back, (x, y, cell) => {
      // w===0 有两种含义，必须区分：
      //   charId===1 → 宽字符的右半续格，跟着左格一起画，跳过
      //   charId===0 → 未写格子（reset 后全零），必须输出空格把旧字符擦掉
      // 之前一律 return，导致擦除字符根本没发出去 —— 虚拟屏幕算对了但屏幕上留着旧字，
      // 而且能被新输入覆盖（用户报告的现象）。
      if (cell.w === 0 && cell.charId === 1) return;
      // 光标移动：同行连续则不发序列，靠自然前进
      const jumped = y !== lastY || x !== lastX;
      if (jumped) {
        buf += `${ESC}${y + 1};${x + 1}H`;
      }
      const styleId = cell.styleId;
      // 光标跳转后必须【强制重发】样式：跳过的那些格子可能有别的颜色，
      // 终端的当前样式已经不是我们记录的 curStyle 了。
      // 只在同行连续写入时才能省略样式序列。
      if (styleId !== curStyle || jumped) {
        buf += styleId === 0 ? `${ESC}0m` : `${ESC}0m${this.stylePool.get(styleId)}`;
        curStyle = styleId;
      }
      const ch = cell.charId === 0 ? ' ' : this.charPool.get(cell.charId);
      buf += ch;
      lastY = y;
      lastX = x + (cell.w === 2 ? 2 : 1);
    });
    if (buf) {
      // 帧末【无条件】复位：不能依赖 curStyle 判断，因为下一帧要从干净状态开始。
      // 漏掉这个 \x1b[0m 的话，样式会渗到 placeCursor 之后用户输入的字符上。
      buf += `${ESC}0m`;
      this.out.write(buf);
    }
    // back → front，复用旧 front 当下一帧的 back（避免每帧分配）
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
    // 不能清 front.damage！它记录「屏幕上哪些格子被写过」，
    // 下一帧 diff 要靠它才能发现「本帧没写、但上帧有内容」的格子（比如退格删掉的字符）。
    // 清掉的话 diff 范围只覆盖新内容，旧字符永远留在屏幕上（用户报告「退格后字还在」）。
  }

  /**
   * 把光标放到 footer 里的指定位置（输入框光标）。
   *
   * 【2026-09-20 修：多行输入时光标跑到屏幕外】
   * 用户报「输入框里打了非常多行就无法正常打字，因为光标位置不对」。
   *
   * 根因：这里原来算的是 `y = rows - footerLines.length + footerRow`，
   * 而 footer 比屏幕高时（输入很多行）这个值**是负数**，
   * 写出的定位序列 `ESC[负数;列H` 是无效的 —— 终端会忽略或乱跳。
   *
   * 更麻烦的是**绘制那边是另一个公式**：
   *     footerStart = Math.max(y, rows - footerLines.length)   // 先 Math.max 再画
   * 两处不一致 → 画出来的位置和光标指的位置不是一个地方。
   *
   * 修法：两处统一 —— footer 顶部行 = max(0, rows - footerLen)，
   * 并且当 footer 溢出屏幕时，**只画末尾 rows 行**（底部优先，因为输入框在末尾），
   * 光标也跟着这个截断后的坐标系走。
   */
  placeCursor(col, footerRow = 0) {
    if (!this.active) return;
    const { rows } = this._size();
    const footerLen = this.footerLines.length;
    // 溢出的行数 = 顶部被截掉多少行
    const clipped = Math.max(0, footerLen - rows);
    const y = Math.max(0, rows - footerLen) + (footerRow - clipped);
    // 光标所在行正好落在被截掉的区域里（用户翻上去改前面几行）→
    // 这时不能简单隐藏光标（用户就看不见自己在哪了），
    // 而是**让 footer 视口跟随光标滚动** —— 见 _footerViewportTop。
    if (y < 0 || y >= rows) {
      const vp = this._footerViewportTop(rows, footerLen, footerRow);
      const y2 = Math.max(0, rows - footerLen) + (footerRow - vp);
      if (y2 < 0 || y2 >= rows) { this.out.write(HIDE_CURSOR); return; }
      this.out.write(`${ESC}${y2 + 1};${col + 1}H${SHOW_CURSOR}`);
      this.curX = col;
      this.curY = y2;
      return;
    }
    this.out.write(`${ESC}${y + 1};${col + 1}H${SHOW_CURSOR}`);
    this.curX = col;
    this.curY = y;
  }

  /**
   * footer 视口顶部行号（考虑光标跟随）。
   *
   * 默认策略是「保住末尾」（输入框在最下面，用户正在敲的就是它）。
   * 但当**光标本身**在被截掉的区域里时，保住末尾就等于把光标藏起来 ——
   * 用户翻上去改第 3 行，屏幕上却看不到光标，完全没法编辑。
   *
   * 所以：光标可见就按末尾截；光标不可见就把视口挪到以光标为中心。
   */
  _footerViewportTop(rows, footerLen, footerRow) {
    const clipped = Math.max(0, footerLen - rows);
    if (footerRow >= clipped) return clipped;          // 光标在可见区，保持末尾对齐
    // 光标在截掉区 → 视口上移，让光标落在可视区中部
    const want = Math.max(0, Math.min(footerRow - Math.floor(rows / 2), clipped));
    return want;
  }

  hideCursor() { if (this.active) this.out.write(HIDE_CURSOR); }
}

/**
 * 算出一行文本结束时仍然生效的 ANSI 样式序列。
 * 用于多行文本拆行后把样式带到下一行 —— 每行独立渲染，不补就会丢样式。
 * 规则：从左到右扫，遇到 \x1b[0m（或 \x1b[m）清空累积，其他 SGR 序列追加。
 */
export function trailingStyle(line) {
  const s = String(line ?? '');
  let active = '';
  for (const m of s.matchAll(/\x1b\[[0-9;]*m/g)) {
    const seq = m[0];
    if (/^\x1b\[(0)?m$/.test(seq)) active = '';   // 复位
    else active += seq;
  }
  return active;
}

/**
 * 按显示宽度折行，保留 ANSI 样式跨行延续。
 * 宽度必须用 string-width 算，和 VScreen.writeText 保持一致——
 * 两边口径不同会导致「折行位置对不上」，画出来错位。
 */
// 【为什么这一处不收口到 core/width.mjs】（2026-08-30 核实，别"顺手统一"）
// 宽度计算已统一到 width.mjs，但**这个函数不能替换**：它比 width.wrapToWidth
// 多做一件必须的事 —— `activeStyle` 跟踪，折行时把当前 ANSI 样式继承到新行。
// 实测对比（cols=10，输入 "\x1b[31m" + 15个x + 5个y）：
//   本实现     → ["\x1b[31mxxxxxxxxxx", "\x1b[31mxxxxxyyyyy"]  颜色延续 ✓
//   width 版   → ["xxxxxxxxxx", "xxxxxyyyyy"]                   样式全丢 ✗
// 全屏界面每一行都是带色的，换成 width 版会让整个界面颜色消失。
// 若将来要统一，必须先给 width.wrapToWidth 加样式继承能力，并有测试覆盖。
/**
 * 单字符宽度的快速判定。
 *
 * 为什么不直接用 string-width：它是为**整串**设计的，内部要做正则扫描、
 * 变体选择符处理、Intl 查询等。逐字符调用时这些开销全都要付一遍
 * （实测 38 万次 = 2803ms，占折行总耗时的 71%）。
 *
 * 这里只覆盖常见区间，命中就返回；**未命中的一律回退 string-width**，
 * 所以正确性不依赖这张表是否完整（emoji、罕见组合字符走回退）。
 */
/** charWidthFast 的回退结果缓存（码点索引；-1 = 未算过） */
const _CW_CACHE = new Int8Array(0x10000).fill(-1);

function charWidthFast(cp, ch) {
  // ASCII 可打印 0x20-0x7E：宽度 1（最高频，放最前）
  if (cp >= 0x20 && cp <= 0x7e) return 1;
  // 控制字符（含 \x00-\x1f、DEL）：不占列
  if (cp < 0x20 || cp === 0x7f) return 0;
  // 常见宽字符区间（东亚）：宽度 2
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK 部首扩展、日文标点
    (cp >= 0x3041 && cp <= 0x33ff) ||   // 平假名/片假名/注音/CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) ||   // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK 扩展 B~F
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) return 2;
  // 组合用附加符号：不占列
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  // 零宽字符
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  // 其余（emoji、罕见字符等）回退到 string-width，保证正确。
  // 【2026-09-26 加缓存】这里原来每次直接调库。上面的区间表已覆盖中日韩，
  // 所以走这条回退的通常只有 emoji 和罕见字符 —— 但它们在聊天里出现频率
  // 其实不低（用户消息里的表情），而 stringWidth 逐字符调用要跑正则。
  // 折行是每帧都跑的路径，顺手缓存掉（BMP 内可缓，超出 BMP 的直接调）。
  if (cp < 0x10000) {
    const hit = _CW_CACHE[cp];
    if (hit !== -1) return hit;
    let w;
    try { w = stringWidth(ch); } catch { w = cp > 0xff ? 2 : 1; }
    _CW_CACHE[cp] = w <= 127 ? w : 1;
    return w;
  }
  try { return stringWidth(ch); } catch { return cp > 0xff ? 2 : 1; }
}


/**
 * 不含任何 ANSI 转义的行的折行快路径。
 * 语义与 wrapToWidth 的主循环一致（含宽字符、零宽字符处理），
 * 只是省掉了 SGR 状态机 —— 不带转义时那套状态机是纯开销。
 */
function wrapPlainToWidth(s, width) {
  const out = [];
  let cur = '';
  let curW = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const w = charWidthFast(cp, ch);
    if (w <= 0) { cur += ch; continue; }   // 零宽字符不占列
    if (curW + w > width) {
      out.push(cur);
      cur = '';                            // 无转义 → 新行不需要继承样式
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  out.push(cur);
  return out;
}

export function wrapToWidth(line, width) {
  const s = String(line ?? '');
  if (!s) return [''];
  // ── 快路径：整行没有 SGR 转义 ────────────────────────────────
  //
  // 逐字符调用 stringWidth 是折行的主要开销（实测 2 万行 3924ms，
  // 其中 2803ms = 71% 花在 38 万次单字符调用上）。而**绝大多数行不含
  // 任何 ANSI 转义**（普通正文、工具输出）—— 这类行不需要逐字符走状态机，
  // 可以直接按字符串切片折行，stringWidth 整行只需调一次。
  //
  // 判据用 indexOf('\x1b') 而不是正则：字符串扫描比正则快一个量级，
  // 且这是每帧对每行都要跑的路径。
  if (s.indexOf('\x1b') === -1) return wrapPlainToWidth(s, width);
  const out = [];
  let cur = '';
  let curW = 0;
  // 【SGR 按语义合并】activeStyle 必须拆 fg / bg / attrs 三分量跟踪。
  //
  // 原来实现是 `activeStyle = 最后一串` —— 整串覆盖。遇到
  //   \x1b[48;2;55;55;55m ❯ \x1b[39m 正文…[折行]…\x1b[0m
  // 这种「背景 + 前景复位 + 文字」的结构时，39m 把整个 activeStyle 换掉，
  // 折出来的第二行只有 39m、背景丢了 →
  // 用户消息很长自动折行时**只有第一行有底**（用户 2026-09-14 报）。
  //
  // 根因同源：这是 9-13 修「分段上色但共享背景」那次在 vscreen.writeText 里
  // 已经修过的东西 —— 全屏折行这处用的是另一套独立实现，被漏掉了。
  // 为了不漂移，直接复用 VScreen._mergeSgr（同一个语义实现），不要自己再写一份。
  //
  // 【attrs 必须一起跟踪，不能省】
  // 第一版修复只跟踪了 fg/bg，addAttr/delAttr/clearAttrs 写成空函数。
  // 结果：思考文本的 `2`（暗色）在续行丢失 → 同一色值满亮度显示，
  // 看着比第一行亮（用户 2026-09-14 截图为证）。
  // 真实场景里 dim/italic 是「语义性」样式（思考区、次要信息），
  // 丢了不只是难看，而是视觉分层被破坏。
  let curFg = '', curBg = '';
  const curAttrs = new Set();
  const setActiveStyle = () => {
    const parts = [...curAttrs].sort((a, b) => a - b);
    let seq = '';
    if (parts.length) seq += `\x1b[${parts.join(';')}m`;
    if (curFg) seq += curFg;
    if (curBg) seq += curBg;
    return seq;
  };
  const feedStyle = (seq) => {
    VScreen._mergeSgr(seq, {
      setFg: (v) => { curFg = v },
      setBg: (v) => { curBg = v },
      addAttr: (n) => { curAttrs.add(n) },
      delAttr: (n) => { curAttrs.delete(n) },
      clearAttrs: () => { curAttrs.clear() },
    });
  };
  let activeStyle = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        cur += m[0];
        if (/^\x1b\[(0)?m$/.test(m[0])) { curFg = ''; curBg = ''; curAttrs.clear(); activeStyle = ''; }
        else { feedStyle(m[0]); activeStyle = setActiveStyle(); }
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    // 用 charWidthFast 而非直接 stringWidth：单字符调用 stringWidth 开销大
    //（见函数注释），快表命中常见字符，未命中自动回退。
    const w = charWidthFast(cp, ch);
    if (w <= 0) { cur += ch; continue; }     // 零宽字符不占列
    if (curW + w > width) {
      out.push(cur);
      cur = activeStyle;      // 新行继承样式（含背景）
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  out.push(cur);
  return out;
}
