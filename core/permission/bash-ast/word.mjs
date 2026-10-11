/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/guarded/word.ts
 * 移植日期：2026-10-11
 *
 * 类型语义（原 TS 声明，仅注释保留）：
 *   CommandWord = {
 *     value: string;            // 去引号/去转义后的词面值
 *     dynamic: boolean;         // 含无法静态判定的展开（$、`、glob、brace 等）
 *     hasUnquotedGlob: boolean; // 含未引用的 glob 字符
 *     start: number; end: number; // 源文本中的区间
 *   }
 */

/** AST 定位后的单词事实；不执行 expansion，也不将未知词当作已知选项。 */
export function literalPosixWord(text, start, end) {
  let value = "";
  let quote = "";
  let dynamic = false;
  let hasUnquotedGlob = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === quote) {
      quote = "";
      continue;
    }
    if (quote !== "'" && c === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        dynamic = true;
        break;
      }
      if (!quote || ["$", "`", '"', "\\", "\n"].includes(next)) {
        if (next !== "\n") value += next;
        i++;
        continue;
      }
    }
    if (!quote && (c === "'" || c === '"')) {
      quote = c;
      continue;
    }
    if (quote !== "'" && (c === "$" || c === "`")) dynamic = true;
    if (!quote && /[*?[{}~]/.test(c)) dynamic = true;
    if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true;
    value += c;
  }
  return { value, dynamic: dynamic || Boolean(quote), hasUnquotedGlob, start, end };
}

/**
 * 命令名（去掉路径前缀）。返回 undefined 表示无法判定：词是动态的。
 * @param {object} word - CommandWord
 * @param {boolean} windows
 * @returns {string | undefined}
 */
export function commandBasename(word, windows) {
  if (word.dynamic) return undefined;
  const name = word.value.split(windows ? /[\\/]/ : /\//).at(-1);
  return windows ? name.toLowerCase().replace(/\.exe$/, "") : name;
}
