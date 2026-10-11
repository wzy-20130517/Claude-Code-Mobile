/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts
 * 移植日期：2026-10-11
 *
 * 移植说明：原文件 `import type { ExecutionShellSelection } from "@zcode/contracts"` 仅用于
 * 取 dialect 类型（"cmd" | "posix" | "git-bash" | "legacy-shell"），是纯类型依赖、无运行时代码，
 * 故直接删除该 import，dialect 按普通字符串处理。其余依赖（parser/cmd/git/find/windows-delete/
 * options/wrappers/word）均已随本目录一并移植。
 *
 * 类型语义（原 TS 声明，仅注释保留）：
 *   DangerousCommandResult =
 *     | { status: "matched"; ruleId: string; start: number; end: number }
 *     | { status: "notMatched" | "unsupported" }
 *   dialect: ExecutionShellSelection["dialect"]（见上）
 */
import { analyzeBashCommand } from './parser.mjs';
import { analyzeCmdCommand } from './cmd.mjs';
import { matchGit } from './git.mjs';
import { matchFindDelete } from './find.mjs';
import { matchCmdDelete, matchRobocopyDelete } from './windows-delete.mjs';
import { COMMAND_SCAN, enabled, optionTable, parseOptions, settleRule } from './options.mjs';
import { unwrapCommand } from './wrappers.mjs';
import { commandBasename } from './word.mjs';

const RM = optionTable(
  "-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version",
  "",
  "--interactive",
);
const RSYNC_DELETE = [
  "--delete",
  "--del",
  "--delete-before",
  "--delete-during",
  "--delete-delay",
  "--delete-after",
  "--delete-excluded",
];
const RSYNC = optionTable(
  `-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE.join(" ")}`,
  "-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest",
);
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);
const MAX_LENGTH = 10_000;

export function matchDangerousCommand(command, dialect) {
  if (command.length > MAX_LENGTH || dialect === "legacy-shell") return { status: "unsupported" };
  const windows = dialect === "cmd" || dialect === "git-bash";
  let commands;
  let unsupported;
  if (dialect === "cmd") {
    ({ commands, unsupported } = analyzeCmdCommand(command));
  } else {
    const analysis = analyzeBashCommand(command);
    // 解析失败没有可依赖的定位；局部 unsupported 节点则不丢弃其它独立命令。
    if (analysis.hasParseErrors) return { status: "unsupported" };
    commands = analysis.commands.map((c) => c.words);
    unsupported = analysis.hasUnsupportedSyntax;
  }
  for (const invocation of commands) {
    const words = unwrapCommand(invocation, windows);
    if (!words?.[0]) {
      unsupported = true;
      continue;
    }
    const name = commandBasename(words[0], windows);
    const result = name ? matchInvocation(name, words.slice(1), dialect) : undefined;
    if (result)
      return {
        status: "matched",
        ruleId: `safety.bash.${result}`,
        start: words[0].start,
        end: words.at(-1).end,
      };
    if (result === undefined || words.some((word) => word.dynamic)) unsupported = true;
  }
  return { status: unsupported ? "unsupported" : "notMatched" };
}

function matchInvocation(name, args, dialect) {
  if (name === "git") return matchGit(args);
  if (INTERPRETERS.has(name)) return undefined;
  if (dialect === "cmd" && ["rd", "rmdir", "del", "erase"].includes(name))
    return matchCmdDelete(name, args);
  if (dialect !== "cmd" && name === "find") return matchFindDelete(args);
  if ((dialect === "cmd" || dialect === "git-bash") && name === "robocopy")
    return matchRobocopyDelete(args, dialect);
  if (name === "rm") {
    const parsed = parseOptions(args, RM, COMMAND_SCAN);
    // BSD rm 在首个目标后不再解析选项；存在性扫描会吞掉后续 --help 等真实文件名。
    // 目标计数单独按该语义扫描，危险选项仍保留 GNU 的交错扫描，不探测运行平台。
    const targets = parseOptions(args, RM, { ordering: "stop-at-operand", unknown: "continue" });
    // 递归或语法上的批量即可；不展开目标，不用帮助/交互选项取消已知危险证据。
    return settleRule(
      (enabled(parsed.flags, ["-r", "-R", "--recursive"]) ||
        targets.operands.length >= 2 ||
        targets.operands.some((word) => word.hasUnquotedGlob)) &&
        "remove-critical-path",
      parsed,
    );
  }
  if (["dd", "mount", "umount", "mkfs"].includes(name) || /^mkfs\.[a-zA-Z0-9_-]+$/.test(name)) {
    // 只豁免独立且明确的查询形式，不能把 -o/其它参数值中的 --help 当成退出选项。
    if (args.length === 1 && !args[0].dynamic && ["--help", "--version"].includes(args[0].value))
      return false;
    return !(name === "mount" && args.length === 0) && "system-storage";
  }
  if (name === "rsync") {
    const parsed = parseOptions(args, RSYNC, COMMAND_SCAN);
    return settleRule(
      !parsed.flags.some((f) => ["-n", "--dry-run", "--help", "--version"].includes(f)) &&
        parsed.flags.some((f) => RSYNC_DELETE.includes(f)) &&
        "rsync-delete",
      parsed,
    );
  }
  return false;
}
