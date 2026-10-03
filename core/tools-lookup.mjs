// 资料查询工具组（Agent 可调）：多来源搜索 → 资料卡 → 按条目抓全文
//
// 【不只是搜图】用户明确指出：这套能力对任何文本关键词都有用，
// 图片只是触发方式之一（主模型看图后提炼关键词）。所以工具名和描述
// 都不限定图片 —— SearchInfo / Lookup，输入就是关键词。
//
// 流程：SearchInfo(keywords) → 资料卡（多来源、带权威度标注、落盘）
//       → 模型挑条目 → Lookup({ card, index }) → 全文落盘返回路径
//
// 【为什么要两步】一次全抓会把几万字塞进上下文；资料卡只有标题+摘要+来源，
// 模型按条目挑值得展开的，省 token 也更准。
//
// 【权威度标注】用户明确要求：写清来源，让模型判断可信度 ——
// 中国新闻网/腾讯新闻这类是可信的，个人博客/论坛要打折。靠域名映射打分，
// 分数只作参考，最终判断留给模型（规则列不全，硬编码反而误导）。
//
// 【数据源】实测筛选
//
// 2026-09-12 首批：
//   cn.bing   200 ✓ 5 条/页可解析（b_algo 块：a href + h2 + b_lineclamp 摘要）
//   百度      200 ✓ 带来源名（cosc-source-text），链接是 data-url
//   B站 API   200 ✓ 官方接口最稳（title/author/bvid/play），需 Cookie buvid3
//   Mojeek    200 ✓ 备用（中文覆盖一般）
//   搜狗      ✗ 结构不可解析（h3 空、无 /link） 弃
//   Google    ✗ 直连不通（000）          DDG ✗ 000
//
// 2026-09-13 扩充（用户要求「多搞点优质数据源，比如知乎、CSDN、博客园」）：
//   CSDN API      ✓ 1.2s，30 条，JSON 接口（so.csdn.net/api/v3/search）
//   掘金 API      ✓ 0.4s，20 条，POST JSON（api.juejin.cn/search_api）
//   V2EX sov2ex   ✓ 0.5s，5 条，JSON（技术圈讨论质量高于一般博客）
//   HackerNews    ✓ 1.1s，5 条，Algolia 官方 API（英文一手讨论）
//   StackOverflow ✓ 0.8s，5 条，官方 API（权威技术问答）
//   GitHub        ✓ 0.7s，5 条，官方 API（找项目和实现）
//   博客园        ⚠ 页面能取但结构变了，解析规则待定（先不用）
//   知乎          ✗ API 要登录态（400），只能靠 Bing 间接带出
//   Reddit        ✗ 直连超时

import { Tool } from './tools.mjs'
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOOKUP_DIR = join(homedir(), '.claude-code-mobile', 'lookup')
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'

