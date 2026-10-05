// 长文本 → 图片（给 QQ 桥用：超长回复发一张图，避免刷屏几十条）
//
// 为什么自己写而不用 ImageMagick 的 `convert label:`：
//   那个默认字体不认中文（方框）、行距和边距都写死、不支持代码块高亮，
//   输出观感很差。这里用 PIL 自己排版，控制字体/配色/行距/圆角。
//
// 依赖：python3 + PIL（Termux 已装）+ /system/fonts/NotoSansCJK-Regular.ttc（系统自带）
// 输出：PNG 路径。失败返回 null，调用方要有降级路径（不能因为画图失败就发不出消息）。

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

// 正文字体候选。第二项是 .ttc 里的 face index：
//
// ⚠ NotoSansCJK-Regular.ttc 里有 5 个 face（JP/KR/SC/TC/HK），**默认 index 0 是日文字形**。
//   实测「骨」字 JP 版上半的「⺊」朝左、SC 版朝右，「画」「强」也有差异 —— 中文必须用
//   index 2 (CJK SC)，否则中文看着说不出哪里别扭。这是「字丑」的一个真实来源。
//
// ⚠ /system/fonts/MiSansL3.otf 看名字像可用，实测渲染出 0 个像素（占位/子集字体，
//   没有字形轮廓）。别再把它加进候选。
const FONT_CANDIDATES = [
  ['/system/fonts/NotoSansCJK-Regular.ttc', 2],   // CJK SC = 简体中文字形
  ['/system/fonts/NotoSerifCJK-Regular.ttc', 2],
  ['/system/fonts/DroidSansFallback.ttf', 0],
]

// 代码块专用等宽字体：用比例字体渲染代码，字母间距不匀、缩进也对不齐。
const MONO_CANDIDATES = [
  '/system/fonts/DroidSansMono.ttf',
  '/system/fonts/CutiveMono.ttf',
]

export function findCJKFont() {
  for (const [p, idx] of FONT_CANDIDATES) if (existsSync(p)) return { path: p, index: idx }
  return null
}

export function findMonoFont() {
  for (const p of MONO_CANDIDATES) if (existsSync(p)) return p
  return null
}

// Catppuccin Mocha 配色：深色护眼，和 CLI 主题接近
const THEME = {
  bg: '#1e1e2e',
  panel: '#181825',
  fg: '#cdd6f4',
  dim: '#7f849c',
  accent: '#89b4fa',
  code_bg: '#11111b',
  code_fg: '#a6e3a1',
  border: '#313244',
}

/**
 * 把文本渲染成 PNG。
 * @param {string} text 要渲染的文本（支持 ``` 代码块）
 * @param {object} opts
 *   - width 图片宽度（默认 900）
 *   - fontSize 正文字号（默认 30）
 *   - title 顶部标题（默认无）
 *   - outDir 输出目录
 * @returns {Promise<string|null>} PNG 路径，失败 null
 */
