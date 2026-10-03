export const LOCALIZED_CATEGORIES: Record<string, string> = {
  all: '全部',
  learn: '学习',
  'life-hacks': '生活技巧',
  games: '游戏',
  creative: '创意',
  'touch-grass': '放松一下',
};

const INSPIRATION_TEXT: Record<string, { name: string; description: string }> = {
  'Writing editor': { name: '写作编辑器', description: '通过反馈错误和改进方向，让文字更清晰、更易读' },
  'Email writing assistant': { name: '邮件写作助手', description: '写下想法，让 Claude 帮你润色出合适的邮件' },
  'Meeting notes summary': { name: '会议记录总结', description: '把原始会议记录整理成结构清晰的总结' },
  'One-pager PRD maker': { name: '一页式 PRD 生成器', description: '快速整理产品需求和项目规划' },
  'My weekly chronicle': { name: '我的每周纪事', description: '记录并回顾每周发生的重要事情' },
  Flashcards: { name: '闪卡学习', description: '上传文字或描述主题，生成学习闪卡' },
  PyLingo: { name: 'PyLingo Python 学习', description: '通过循序渐进的教程学习 Python' },
  'Molecule studio': { name: '分子工作室', description: '通过互动分子可视化学习化学' },
  'Language learning tutor': { name: '语言学习导师', description: '在对话中练习语言并获得即时反馈' },
  'Origin stories': { name: '起源故事', description: '探索事物、概念和文化背后的起源' },
  CodeVerter: { name: '代码转换器', description: '在不同编程语言之间转换代码' },
  'Project dashboard generator': { name: '项目仪表盘生成器', description: '根据项目需求创建状态面板和进度视图' },
  'Interactive drum machine': { name: '互动鼓机', description: '描述想要的节奏并用界面调整鼓点' },
  'Join dots': { name: '连点游戏', description: '玩一局经典的四子连线游戏' },
  Piano: { name: '钢琴', description: '在浏览器中弹奏并探索互动钢琴' },
  'Your life in weeks': { name: '人生周历', description: '用可视化方式思考时间的流逝' },
  'Dream interpreter': { name: '梦境解读', description: '描述梦境并探索其中可能的含义' },
  'Team activity ideas': { name: '团队活动点子', description: '为不同场景设计有趣的团队活动' },
  'Magic in the grass': { name: '草地里的魔法', description: '探索一个充满惊喜的互动创意体验' },
  'How petty are you?': { name: '你的计较程度', description: '用轻松有趣的方式了解自己的小心思' },
  'Historical SVG amphitheater': { name: '历史 SVG 剧场', description: '观看 Claude 用 SVG 重现历史上的著名事件' },
  'Stories in the sky': { name: '天空中的故事', description: '在星空中创造属于你的故事' },
  'Word cloud maker': { name: '词云生成器', description: '把文字转换成漂亮的互动词云' },
  'Sakura serenity': { name: '樱花静境', description: '沉浸在宁静的樱花互动场景中' },
  'Better than very': { name: '比“非常”更好的表达', description: '寻找更准确、更有表现力的词语' },
};

export function localizeInspiration<T extends { name?: string; description?: string }>(item: T): T {
  const text = item.name ? INSPIRATION_TEXT[item.name] : undefined;
  return text ? { ...item, name: text.name, description: text.description } : item;
}