// ── 来源标注（参考值，不是结论）──────────────────────────
//
// 【2026-09-13 重做，起因是一次真实误判】
// 查「DeepSeek 4.1 是否存在」时，10 条结果全被标成 `★☆☆ 一般来源`：
// 官网 deepseek.com 和仿冒站 deepseekvc.com / deepseek-cx.com.cn 同级，
// B 站多个 UP 的独立实测视频也是同级 —— 标注等于没有信息量，
// 我于是忽略了它们、直接下了「这个版本不存在」的错误结论。
//
// 三个改动：
//   1. 厂商官网单列一档（最高分），并识别**仿冒域名**给出负分警示
//   2. 内容平台（B站/知乎）标成「UGC · 可交叉验证」而不是笼统的「一般来源」——
//      单条不可靠，但多个独立作者讲同一件事，比一个网页可信
//   3. 标签写清**该怎么用**，不只给星级
const DOMAIN_TRUST = [
  // 4 = 一手来源：厂商官网 / 官方文档（查产品、版本、价格、政策的唯一权威）
  // ⚠ 【不要枚举子域前缀】第一版写 ^(www|docs|api|platform)\. 白名单，
  //   结果 api-docs.deepseek.com（真官方文档站）匹配不上、只拿到 1 分。
  //   官方域的判定统一交给下面 trustOf 里的 OFFICIAL_APEX（按注册域，任意子域都算），
  //   这里只留通用规则。
  [/^(docs|developer|devcenter)\./i, 4],
  [/\.(gov|edu)(\.[a-z]{2})?$/i, 4],
  // 3 = 权威机构 / 官媒
  [/^(www\.)?(xinhuanet|people|cctv|chinanews|cnr|china)\.(com|cn)$/i, 3],
  // 2 = 主流媒体、技术权威站
  [/^(news\.)?(qq|163|sina|sohu|ifeng|thepaper)\./i, 2],
  [/baike\.baidu\.com/i, 2],
  // 技术问答/代码站：StackOverflow 有投票和采纳机制，答案质量经同行筛选，
  // GitHub 是代码与文档的一手载体 —— 都算权威站，不是普通 UGC
  [/(^|\.)(github|stackoverflow|npmjs|pypi|readthedocs)\./i, 2],
  [/developer\.mozilla\.org/i, 2],
  // HackerNews：技术圈一手讨论，质量高于一般论坛但仍是个人发言 → 1.8
  [/(^|\.)(news\.ycombinator|ycombinator)\.com/i, 1.8],
  // 1.5 = UGC 内容平台：单条别当结论，多条独立印证时可信度不低
  // ⚠ 要允许任意子域：知乎专栏是 zhuanlan.zhihu.com，只写 ^(www\.)? 匹配不到
  [/(^|\.)(bilibili|zhihu|juejin|csdn|jianshu|douban|weibo)\./i, 1.5],
  // V2EX：技术社区讨论，比 CSDN 转载文更真实，但也更零散 → 1.3
  [/(^|\.)(v2ex)\.com/i, 1.3],
  // 0 = 论坛 / 个人博客
  [/^(tieba|bbs|forum|blog)\.|tieba\.baidu/i, 0],
  // 0.5 = 廉价/临时顶级域：中转站、短命部署的高发区。
  //   不等于仿冒（可能就是个人小站），但引用前该多问一句「这站明天还在吗」。
  [/\.(bond|top|xyz|cyou|icu|shop|site|online|click|link|buzz|monster)$/i, 0.5],
]

// 仿冒域名识别：品牌名 + 无关后缀/多余字母，是钓鱼站和 SEO 农场的典型形态。
// 命中就标 -1（排最后 + 明确警示），别让它混在正常结果里。
const BRANDS = ['deepseek', 'anthropic', 'openai', 'claude', 'chatgpt', 'moonshot', 'kimi', 'gemini']
const OFFICIAL_HOSTS = new Set([
  'deepseek.com', 'www.deepseek.com', 'chat.deepseek.com', 'api.deepseek.com',
  'anthropic.com', 'www.anthropic.com', 'claude.ai', 'claude.com', 'www.claude.com', 'docs.claude.com',
  'openai.com', 'www.openai.com', 'chatgpt.com', 'platform.openai.com',
  'moonshot.cn', 'kimi.com', 'www.kimi.com', 'gemini.google.com',
])
// 官方注册域（品牌 + 正确顶级域）。任意子域都算官方 —— api-docs.deepseek.com、
// platform.openai.com 这些都是真官方文档站。
// ⚠ 第一版没有这张表，只按「品牌名出现在子域」判，把 api-docs.deepseek.com
//   误标成仿冒（2026-09-13 实搜时发现）。判仿冒必须以「注册域对不对」为准，
//   而不是「品牌名出现在哪一段」。
const OFFICIAL_APEX = new Set([
  'deepseek.com', 'anthropic.com', 'claude.ai', 'claude.com', 'openai.com', 'chatgpt.com',
  'moonshot.cn', 'kimi.com', 'bigmodel.cn', 'zhipuai.cn', 'z.ai',
  'google.com', 'nvidia.com', 'microsoft.com', 'apple.com',
])

function apexOf(host) {
  const l = host.toLowerCase().replace(/^www\./, '').split('.')
  if (l.length < 2) return host.toLowerCase()
  // 处理 .com.cn / .co.uk 这类двух段后缀
  const twoPart = /^(com|net|org|gov|edu|co)\.[a-z]{2}$/.test(l.slice(-2).join('.'))
  return l.slice(twoPart ? -3 : -2).join('.')
}

function looksImpersonating(host) {
  const h = host.toLowerCase().replace(/^www\./, '')
  const apex = apexOf(h)
  // 注册域就是官方 → 任意子域都放行（api-docs.deepseek.com / platform.openai.com）
  if (OFFICIAL_APEX.has(apex)) return false
  if (OFFICIAL_HOSTS.has(h) || OFFICIAL_HOSTS.has(host.toLowerCase())) return false
  // 注册域不是官方，但域名里带品牌名 → 蹭品牌
  for (const b of BRANDS) {
    if (h.includes(b)) return true
  }
  return false
}

