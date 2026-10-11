/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/guarded/options.ts
 * 移植日期：2026-10-11
 *
 * 类型语义（原 TS 声明，仅注释保留）：
 *   OptionArity    = "flag" | "value" | "optional"
 *   OptionTable    = Readonly<Record<string, OptionArity>>
 *   ParsedOptions  = { flags: string[]; operands: CommandWord[]; unsupported: boolean }
 *   OptionScanPolicy = { ordering: "stop-at-operand" | "interspersed"; unknown: "abort" | "continue" }
 */

/**
 * 扫描策略必须由调用方显式声明，没有默认值。
 * - ordering：wrapper/前置参数在首个操作数停止；目标命令自身允许选项与操作数交错。
 * - unknown：wrapper 遇到未知选项猜不出真实命令从哪开始，只能 abort；
 *   目标命令的存在性规则（rm -rf、--delete、--force）不因后面多一个未知词而失效，
 *   continue 只标记 unsupported、不消费下一个词、不进入 flags，让调用方按"命中优先"收敛。
 */
export const WRAPPER_SCAN = {
  ordering: "stop-at-operand",
  unknown: "abort",
};
export const COMMAND_SCAN = {
  ordering: "interspersed",
  unknown: "continue",
};

/**
 * 有限选项文法：先消耗已声明 arity 的参数值；未知选项不猜 arity。
 * @param {object[]} words - CommandWord[]
 * @param {Record<string, string>} table - 选项名 → arity（"flag" | "value" | "optional"）
 * @param {object} policy - OptionScanPolicy
 * @returns {{ flags: string[], operands: object[], unsupported: boolean }}
 */
export function parseOptions(words, table, policy) {
  const result = { flags: [], operands: [], unsupported: false };
  let ended = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!ended && !word.dynamic && word.value === "--") {
      ended = true;
      continue;
    }
    if (ended || word.dynamic || !word.value.startsWith("-") || word.value === "-") {
      result.operands.push(word);
      if (policy.ordering === "stop-at-operand") {
        result.operands.push(...words.slice(i + 1));
        break;
      }
      continue;
    }
    const long = word.value.startsWith("--");
    const equals = word.value.indexOf("=");
    const names = long
      ? [equals < 0 ? word.value : word.value.slice(0, equals)]
      : Array.from(word.value.slice(1), (c) => `-${c}`);
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const arity = table[name];
      const attached = long ? equals >= 0 : n < names.length - 1;
      // 根因（2026-09-17 review）：此前未知选项直接 return，把 `rm -rfx` 中已识别的 -r/-f 一并丢弃，
      // 整条命令退回 YOLO 静默执行。abort 仅保留给 wrapper/前置参数。
      if (!arity || (arity === "flag" && long && attached)) {
        result.unsupported = true;
        if (policy.unknown === "abort") return result;
        continue;
      }
      result.flags.push(name);
      if (arity === "value" && !attached) {
        if (!words[++i]) result.unsupported = true;
      }
      if (arity !== "flag") break;
    }
  }
  return result;
}

/**
 * 由三组空格分隔的选项名构造 OptionTable。
 * @param {string} flags
 * @param {string} values
 * @param {string} optional
 * @returns {Record<string, string>}
 */
export function optionTable(flags, values = "", optional = "") {
  return Object.fromEntries([
    ...flags
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "flag"]),
    ...values
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "value"]),
    ...optional
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "optional"]),
  ]);
}

export function enabled(flags, yes, no = []) {
  let result = false;
  for (const flag of flags) {
    if (yes.includes(flag)) result = true;
    if (no.includes(flag)) result = false;
  }
  return result;
}

/**
 * 命中优先：有可靠命中就返回规则；否则遇到过未知选项为 unsupported，否则为已支持未命中。
 * @param {string | false} rule
 * @param {{ unsupported: boolean }} parsed
 * @returns {string | false | undefined} undefined=超出当前命令/选项文法
 */
export function settleRule(rule, parsed) {
  return rule || (parsed.unsupported ? undefined : false);
}
