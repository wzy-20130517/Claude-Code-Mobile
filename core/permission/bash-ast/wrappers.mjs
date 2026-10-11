/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/guarded/wrappers.ts
 * 移植日期：2026-10-11
 *
 * 类型语义（原 TS 声明，仅注释保留）：
 *   unwrapCommand(input: CommandWord[], windows: boolean): CommandWord[] | undefined
 *   返回 undefined 表示无法判定（wrapper 未知选项导致真实命令起点不可知）。
 */
import { optionTable, parseOptions, WRAPPER_SCAN } from './options.mjs';
import { commandBasename } from './word.mjs';

const WRAPPERS = {
  env: optionTable("-i --ignore-environment -0 --null -v --debug", "-u --unset -C --chdir"),
  time: optionTable(
    "-a --append -p --portability -v --verbose -q --quiet",
    "-o --output -f --format",
  ),
  sudo: optionTable(
    "-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin",
    "-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot",
  ),
};

export function unwrapCommand(input, windows) {
  let words = input;
  while (words.length) {
    const name = commandBasename(words[0], windows);
    if (!name) return undefined;
    if (!(name in WRAPPERS)) return words;
    // wrapper 的未知选项决定真实命令从哪个词开始，猜不出只能整体放弃。
    const parsed = parseOptions(words.slice(1), WRAPPERS[name], WRAPPER_SCAN);
    if (parsed.unsupported) return undefined;
    words = parsed.operands;
    if (name === "env" || name === "sudo") {
      while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1);
    }
  }
  return undefined;
}