function trustOf(url) {
  try {
    const host = new URL(url).hostname
    if (looksImpersonating(host)) return -1
    // 官方注册域 → 一手来源，任意子域都算（api-docs.deepseek.com、platform.openai.com）。
    // 必须排在 DOMAIN_TRUST 之前：否则会被后面更宽松的规则先命中。
    if (OFFICIAL_APEX.has(apexOf(host))) return 4
    for (const [re, s] of DOMAIN_TRUST) if (re.test(host)) return s
    return 1
  } catch { return 1 }
}

// 标签不只给星级，还写清「该怎么用这条」—— 光有星级我上次就直接忽略了
const TRUST_LABEL = {
  4: '★★★★ 一手来源（官网/官方文档，查版本价格政策以此为准）',
  3: '★★★ 官方媒体',
  2: '★★☆ 主流媒体 / 技术权威站',
  1.8: '★☆☆ 技术社区一手讨论（HackerNews 等；可看观点，结论仍需交叉验证）',
  1.5: '★☆☆ UGC 平台（单条别当结论；多个独立作者讲同一件事 = 可信）',
  1.3: '★☆☆ 技术论坛讨论（V2EX 等；比转载博客真实，但零散）',
  1: '★☆☆ 一般来源',
  0.5: '✩☆☆ 廉价/临时域名（.bond .top .xyz 等，中转站高发区，可能随时消失）',
  0: '✩☆☆ 论坛 / 个人博客（打折看）',
  // 措辞别太绝对：仿冒域名的**内容**常常是真数据（镜像站/搬运拼合），
  // 该警惕的是「域名身份」和「可能存在钓鱼/篡改」，不是内容本身。
  // 用户 2026-09-13 指出：直接说「别当依据」会把有用信息一起扔掉。
  '-1': '⚠ 疑似仿冒品牌域名（非官方 host；内容多为搬运的真实数据，但来源不可验证，需与一手来源对照）',
}
function labelOf(score) {
  return TRUST_LABEL[score] ?? TRUST_LABEL[1]
}

async function fetchText(url, extraHeaders = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...extraHeaders },
      signal: ctl.signal, redirect: 'follow',
    })
    return await resp.text()
  } finally { clearTimeout(timer) }
}

const stripTags = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&/g, '&')
  .replace(/</g, '<').replace(/>/g, '>')
  .replace(/"/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim()

// ── 各源实现 ─────────────────────────────────────────────
async function searchBing(q) {
  try {
    const html = await fetchText(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN`)
    const blocks = html.split('<li class="b_algo"').slice(1)
    return blocks.slice(0, 6).map((blk) => {
      const u = blk.match(/<a[^>]*href="(https?:\/\/[^"]+)"/)
      const t = blk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
      const c = blk.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      if (!u || !t) return null
      let host = ''
      try { host = new URL(u[1]).hostname } catch {}
      return { title: stripTags(t[1]), url: u[1], snippet: stripTags(c?.[1]).slice(0, 180), source: host }
    }).filter(Boolean)
  } catch { return [] }
}

async function searchBaidu(q) {
  try {
    const html = await fetchText(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}`)
    const out = []
    const re = /data-url="(https?:\/\/[^"]+)"[\s\S]{0,3000}?<span class="cosc-source-text[^"]*">([^<]{1,40})<\/span>[\s\S]{0,1500}?<em>([^<]{2,60})<\/em>/g
    let m
    while ((m = re.exec(html)) && out.length < 6) {
      out.push({ title: stripTags(m[3]), url: m[1], snippet: '', source: m[2] })
    }
    return out
  } catch { return [] }
}

async function searchBili(q) {
  try {
    const html = await fetchText(
      `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(q)}&page=1`,
      { Referer: 'https://www.bilibili.com', Cookie: 'buvid3=lookup' }
    )
    const d = JSON.parse(html)
    const blk = (d?.data?.result || []).find((b) => b.result_type === 'video')
    return (blk?.data || []).slice(0, 5).map((v) => ({
      title: stripTags(v.title).slice(0, 80),
      url: v.arcurl || `https://www.bilibili.com/video/${v.bvid}`,
      snippet: `${stripTags(v.description).slice(0, 120)}（UP: ${v.author} · 播放 ${v.play}）`,
      source: 'bilibili.com',
    }))
  } catch { return [] }
}

