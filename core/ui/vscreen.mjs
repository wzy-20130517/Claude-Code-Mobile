// 虚拟屏幕：内存里的字符网格，配合 diff 只重画变化的格子。
// 设计参考 Claude Code 自带的 Ink 分支（src/ink/screen.ts）：
//   - 单元格打包进定型数组，比较整数而不是字符串
//   - 字符 intern 成整数 ID（共享池，跨屏有效）
//   - damage 矩形限定 diff 范围，不扫全屏
// 但不引入 React/flexbox：我们只需要「滚动区 + 底部固定区」两块布局。

import stringWidth from 'string-width';

// 每格 2 个 Int32：[charId, packed]
// packed = styleId << 2 | width（width 0=续格 1=窄 2=宽）
const WORDS_PER_CELL = 2;
const WIDTH_MASK = 0b11;

/**
 * 字符宽度缓存 —— 【永久卡死的根因修复，2026-09-26】
 *
 * ═══════════════════════════════════════════════════════════════
 * 【症状】终端彻底卡死，Ctrl+C 无效，只能大退；有时卡几小时。
 * 只在「* Responding… 刚出字」时发生 —— 那正是开始流式渲染正文的时刻。
 *
 * 【实测数据（tests/writetext-perf.test.mjs）】
 *   writeText 写 45 行（一屏正文）：
 *     中文 66.9ms     ← 每帧 67ms
 *     ASCII  2.0ms    ← 33 倍差距
 *   单字符 stringWidth 调用：
 *     中文 0.99ms/100 字符（每个 0.01ms）
 *     ASCII 0.087ms/100 字符（快 11 倍）
 *
 * 【为什么会卡死，而不是「有点卡」】
 * setSpinner 的定时器每 120ms 重画一次 footer（fullscreen-adapter
 * 的 _ensureSpinnerTimer）。中文界面下单帧 67ms → 光是 spinner 就吃掉
 * 56% CPU。而此时模型还在流式吐字，每个 token 又触发一次 onText → 渲染。
 * 于是：渲染慢 → 事件循环积压 → 更多待处理事件 → 更慢 —— 正反馈雪崩，
 * 事件循环再也排不到按键处理，Ctrl+C 自然无效（它不是被"忽略"，
 * 是压根轮不到执行）。
 *
 * 【为什么可以缓存】
 * 字符的显示宽度是由 Unicode 属性决定的**纯函数**，与上下文无关：
 * 汉字/全角标点恒为 2，ASCII 恒为 1，组合符恒为 0。
 * string-width 内部要跑正则 + 查表，而正文里同一个字会重复出现成百上千次
 * （常用汉字几百个，却要按字符数调用几万次）。
 *
 * 【实现选择】用 Int8Array 按码点直接索引，而不是 Map：
 *   直接调 stringWidth   1.670ms
 *   Map 缓存             0.231ms
 *   码点数组缓存         0.070ms  ← 快 24 倍
 * BMP 内（<0x10000）覆盖全部中日韩常用字；超出 BMP 的（emoji、生僻字）
 * 退回直接调用 —— 那些本来就要走代理对处理，且出现频率低。
 */
const WIDTH_CACHE = new Int8Array(0x10000).fill(-1);

/** 取字符显示宽度（带码点缓存） */
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x10000) {
    const hit = WIDTH_CACHE[cp];
    if (hit !== -1) return hit;
    let w;
    try { w = stringWidth(ch); } catch { w = 1; }
    // Int8Array 存得下 0/1/2；异常宽度（>127）不该出现，夹一下防越界
    WIDTH_CACHE[cp] = w <= 127 ? w : 1;
    return w;
  }
  try { return stringWidth(ch); } catch { return cp > 0xff ? 2 : 1; }
}

/** 字符池：把字符映射成整数 ID，diff 时比较整数 */
export class CharPool {
  constructor() {
    this.strings = [' ', ''];        // 0=空格 1=宽字符的占位续格
    this.map = new Map([[' ', 0], ['', 1]]);
    this.ascii = new Int32Array(128).fill(-1);
    this.ascii[32] = 0;              // 空格
  }
  intern(ch) {
    if (ch.length === 1) {
      const code = ch.charCodeAt(0);
      if (code < 128) {
        const hit = this.ascii[code];
        if (hit !== -1) return hit;
        const id = this.strings.length;
        this.strings.push(ch);
        this.ascii[code] = id;
        return id;
      }
    }
    const hit = this.map.get(ch);
    if (hit !== undefined) return hit;
    const id = this.strings.length;
    this.strings.push(ch);
    this.map.set(ch, id);
    return id;
  }
  get(id) { return this.strings[id] ?? ' '; }
}