export async function textToImage(text, opts = {}) {
  const {
    width = 900,
    fontSize = 30,
    title = '',
    outDir = join(homedir(), '.claude-code-mobile', 'qq-out'),
  } = opts

  const body = String(text ?? '').replace(/\r\n/g, '\n')
  if (!body.trim()) return null

  try { mkdirSync(outDir, { recursive: true }) } catch {}
  const outPath = join(outDir, `t2i-${Date.now()}.png`)
  const font = findCJKFont()
  const mono = findMonoFont()

  // 文本走临时文件而不是命令行参数：几千字的正文塞进 argv 会撞长度上限，
  // 而且引号/反引号/$ 转义极易出错（命令注入风险）。
  const payloadPath = join(tmpdir(), `t2i-${Date.now()}.json`)
  try {
    writeFileSync(payloadPath, JSON.stringify({
      text: body, width, fontSize, title, out: outPath,
      font: font?.path || null, fontIndex: font?.index || 0, mono,
      theme: THEME,
    }), 'utf-8')
  } catch { return null }

  const py = `
import json, sys, re
from PIL import Image, ImageDraw, ImageFont

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
T = cfg['theme']

# ---- 2 倍超采样：先按 2 倍尺寸画，最后 LANCZOS 缩回 ----
# PIL 的 text() 没有子像素抗锯齿，30px 直接画笔画边缘有明显锯齿、细笔画发虚。
# 放大画再缩小等于手动做 SSAA，字形立刻干净很多（代价是内存和耗时 ×4，可接受）。
SS = 2
W = cfg['width'] * SS
FS = cfg['fontSize'] * SS
PAD = 36 * SS               # 四周留白
LINE_H = int(FS * 1.62)     # 行高：1.6 倍左右最舒服
CODE_FS = max(FS - 4 * SS, 16 * SS)

def load(sz, mono=False):
    # 代码用等宽字体：比例字体渲染 const a = 1 时字母间距不匀、缩进也对不齐
    if mono and cfg.get('mono'):
        try: return ImageFont.truetype(cfg['mono'], sz)
        except Exception: pass
    p = cfg.get('font')
    if p:
        try:
            # fontIndex 指定 .ttc 里的 face：2 = CJK SC（简中字形），0 是日文
            return ImageFont.truetype(p, sz, index=cfg.get('fontIndex', 0))
        except Exception:
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()

f_body  = load(FS)
f_title = load(int(FS * 1.15))
f_code  = load(CODE_FS, mono=True)
# 代码块里的 CJK 回退字体：DroidSansMono 只有 ASCII 字形，
# 代码注释/字符串里的中文会渲染成方框（□□□）。按字符切换到 CJK 字体。
f_code_cjk = load(CODE_FS)
f_dim   = load(max(FS - 8 * SS, 14 * SS))

def is_cjk(ch):
    c = ord(ch)
    return (0x2e80 <= c <= 0xa4cf or 0xac00 <= c <= 0xd7a3 or
            0xf900 <= c <= 0xfaff or 0xfe30 <= c <= 0xfe6f or
            0xff00 <= c <= 0xff60 or 0xffe0 <= c <= 0xffe6)

# 制表符 / 进度条 / 树状图字符：这些内容按等宽字符格数排版，
# 用比例字体渲染必然错位（slash 命令的表格输出全靠它们画框）。
BOXY_CHARS = set('│─┌┐└┘├┤┬┴┼╭╮╰╯━┃█░▓▒▏▎▍▌▋▊▉╔╗╚╝║═╠╣┏┓┗┛')
def is_boxy(s):
    """一段里出现 2 个以上框线字符就按等宽处理（单个可能只是正文里的破折号）"""
    n = sum(1 for ch in s if ch in BOXY_CHARS)
    return n >= 2

def draw_grid(d, x, y, s, f_ascii, f_cjk, fill):
    """按终端字符格逐字绘制：ASCII 占 1 格、CJK 占 2 格，位置严格 = 格宽 × 列号。

    这是还原终端表格的唯一可靠方式 —— 只要每个字符都落在整数格上，
    框线自然对齐，跟字体的实际字宽无关。
    """
    cell = tw('M', f_ascii)          # 等宽字体的单格宽度
    col = 0
    for ch in s:
        if ch == ' ':
            col += 1; continue
        wide = is_cjk(ch)
        # ⚠ 框线/进度条字符（│─█░）等宽字体里没有字形，会渲染成方框 □。
        #   它们在 U+2500~U+259F，不在 is_cjk 的区间里，所以必须单独判。
        #   宽度上它们是「1 格」（终端里就占一格），只是字形要借 CJK 字体。
        f = f_cjk if (wide or ch in BOXY_CHARS) else f_ascii
        gx = x + col * cell
        span = 2 if wide else 1          # 占几格

        # 【图形字符自己画，不靠字体】
        # 字体里这些字形不可控：░ 在 Noto CJK 里是斜线纹理（该是浅色方块）、
        # 横线字符之间会留缝、✓ 压根没有字形（渲染成 □）。
        # 直接用绘图 API 画成矩形/线段，效果精确且不依赖字体覆盖度。
        lh_cell = int(f_ascii.size * 1.5)
        if ch in '█▓':
            d.rectangle([gx, y + lh_cell * 0.18, gx + cell, y + lh_cell * 0.82], fill=fill)
            col += span; continue
        if ch in '░▒':
            # 未填充部分：画一条细底纹条，颜色比正文淡
            d.rectangle([gx, y + lh_cell * 0.42, gx + cell, y + lh_cell * 0.58], fill=T['border'])
            col += span; continue
        if ch in '─━':
            ly = y + lh_cell * 0.52
            d.rectangle([gx, ly, gx + cell + 1, ly + max(1, SS)], fill=fill)
            col += span; continue
        # 竖线与转角：按「半格」拼接，保证与相邻的横线/竖线严丝合缝
        if ch in '│┌┐└┘├┤┬┴┼╭╮╰╯':
            t = max(1, SS)                       # 线宽
            cx = gx + cell * 0.5 - t / 2         # 竖线中心
            cy = y + lh_cell * 0.52              # 横线中心（与 ─ 一致）
            up    = ch in '│└┘├┤┴┼╰╯'
            down  = ch in '│┌┐├┤┬┼╭╮'
            left  = ch in '┐┘┤┬┴┼╮╯'
            right = ch in '┌└├┬┴┼╭╰'
            if up:    d.rectangle([cx, y, cx + t, cy + t], fill=fill)
            if down:  d.rectangle([cx, cy, cx + t, y + lh_cell], fill=fill)
            if left:  d.rectangle([gx, cy, cx + t, cy + t], fill=fill)
            if right: d.rectangle([cx, cy, gx + cell + 1, cy + t], fill=fill)
            col += span; continue

        # 符号类回退：✓✗⚠· 这些字体覆盖不全（渲染成 □），用能画/能替代的形式
        if ch == '✓':
            t = max(1, SS)
            d.line([(gx + cell * 0.18, y + lh_cell * 0.52),
                    (gx + cell * 0.42, y + lh_cell * 0.74),
                    (gx + cell * 0.85, y + lh_cell * 0.26)], fill=fill, width=t * 2)
            col += span; continue

        gw = tw(ch, f)
        # CJK 按 2 格定位但字形常略窄于 2 格，完全居中会让字距看着很松。
        # 偏左 30% 放（而不是 50% 居中），视觉上更紧凑且仍不越格。
        if gw < cell * span:
            gx += (cell * span - gw) * (0.3 if wide else 0.5)
        d.text((gx, y), ch, font=f, fill=fill)
        col += span

def draw_mixed(d, x, y, s, f_ascii, f_cjk, fill):
    """逐段绘制：ASCII 用等宽字体，CJK 用中文字体。避免方框，也保住代码对齐。"""
    if not s: return
    cur, cur_cjk = '', None
    for ch in s:
        k = is_cjk(ch)
        if cur_cjk is None: cur_cjk = k
        if k != cur_cjk:
            f = f_cjk if cur_cjk else f_ascii
            d.text((x, y), cur, font=f, fill=fill)
            try: x += d.textlength(cur, font=f)
            except Exception: x += len(cur) * f.size * 0.6
            cur, cur_cjk = ch, k
        else:
            cur += ch
    if cur:
        f = f_cjk if cur_cjk else f_ascii
        d.text((x, y), cur, font=f, fill=fill)

probe = Image.new('RGB', (10, 10)); pd = ImageDraw.Draw(probe)
def tw(s, f, f_cjk=None):
    # 给了 f_cjk 就按混合字体量：代码行里 ASCII 走等宽、CJK 走中文字体，
    # 宽度必须和 draw_mixed 的实际绘制一致，否则折行位置算错（提前折或超出边框）
    if f_cjk is not None and any(is_cjk(c) for c in s):
        w = 0
        cur, cur_cjk = '', None
        for ch in s:
            k = is_cjk(ch)
            if cur_cjk is None: cur_cjk = k
            if k != cur_cjk:
                w += tw(cur, f_cjk if cur_cjk else f)
                cur, cur_cjk = ch, k
            else:
                cur += ch
        if cur: w += tw(cur, f_cjk if cur_cjk else f)
        return w
    try: return pd.textlength(s, font=f)
    except Exception: return len(s) * f.size * 0.6

# ---- 按可用宽度折行（按字符宽度实测，中英混排都准）----
def wrap(s, f, maxw, f_cjk=None):
    if not s: return ['']
    out, cur = [], ''
    for ch in s:
        if ch == '\\n':
            out.append(cur); cur = ''; continue
        if tw(cur + ch, f, f_cjk) <= maxw:
            cur += ch
        else:
            out.append(cur); cur = ch
    out.append(cur)
    return out or ['']

# ---- 解析代码块，拆成 [(kind, text)] ----
blocks, in_code, buf, lang = [], False, [], ''
for ln in cfg['text'].split('\\n'):
    m = re.match(r'^\\s*\`\`\`(\\w*)\\s*$', ln)
    if m:
        if in_code:
            blocks.append(('code', '\\n'.join(buf), lang)); buf, in_code, lang = [], False, ''
        else:
            if buf: blocks.append(('text', '\\n'.join(buf), ''))
            buf, in_code, lang = [], True, m.group(1)
        continue
    buf.append(ln)
if buf: blocks.append(('code' if in_code else 'text', '\\n'.join(buf), lang))

# ---- 排版：先算总高，再画 ----
CONTENT_W = W - PAD * 2
layout = []   # (kind, lines, font, lineh, extra)
total_h = PAD

if cfg['title']:
    tl = wrap(cfg['title'], f_title, CONTENT_W)
    layout.append(('title', tl, f_title, int(f_title.size * 1.5), 0))
    total_h += len(tl) * int(f_title.size * 1.5) + 14 * SS

for kind, content, lg in blocks:
    if kind == 'code':
        lines = []
        for ln in content.split('\\n'):
            lines += wrap(ln, f_code, CONTENT_W - 28 * SS, f_code_cjk)
        head = int(f_dim.size * 1.4) if lg else 0
        ch = len(lines) * int(CODE_FS * 1.5) + 26 * SS + head
        layout.append(('code', lines, f_code, int(CODE_FS * 1.5), lg))
        total_h += ch + 16 * SS
    elif is_boxy(content):
        # 含制表符/进度条字符的整段按等宽渲染。
        #
        # ⚠ 这是「表格错乱」的根治点：终端画的框（│─┌┐└┘）和进度条（█░）
        #   在比例字体下宽度各不相同，右边框会飘到参差不齐的位置，
        #   █░ 还会被渲染成实心块 + 斜线阴影，整张图彻底看不懂。
        #   这类内容本来就是按等宽字符格数排的版，必须用等宽字体还原。
        # 按「格数」折行，与 draw_grid 的定位规则一致
        cell = tw('M', f_code)
        max_cols = max(20, int(CONTENT_W / cell))
        lines = []
        for ln in content.split('\\n'):
            cols, cur = 0, ''
            for ch in ln:
                w = 2 if is_cjk(ch) else 1
                if cols + w > max_cols:
                    lines.append(cur); cur, cols = ch, w
                else:
                    cur += ch; cols += w
            lines.append(cur)
        layout.append(('boxy', lines, f_code, int(CODE_FS * 1.5), 0))
        total_h += len(lines) * int(CODE_FS * 1.5)
    else:
        # 代码块自带 16*SS 下边距，紧接的空行不该再加一次（否则代码块后面空得很宽）
        if not content.strip():
            prev_code = layout and layout[-1][0] == 'code'
            if prev_code: continue
            layout.append(('gap', [], f_body, LINE_H, 0)); total_h += int(LINE_H * 0.5); continue
        lines = []
        for ln in content.split('\\n'):
            lines += wrap(ln, f_body, CONTENT_W)
        layout.append(('text', lines, f_body, LINE_H, 0))
        total_h += len(lines) * LINE_H

total_h += PAD + 30 * SS   # 底部留白 + 水印行
H = max(total_h, 140 * SS)

img = Image.new('RGB', (W, H), T['bg'])
d = ImageDraw.Draw(img)
y = PAD

for kind, lines, f, lh, extra in layout:
    if kind == 'gap':
        y += int(lh * 0.5); continue
    if kind == 'title':
        for ln in lines:
            d.text((PAD, y), ln, font=f, fill=T['accent']); y += lh
        y += 6 * SS
        d.line([(PAD, y), (W - PAD, y)], fill=T['border'], width=2 * SS); y += 12 * SS
        continue
    if kind == 'code':
        # 有语言标签时要给它留出一行高度，否则标签会压在第一行代码上
        head = int(f_dim.size * 1.4) if extra else 0
        bh = len(lines) * lh + 26 * SS + head
        d.rounded_rectangle([PAD - 6 * SS, y, W - PAD + 6 * SS, y + bh], radius=10 * SS,
                            fill=T['code_bg'], outline=T['border'], width=1 * SS)
        if extra:
            # 语言标签用更淡的颜色：它是元信息，不应该比代码本身抢眼
            d.text((PAD + 10 * SS, y + 8 * SS), extra, font=f_dim, fill=T['border'])
        yy = y + 14 * SS + head
        for ln in lines:
            draw_mixed(d, PAD + 10 * SS, yy, ln, f, f_code_cjk, T['code_fg']); yy += lh
        y += bh + 16 * SS
        continue
    if kind == 'boxy':
        # 等宽渲染，无背景框（它自己就带边框，再套一层会重叠）。
        # ⚠ 必须用 draw_grid 而不是 draw_mixed：框线内容是按「终端字符格」排版的，
        #   CJK 占 2 格、ASCII 占 1 格。draw_mixed 让 CJK 走比例字体，
        #   宽度就不是整数格倍数，框线照样对不齐。
        for ln in lines:
            draw_grid(d, PAD, y, ln, f, f_code_cjk, T['fg']); y += lh
        continue
    for ln in lines:
        d.text((PAD, y), ln, font=f, fill=T['fg']); y += lh

d.text((PAD, H - PAD + 4 * SS), 'Claude Code Mobile', font=f_dim, fill=T['dim'])

# 缩回目标尺寸：LANCZOS 重采样把 2 倍画布的锯齿抹平，得到接近子像素抗锯齿的效果
if SS > 1:
    img = img.resize((W // SS, H // SS), Image.LANCZOS)
img.save(cfg['out'])
print(cfg['out'])
`

  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', py, payloadPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 30000)
    proc.on('close', (code) => {
      clearTimeout(timer)
      try { unlinkSync(payloadPath) } catch {}
      if (code === 0 && out.trim() && existsSync(out.trim())) resolve(out.trim())
      else resolve(null)
    })
    proc.on('error', () => { clearTimeout(timer); resolve(null) })
  })
}