/**
 * 六个新源（2026-09-13 加）。共同点：走官方 JSON API，比抓 HTML 稳得多 ——
 * 页面结构一变解析就废（搜狗就是这么弃的），API 字段稳定。
 */
async function searchCsdn(q) {
  try {
    const r = await fetch(`https://so.csdn.net/api/v3/search?q=${encodeURIComponent(q)}&t=all&p=1`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const j = await r.json()
    const items = j?.result_vos || j?.data?.items || []
    return items.slice(0, 5).map((it) => ({
      title: stripTags(it.title || it.titleText || '').slice(0, 80),
      url: it.url || `https://blog.csdn.net/${it.username}/article/details/${it.article_id || ''}`,
      snippet: stripTags(it.description || it.digest || '').slice(0, 140),
      source: 'blog.csdn.net',
    })).filter((x) => x.url && x.title)
  } catch { return [] }
}

async function searchJuejin(q) {
  try {
    const r = await fetch('https://api.juejin.cn/search_api/v1/search', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      body: JSON.stringify({ key_word: q, id_type: 0, cursor: '0', limit: 5, search_type: 0 }),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return []
    const j = await r.json()
    return (j?.data || []).slice(0, 5).map((it) => {
      const info = it.result_model?.article_info || it.result_model?.article || {}
      return {
        title: stripTags(info.title || it.title || '').slice(0, 80),
        url: info.article_id ? `https://juejin.cn/post/${info.article_id}` : (it.url || ''),
        snippet: stripTags(info.brief_content || info.digest || '').slice(0, 140),
        source: 'juejin.cn',
      }
    }).filter((x) => x.url && x.title)
  } catch { return [] }
}

async function searchV2ex(q) {
  try {
    const r = await fetch(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(q)}&size=5`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const j = await r.json()
    return (j?.hits || []).slice(0, 5).map((h) => {
      const s = h._source || {}
      return {
        title: String(s.title || '').slice(0, 80),
        url: s.id ? `https://www.v2ex.com/t/${s.id}` : '',
        snippet: `${String(s.content || '').replace(/\s+/g, ' ').slice(0, 120)}（回复 ${s.replies || 0}）`,
        source: 'v2ex.com',
      }
    }).filter((x) => x.url && x.title)
  } catch { return [] }
}

async function searchHackerNews(q) {
  try {
    const r = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=5`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const j = await r.json()
    return (j?.hits || []).slice(0, 5).map((h) => ({
      title: String(h.title || '').slice(0, 80),
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `${h.points || 0} points · ${h.num_comments || 0} comments${h.created_at ? ' · ' + String(h.created_at).slice(0, 10) : ''}`,
      source: 'news.ycombinator.com',
    })).filter((x) => x.title)
  } catch { return [] }
}

async function searchStackOverflow(q) {
  try {
    const r = await fetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=5&filter=default`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const j = await r.json()
    return (j?.items || []).slice(0, 5).map((it) => ({
      title: stripTags(it.title || '').slice(0, 90),
      url: it.link || '',
      snippet: `得分 ${it.score || 0} · ${it.is_answered ? '已解决' : '未解决'} · ${it.answer_count || 0} 回答`,
      source: 'stackoverflow.com',
    })).filter((x) => x.url && x.title)
  } catch { return [] }
}

async function searchGithub(q) {
  try {
    const r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=5&sort=stars`,
      { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const j = await r.json()
    return (j?.items || []).slice(0, 5).map((it) => ({
      title: `${it.full_name}${it.description ? ' — ' + stripTags(it.description).slice(0, 50) : ''}`,
      url: it.html_url || '',
      snippet: `★${it.stargazers_count || 0} · ${it.language || '?'} · 更新 ${String(it.updated_at || '').slice(0, 10)}`,
      source: 'github.com',
    })).filter((x) => x.url && x.title)
  } catch { return [] }
}

async function searchMojeek(q) {
  try {
    const html = await fetchText(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`)
    const out = []
    const re = /<a class="title[^"]*" href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && out.length < 5) {
      let host = ''
      try { host = new URL(m[1]).hostname } catch {}
      out.push({ title: stripTags(m[2]).slice(0, 80), url: m[1], snippet: '', source: host })
    }
    return out
  } catch { return [] }
}