/** 样式池：把 ANSI 序列（如 "\x1b[31m"）映射成整数 ID */
export class StylePool {
  constructor() {
    this.styles = [''];              // 0 = 无样式
    this.map = new Map([['', 0]]);
  }
  intern(seq) {
    if (!seq) return 0;
    const hit = this.map.get(seq);
    if (hit !== undefined) return hit;
    const id = this.styles.length;
    this.styles.push(seq);
    this.map.set(seq, id);
    return id;
  }
  get(id) { return this.styles[id] ?? ''; }
}

export class VScreen {
  constructor(width, height, charPool = new CharPool(), stylePool = new StylePool()) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.charPool = charPool;
    this.stylePool = stylePool;
    this.cells = new Int32Array(this.width * this.height * WORDS_PER_CELL);
    // damage：本帧写过的最小包围盒，diff 只看这块
    this.damage = null;
  }

  /** 重置为全空，保留池（ID 跨帧有效） */
  reset(width = this.width, height = this.height) {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.cells = new Int32Array(width * height * WORDS_PER_CELL);
    } else {
      this.cells.fill(0);
    }
    this.damage = null;
  }

  _idx(x, y) { return (y * this.width + x) * WORDS_PER_CELL; }

  _touch(x, y) {
    if (!this.damage) { this.damage = { x0: x, y0: y, x1: x, y1: y }; return; }
    const d = this.damage;
    if (x < d.x0) d.x0 = x;
    if (y < d.y0) d.y0 = y;
    if (x > d.x1) d.x1 = x;
    if (y > d.y1) d.y1 = y;
  }

  /** 写一个格子。width: 1=窄 2=宽 0=宽字符的右半续格 */
  setCell(x, y, charId, styleId, w) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = this._idx(x, y);
    this.cells[i] = charId;
    this.cells[i + 1] = (styleId << 2) | (w & WIDTH_MASK);
    this._touch(x, y);
  }

  getCell(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return { charId: 0, styleId: 0, w: 1 };
    }
    const i = this._idx(x, y);
    const packed = this.cells[i + 1];
    return { charId: this.cells[i], styleId: packed >>> 2, w: packed & WIDTH_MASK };
  }

  /**
   * 把一串 SGR 拆成 { fg, bg, attrs }。
   * fg/bg 存的是**完整子序列**（如 '\x1b[38;2;80;80;80m'），拼回时直接用；
   * attrs 存数字码（1 粗 / 2 暗 / 3 斜 / 4 下划线 / 7 反显 / 9 删除线）。
   */
  static _parseSgr(seq) {
    const fgBg = { fg: '', bg: '', attrs: new Set() };
    VScreen._mergeSgr(seq, {
      setFg: (v) => { fgBg.fg = v },
      setBg: (v) => { fgBg.bg = v },
      addAttr: (n) => fgBg.attrs.add(n),
      delAttr: (n) => fgBg.attrs.delete(n),
      clearAttrs: () => fgBg.attrs.clear(),
    });
    return fgBg;
  }

  /**
   * 解析一串（可能含多个 \x1b[..m）SGR，按语义回调。
   *
   * 覆盖的码：
   *   0        全清（由调用方处理，这里不管）
   *   1/2/3/4/7/9        开属性      21/22/23/24/27/29  关属性
   *   30-37 / 90-97      前景基础色  39  还原默认前景
   *   40-47 / 100-107    背景基础色  49  还原默认背景
   *   38;5;n / 38;2;r;g;b   前景 256/truecolor
   *   48;5;n / 48;2;r;g;b   背景 256/truecolor
   *
   * ⚠ 38/48 是**多参数**码，必须整段消费掉，否则后面的 r/g/b 数字
   *   会被当成独立 SGR 码解析（2 会被当"暗色"属性、5 被当"闪烁"）。
   */
  static _mergeSgr(seq, cb) {
    const ATTR_ON = new Set([1, 2, 3, 4, 7, 9]);
    // ⚠ 22 不在这张表里：按终端标准它同时关粗体(1)和暗色(2)，单独处理。
    //   第一版把 22:2 写进表里，于是下面 ATTR_OFF 分支先命中并 continue，
    //   专门处理 22 的那行成了死代码 —— 粗体永远关不掉。
    const ATTR_OFF = { 21: 1, 23: 3, 24: 4, 27: 7, 29: 9 };
    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(seq))) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) { cb.clearAttrs(); cb.setFg(''); cb.setBg(''); continue; }
        if (ATTR_ON.has(c)) { cb.addAttr(c); continue; }
        // 22 同时关粗体和暗色（终端惯例）—— 必须排在 ATTR_OFF 之前判，
        // 否则若表里含 22 就会被抢先命中
        if (c === 22) { cb.delAttr(1); cb.delAttr(2); continue; }
        if (ATTR_OFF[c] !== undefined) { cb.delAttr(ATTR_OFF[c]); continue; }
        if (c === 39) { cb.setFg(''); continue; }
        if (c === 49) { cb.setBg(''); continue; }
        if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) { cb.setFg(`\x1b[${c}m`); continue; }
        if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) { cb.setBg(`\x1b[${c}m`); continue; }
        if (c === 38 || c === 48) {
          const set = c === 38 ? cb.setFg : cb.setBg;
          const mode = codes[i + 1];
          if (mode === 5) {              // 256 色：38;5;n
            set(`\x1b[${c};5;${codes[i + 2] ?? 0}m`);
            i += 2;
          } else if (mode === 2) {       // truecolor：38;2;r;g;b
            set(`\x1b[${c};2;${codes[i + 2] ?? 0};${codes[i + 3] ?? 0};${codes[i + 4] ?? 0}m`);
            i += 4;
          }
          continue;
        }
      }
    }
  }

  /**
   * 在 (x,y) 写一段带 ANSI 的文本，自动处理宽字符与折行截断。
   * 返回写完后的下一列位置。不换行——调用方自己决定分行。
   *
   * 【SGR 按语义合并，不是整串替换】
   * 原来每遇到一个转义序列就 `styleId = intern(seq)`，**丢掉之前的样式**。
   * 于是 `BG + 前景 + 文字` 这种常见写法里，背景在第二个序列处就断了 ——
   * 用户消息气泡表现为「只有 ❯ 前面一小格有灰底、文字没底」（2026-09-13 报的）。
   * 真实终端里 SGR 是叠加的（38m 只改前景、39m 只还原前景、背景不动），
   * 我们必须模拟这个语义，否则任何「分段上色但共享背景」的排版都会断。
   *
   * 拆成 fg / bg / attrs 三部分分别跟踪，再拼回完整序列去 intern。
   */
  writeText(x, y, text, baseStyleId = 0) {
    if (y < 0 || y >= this.height) return x;
    let col = x;
    let styleId = baseStyleId;
    // 当前样式的三个独立分量（从 baseStyleId 还原，支持嵌套调用）
    let curFg = '', curBg = '', curAttrs = new Set();
    {
      const base = this.stylePool.get(baseStyleId);
      if (base) {
        const parsed = VScreen._parseSgr(base);
        curFg = parsed.fg; curBg = parsed.bg; curAttrs = parsed.attrs;
      }
    }
    const recompute = () => {
      const parts = [...curAttrs].sort((a, b) => a - b);
      let seq = '';
      if (parts.length) seq += `\x1b[${parts.join(';')}m`;
      if (curFg) seq += curFg;
      if (curBg) seq += curBg;
      styleId = seq ? this.stylePool.intern(seq) : baseStyleId;
    };
    let i = 0;
    const s = String(text);
    while (i < s.length) {
      // ANSI 转义：更新当前样式，不占格子
      if (s[i] === '\x1b') {
        const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
        if (m) {
          const seq = m[0];
          // \x1b[0m 或 \x1b[m 复位：回到 base，三个分量全清
          if (/^\x1b\[(0)?m$/.test(seq)) {
            const base = this.stylePool.get(baseStyleId);
            const parsed = base ? VScreen._parseSgr(base) : { fg: '', bg: '', attrs: new Set() };
            curFg = parsed.fg; curBg = parsed.bg; curAttrs = parsed.attrs;
            styleId = baseStyleId;
          } else {
            VScreen._mergeSgr(seq, {
              setFg: (v) => { curFg = v },
              setBg: (v) => { curBg = v },
              addAttr: (n) => curAttrs.add(n),
              delAttr: (n) => curAttrs.delete(n),
              clearAttrs: () => curAttrs.clear(),
            });
            recompute();
          }
          i += seq.length;
          continue;
        }
      }
      // 取一个完整码点（含代理对）
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === '\n' || ch === '\r') continue;   // 换行由调用方控制
      // charWidth 带码点缓存 —— 原来直接调 stringWidth，中文每字 0.01ms，
      // 一屏 45 行中文要 67ms，是「Responding… 时永久卡死」的根因。
      // 见文件顶部 WIDTH_CACHE 的注释（含实测数据）。
      const w = charWidth(ch);
      if (w <= 0) continue;                        // 零宽字符跳过
      if (col + w > this.width) break;             // 超宽截断
      this.setCell(col, y, this.charPool.intern(ch), styleId, w);
      if (w === 2) this.setCell(col + 1, y, 1, styleId, 0);  // 右半续格
      col += w;
    }
    return col;
  }

  /** 清一行 */
  clearRow(y) {
    if (y < 0 || y >= this.height) return;
    const start = this._idx(0, y);
    this.cells.fill(0, start, start + this.width * WORDS_PER_CELL);
    this._touch(0, y);
    this._touch(this.width - 1, y);
  }

  /** 整块上移 n 行（滚动），底部补空 */
  scrollUp(n, top = 0, bottom = this.height - 1) {
    if (n <= 0) return;
    const rows = bottom - top + 1;
    if (n >= rows) {
      for (let y = top; y <= bottom; y++) this.clearRow(y);
      return;
    }
    const rowWords = this.width * WORDS_PER_CELL;
    const src = this._idx(0, top + n);
    const dst = this._idx(0, top);
    const len = (rows - n) * rowWords;
    this.cells.copyWithin(dst, src, src + len);
    for (let y = bottom - n + 1; y <= bottom; y++) this.clearRow(y);
    this._touch(0, top);
    this._touch(this.width - 1, bottom);
  }

  /** 把某行读成字符串（供测试与选择复制） */
  rowText(y) {
    let out = '';
    for (let x = 0; x < this.width; x++) {
      const c = this.getCell(x, y);
      if (c.w === 0) continue;                     // 跳过宽字符续格
      out += c.charId === 0 ? ' ' : this.charPool.get(c.charId);
    }
    return out.replace(/\s+$/, '');
  }
}

