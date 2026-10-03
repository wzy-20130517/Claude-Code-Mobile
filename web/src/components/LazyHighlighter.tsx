import React, { Suspense, lazy } from 'react';

/**
 * 语法高亮的懒加载包装。
 *
 * react-syntax-highlighter 的 Prism 全量包（含所有语言定义）约 622KB，
 * 原来直接 import 会被打进首屏必需的依赖里 —— 但很多对话里根本没有代码块。
 * 这里改成首次真正渲染代码块时才动态加载，未加载完成前显示纯文本（保持可读）。
 *
 * 之所以不用 PrismLight 按需注册语言：模型返回的语言是任意的，
 * 只注册常用几种会让其余语言完全失去高亮，这里选择「全量但延后」。
 */
const Highlighter = lazy(async () => {
  const [{ Prism }, styles] = await Promise.all([
    import('react-syntax-highlighter'),
    import('react-syntax-highlighter/dist/esm/styles/prism'),
  ]);
  const Comp: React.FC<any> = (props) => {
    const { isDark, ...rest } = props;
    return <Prism {...rest} style={isDark ? styles.vscDarkPlus : styles.oneLight} />;
  };
  return { default: Comp };
});

export interface LazyHighlighterProps {
  language: string;
  isDark: boolean;
  customStyle?: React.CSSProperties;
  codeTagProps?: Record<string, any>;
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
  children: string;
}

/** 加载中的降级显示：等宽字体纯文本，排版与高亮后一致，避免布局跳动 */
const PlainFallback: React.FC<{ code: string; customStyle?: React.CSSProperties; isDark: boolean }> = ({ code, customStyle, isDark }) => (
  <pre
    style={{
      margin: 0,
      padding: '12px',
      background: 'transparent',
      fontSize: '15px',
      border: 'none',
      overflowX: 'auto',
      color: isDark ? '#d4d4d4' : '#383a42',
      ...customStyle,
    }}
  >
    <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{code}</code>
  </pre>
);

export const LazyHighlighter: React.FC<LazyHighlighterProps> = ({ children, isDark, customStyle, ...rest }) => (
  <Suspense fallback={<PlainFallback code={children} customStyle={customStyle} isDark={isDark} />}>
    <Highlighter isDark={isDark} customStyle={customStyle} {...rest}>
      {children}
    </Highlighter>
  </Suspense>
);

export default LazyHighlighter;