/** 去重（按 URL），合并各源结果并按权威度排序 */
function merge(results) {
  const seen = new Set()
  const out = []
  for (const r of results) {
    if (!r || seen.has(r.url)) continue
    seen.add(r.url)
    out.push({ ...r, trust: trustOf(r.url) })
  }
  return out.sort((a, b) => b.trust - a.trust)
}

/** 资料卡落盘，上限 5 张（超了删最旧） */
function saveCard(keywords, items) {
  try { mkdirSync(LOOKUP_DIR, { recursive: true }) } catch {}
  try {
    const cards = readdirSync(LOOKUP_DIR).filter((f) => f.startsWith('card-')).sort()
    while (cards.length >= 5) {
      const oldest = cards.shift()
      try { unlinkSync(join(LOOKUP_DIR, oldest)) } catch { break }
    }
  } catch {}
  const id = `card-${Date.now()}`
  writeFileSync(join(LOOKUP_DIR, `${id}.json`), JSON.stringify({ keywords, at: Date.now(), items }, null, 2), 'utf-8')
  return id
}

export class SearchInfoTool extends Tool {
  constructor() {
    super({
      name: 'SearchInfo',
      description: '多来源资料搜索：一次查 Bing/百度/B站/CSDN/掘金/V2EX/HackerNews/StackOverflow/GitHub/Mojeek 十个源，返回资料卡（标题+摘要+来源+来源标注，按可信度排序）。'
        + '返回资料卡 id 和条目列表，再用 Lookup({ card, index }) 打开某条抓全文。'
        + '关键词可以来自任何地方：用户直接问的问题、看图后提炼的特征、任务里需要查证的事实。'
        + '\n来源标注怎么用（域名映射的参考值，不是结论）：'
        + '★★★★ 一手来源=官网/官方文档，查版本号·价格·政策以它为准；'
        + '★★★/★★☆ 官媒与主流媒体·技术权威站，可直接引用；'
        + '★☆☆ UGC 平台（B站/知乎）单条别当结论，但**多个独立作者讲同一件事就可信**——'
        + '查新发布的模型/产品时这类往往是唯一有实测的来源；'
        + '✩☆☆ 廉价临时域名（.bond .top 等）和论坛个人博客要打折；'
        + '⚠ 疑似仿冒品牌域名（带品牌名却不是官方 host）：排在最后，但**内容常常是真的**'
        + '（镜像站/搬运拼合，有时比官方页还全）。可以看，只是要跟前面的一手来源对照核实。'
        + '\n⚠ 涉及模型版本、产品发布、价格、政策这类会变的事实，**先搜再答**，'
        + '不要因为「训练数据里没有」就断言不存在。',
      input_schema: {
        type: 'object',
        properties: {
          keywords: {
            description: '搜索关键词。**可以传数组并行搜多个角度**（最多 4 个），'
              + '如 ["DeepSeek V4.1 多模态", "V4.1 Flash 视觉 评测", "V4.1 对比 GLM"]——'
              + '同一件事换个说法能搜出完全不同的结果，多角度并行比反复改词重搜高效得多。'
              + '中英文均可。',
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' }, maxItems: 4 },
            ],
          },
          limit: {
            type: 'number',
            description: '返回多少条，默认 25，上限 50。结果多时先看前面（已按可信度排序），'
              + '不够再用更大的 limit 重搜，不要一次拉满 —— 每条都占上下文。',
          },
        },
        required: ['keywords'],
      },
      maxResultSizeChars: 12000,
    })
  }

  async execute(input) {
    // 关键词可以是字符串或数组（多角度并行）
    const raw = input?.keywords
    const queries = (Array.isArray(raw) ? raw : [raw])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, 4)   // 上限 4：再多就变成刷请求，边际收益低
    if (!queries.length) return '需要 keywords（搜索关键词，字符串或数组）'
    try { mkdirSync(LOOKUP_DIR, { recursive: true }) } catch {}

    /** 跑一个关键词的全部源（十个源并发，失败源自己返回 [] 不拖垮整体） */
    const runOne = async (q) => {
      const [bing, baidu, bili, mojeek, csdn, juejin, v2ex, hn, so, gh] = await Promise.all([
        searchBing(q), searchBaidu(q), searchBili(q), searchMojeek(q),
        searchCsdn(q), searchJuejin(q), searchV2ex(q),
        searchHackerNews(q), searchStackOverflow(q), searchGithub(q),
      ])
      return [...bing, ...baidu, ...bili, ...mojeek, ...csdn, ...juejin, ...v2ex, ...hn, ...so, ...gh]
    }

    // 多关键词之间也并行 —— 串行搜 4 个词要等 4 倍时间
    const perQuery = await Promise.all(queries.map(runOne))
    // 打上来源关键词标签（合并去重后还能看出每条是哪个词搜来的）
    const tagged = perQuery.flatMap((items, qi) => items.map((it) => ({ ...it, _q: queries[qi] })))
    const items = merge(tagged)
    if (items.length === 0) return `${queries.map((q) => `「${q}」`).join(' ')}各来源都没有结果`

    const cardId = saveCard(queries.join(' | '), items)
    const multi = queries.length > 1
    // 默认展示 25 条（原 12 条太少，一次搜索十个源常有几十条有效结果）。
    // 上限 50：再多就是刷屏，该用更精确的关键词重搜而不是翻页。
    const limit = Math.max(1, Math.min(Number(input?.limit) || 25, 50))
    // 【仿冒站照样展示，只是排在最后 + 带警示】
    //
    // 一度想把它们滤掉，是错的：仿冒域名大多是镜像站/SEO 农场，
    // 内容常常是从官方或一手来源扒下来的**真数据**（有时还更全，
    // 因为把多篇拼在一起了）。域名可疑 ≠ 内容假 —— 用户 2026-09-13 明确指出。
    // 正确做法是保留信息、标明风险，让模型自己判断：
    // 里面确实可能有官方页面没写的东西（比如某次发布会细节）。
    const impostors = items.filter((it) => it.trust === -1)
    const pool = items
    const shown = pool.slice(0, limit)
    const lines = [
      multi
        ? `资料卡 ${cardId}（${queries.length} 个关键词并行：${queries.join(' | ')}，共 ${items.length} 条，去重后按权威度排序）:`
        : `资料卡 ${cardId}（关键词: ${queries[0]}，共 ${items.length} 条，按权威度排序）:`,
      // 每条压成两行：标题行 + 来源/摘要行。
      // 原来三行（标题、来源、摘要各一行）在 25 条时会占太多高度，
      // 手机上要滚好几屏才能看完——信息量没变，只是排得紧凑。
      ...shown.flatMap((it, i) => {
        const head = `  [${i}] ${labelOf(it.trust)}`
        const body = `      ${it.title.slice(0, 62)}`
        const meta = `      ${it.source} · ${it.snippet.slice(0, 90) || '(无摘要)'}`
        const from = multi ? `      （搜自「${it._q}」）` : null
        return [head, body, meta, from].filter(Boolean)
      }),
      pool.length > shown.length
        ? `（共 ${pool.length} 条，这里显示前 ${shown.length} 条；用 limit 参数可看更多，上限 50）`
        : null,
      impostors.length
        ? `（末尾 ${impostors.length} 条是疑似仿冒品牌域名 —— 排最后是因为 host 不可信，`
          + `**内容可能是真的**（镜像/搬运常见），核实时优先用前面的一手来源对照）`
        : null,
      `用 Lookup({ card: "${cardId}", index: <序号> }) 打开某条抓全文。`,
      multi || items.length > 3 ? `提示：批量看某几条用 Lookup({ card: "${cardId}", indexes: [0, 3, 5] })（最多 5 条并行）。` : '',
    ].filter(Boolean)
    return lines.join('\n')
  }
}