/**
 * 逐格 diff，只扫两帧 damage 的并集。
 * cb(x, y, next) —— next 是 {charId, styleId, w}
 * cb 返回 true 可提前终止。
 */
export function diffEach(prev, next, cb) {
  const w = Math.max(prev.width, next.width);
  const h = Math.max(prev.height, next.height);
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;

  // diff 范围 = prev.damage ∪ next.damage。
  //   next.damage：本帧新写的内容（要画出来）
  //   prev.damage：屏幕上已有内容的范围（本帧若没写，要用空格擦掉）
  // 少了 prev.damage 就会漏掉「退格删掉的字符」这类消失内容 → 旧字符残留。
  if (!prev.damage && !next.damage) {
    if (prev.width === next.width && prev.height === next.height) return false;
  } else {
    const boxes = [prev.damage, next.damage].filter(Boolean);
    x0 = Math.min(...boxes.map((b) => b.x0));
    y0 = Math.min(...boxes.map((b) => b.y0));
    x1 = Math.max(...boxes.map((b) => b.x1));
    y1 = Math.max(...boxes.map((b) => b.y1));
    // 尺寸缩小时，多出来的行也要扫（要清掉）
    if (prev.height > next.height) y1 = Math.max(y1, prev.height - 1);
    if (prev.width > next.width) x1 = Math.max(x1, prev.width - 1);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = prev.getCell(x, y);
      const b = next.getCell(x, y);
      if (a.charId === b.charId && a.styleId === b.styleId && a.w === b.w) continue;
      if (cb(x, y, b) === true) return true;
    }
  }
  return false;
}
