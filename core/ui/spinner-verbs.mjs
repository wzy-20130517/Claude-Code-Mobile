// Claude Code Mobile - 思考中的 spinner 趣味词
//
// 【两套 spinner 别混】
//   思考中（等模型响应）→ 随机趣味词，如 Cogitating… / Percolating…
//   工具执行中          → 具体动作，如 Reading core/agent.mjs
// 官方 components/Spinner.tsx 用 sample(getSpinnerVerbs()) 挑词，
// 并且用 useState 只初始化一次 —— 所以一轮之内词是固定的，不会每秒乱跳。
// 我们照这个行为做：每轮开始时定一个词，整轮沿用。
//
// 【词表来源 · 2026-09-04】
// OFFICIAL 部分照搬官方 constants/spinnerVerbs.ts（187 个词）。
// ⚠ 源码路径用 ~/cc-src/claude-code-main/ —— /sdcard/Download/claude-code-source/
// 那份是改过的，且它的 constants/ 目录是空的（找不到这个文件，别去那儿翻）。
// EXTRA 部分是本项目原来自己写的、官方没有的词，一并保留。
//
// 【为什么不掺中文词】
// 命令名（/help /config）、工具名（Read/Bash）、执行文案（Reading/Running）
// 全是英文。spinner 里突然蹦一个「掐指一算」就不一致了 ——
// 照那个逻辑命令就该叫 /帮助。界面术语保持英文，中文只用在正文说明里。

// 官方词表（constants/spinnerVerbs.ts）
const OFFICIAL = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking',
  'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching',
  'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping',
  'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling',
  'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling',
  'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating',
  'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating',
  'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling',
  'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing',
  'Enchanting', 'Envisioning', 'Evaporating', 'Fermenting', 'Fiddle-faddling',
  'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing',
  'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting',
  'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating',
  'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing',
  'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing',
  'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating',
  'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning',
  'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting',
  'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing',
  'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting',
  'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing',
  'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating',
  'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing',
  'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling',
  'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating',
  'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning',
  'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching',
  'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning',
  'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping',
  'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering',
  'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting',
  'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing',
  'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling',
  'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling',
  'Zesting', 'Zigzagging',
]

// 本项目原有、官方词表里没有的（合并时保留，别删）
const EXTRA = [
  'Bamboozling', 'Conjuring', 'Consulting the oracle', 'Distilling', 'Divining',
  'Excavating', 'Extrapolating', 'Fiddling', 'Grinding', 'Hypothesizing',
  'Incanting', 'Interpolating', 'Postulating', 'Prospecting', 'Refactoring thoughts',
  'Riffing', 'Rubber-ducking', 'Rummaging', 'Scrying', 'Summoning',
  'Theorizing', 'Triangulating', 'Untangling', 'Yak-shaving',
]

export const SPINNER_VERBS = [...OFFICIAL, ...EXTRA]

/** 随机挑一个词。调用方应在每轮开始时挑一次并沿用，别每帧重挑。 */
export function pickSpinnerVerb() {
  if (!SPINNER_VERBS.length) return 'Working'
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]
}