export class LookupTool extends Tool {
  constructor() {
    super({
      name: 'Lookup',
      description: '打开资料卡里的条目，抓全文落盘返回路径。配合 SearchInfo 用：它返回资料卡 id，本工具按 id+序号取详情。'
        + '**支持批量**：indexes: [0, 3, 5] 一次抓多条（最多 5 条，并行下载）——'
        + '对比多个来源的说法、或一次要看几篇时用它，比逐条调快得多。'
        + '全文以 md 存在 ~/.claude-code-mobile/lookup/，用 Read 看。'
        + '摘要不够下结论、或用户要看详细内容时用。',
      input_schema: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'SearchInfo 返回的资料卡 id（card-开头）' },
          index: { type: 'number', description: '单条序号（资料卡里 [0] [1] 那个数字）' },
          indexes: {
            type: 'array', items: { type: 'number' }, maxItems: 5,
            description: '批量序号，如 [0, 3, 5]（最多 5 条，并行抓取）。与 index 二选一。',
          },
        },
        required: ['card'],
      },
      maxResultSizeChars: 2000,
    })
  }

  /** 抓一条：返回 { ok, title, path, chars, source } 或 { ok:false, reason } */
  async fetchOne(card, idx) {
    const item = card.items?.[idx]
    if (!item) return { ok: false, idx, reason: `序号越界（共 ${card.items?.length || 0} 条）` }
    let full = ''
    try {
      const html = await fetchText(item.url)
      const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      const ps = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).filter((s) => s.length > 20)
      full = (ps.length ? ps.join('\n\n') : stripTags(cleaned)).slice(0, 30000)
    } catch (e) {
      return { ok: false, idx, reason: `抓取失败（${item.source}）: ${e.message}`, url: item.url, title: item.title }
    }
    if (!full || full.length < 30) {
      return {
        ok: false, idx, title: item.title, url: item.url,
        reason: `正文抓不到（页面可能是 JS 渲染）\n     摘要: ${item.snippet || '(无)'}`,
      }
    }
    const mdPath = join(LOOKUP_DIR, `doc-${Date.now()}-${idx}.md`)
    const md = [
      `# ${item.title}`,
      ``,
      `- 来源: ${item.source}（${labelOf(item.trust)}）`,
      `- 链接: ${item.url}`,
      `- 抓取时间: ${new Date().toISOString()}`,
      `- 搜索关键词: ${card.keywords}`,
      ``,
      full,
    ].join('\n')
    try { writeFileSync(mdPath, md, 'utf-8') } catch (e) {
      return { ok: false, idx, reason: `写盘失败: ${e.message}` }
    }
    return { ok: true, idx, title: item.title, path: mdPath, chars: full.length, source: item.source }
  }

  async execute(input) {
    const cardId = String(input?.card ?? '').trim()
    if (!/^card-\d+$/.test(cardId)) return `资料卡 id 无效: ${cardId}（应为 card-数字）`
    const cardPath = join(LOOKUP_DIR, `${cardId}.json`)
    if (!existsSync(cardPath)) return `资料卡不存在: ${cardId}`
    let card
    try { card = JSON.parse(readFileSync(cardPath, 'utf-8')) } catch (e) { return `资料卡损坏: ${e.message}` }

    // 收集序号：indexes 优先，否则用单个 index
    let idxs = Array.isArray(input?.indexes)
      ? input.indexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0)
      : []
    if (!idxs.length && Number.isInteger(Number(input?.index))) idxs = [Number(input.index)]
    idxs = [...new Set(idxs)].slice(0, 5)
    if (!idxs.length) return '需要 index（单个序号）或 indexes（序号数组，最多 5 个）'

    // 单条：保持原来的简洁输出（模型最常用这个路径）
    if (idxs.length === 1) {
      const r = await this.fetchOne(card, idxs[0])
      if (!r.ok) return `「${r.title || ''}」${r.reason}${r.url ? `\n链接: ${r.url}` : ''}`
      return `已抓取「${r.title.slice(0, 40)}」（${r.source}）\n${r.path}\n${r.chars} 字符，用 Read 看`
    }

    // 批量：并行抓，汇总成一张表
    const results = await Promise.all(idxs.map((i) => this.fetchOne(card, i)))
    const okList = results.filter((r) => r.ok)
    const failList = results.filter((r) => !r.ok)
    const lines = [`批量抓取 ${idxs.length} 条：成功 ${okList.length} 条${failList.length ? `，失败 ${failList.length} 条` : ''}`, '']
    for (const r of okList) {
      lines.push(`  [${r.idx}] ${labelOf(card.items[r.idx]?.trust ?? 1)}`)
      lines.push(`      ${String(r.title).slice(0, 55)}（${r.source}，${r.chars} 字符）`)
      lines.push(`      ${r.path}`)
    }
    if (failList.length) {
      lines.push('', '失败的：')
      for (const r of failList) lines.push(`  [${r.idx}] ${String(r.title || '').slice(0, 45)} — ${r.reason}`)
    }
    lines.push('', `用 Read 分别读这些 md 文件（都是完整正文，含来源标注）。`)
    return lines.join('\n')
  }
}
