/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts
 * 移植日期：2026-10-11
 *
 * 类型语义（原 TS 声明，仅注释保留）：
 *   BashCommandOperator  = "&&" | "||" | "|" | "|&" | "sequence"
 *   BashCommandEnvAssignment = { name: string|undefined; value: string|undefined }
 *   BashCommandRedirect  = { fileDescriptor: number|undefined; operator: string; target: string }
 *   BashCommandInvocation = {
 *     words: CommandWord[]; argv: string[]; commandText: string;
 *     envAssignments: BashCommandEnvAssignment[]; hasAssignmentPrefix: boolean;
 *     hasDynamicWords: boolean; hasRedirects: boolean; name: string;
 *     operatorBefore?: BashCommandOperator; redirects: BashCommandRedirect[];
 *   }
 *   BashCommandAnalysis = {
 *     commands: BashCommandInvocation[]; hasDynamicWords: boolean; hasParseErrors: boolean;
 *     hasRedirects: boolean; hasUnsupportedSyntax: boolean; unsupportedNodeTypes: string[];
 *   }
 *   CollectContext = { analysis: MutableBashCommandAnalysis; operatorBefore?: BashCommandOperator;
 *                      statementRedirects: Redirect[] }
 */
import { parse } from 'unbash';
import { literalPosixWord } from './word.mjs';

const MAX_BASH_PARSE_LENGTH = 10_000;
const SUPPORTED_CONTAINER_NODES = new Set(["AndOr", "Pipeline", "Statement"]);

export function analyzeBashCommand(command) {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return emptyAnalysis();
  }
  if (command.length > MAX_BASH_PARSE_LENGTH) {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  let script;
  try {
    script = parse(command);
  } catch {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  const analysis = {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: Boolean(script.errors?.length),
    hasRedirects: false,
    unsupportedNodeTypes: new Set(),
  };

  for (let index = 0; index < script.commands.length; index += 1) {
    collectStatementCommands(command, script.commands[index], {
      analysis,
      operatorBefore: index === 0 ? undefined : "sequence",
      statementRedirects: [],
    });
  }

  return freezeAnalysis(analysis);
}

export function isBashCommandPermissionSafe(analysis) {
  return !analysis.hasParseErrors && !analysis.hasUnsupportedSyntax && !analysis.hasDynamicWords;
}

function collectStatementCommands(source, statement, context) {
  if (statement.background) {
    context.analysis.unsupportedNodeTypes.add("background");
  }
  if (statement.redirects.length > 0) {
    context.analysis.hasRedirects = true;
    if (redirectsHaveDynamicWords(statement.redirects)) context.analysis.hasDynamicWords = true;
  }

  collectNodeCommands(source, statement.command, {
    ...context,
    statementRedirects: [...context.statementRedirects, ...statement.redirects],
  });
}

function collectNodeCommands(source, node, context) {
  switch (node.type) {
    case "Command":
      collectSimpleCommand(source, node, context);
      return;
    case "AndOr":
      collectAndOrCommands(source, node, context);
      return;
    case "Pipeline":
      collectPipelineCommands(source, node, context);
      return;
    case "Statement":
      collectStatementCommands(source, node, context);
      return;
    default:
      context.analysis.unsupportedNodeTypes.add(node.type);
  }
}

function collectAndOrCommands(source, node, context) {
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index], {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
}

function collectPipelineCommands(source, node, context) {
  const firstCommandIndex = context.analysis.commands.length;
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index], {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
  // unbash 将 time 关键字从 argv 提升为 Pipeline.time；恢复这个已定位的 wrapper，
  // 否则 time -o file 的参数会被误当成 executable，漏掉后续真实命令。
  const first = context.analysis.commands[firstCommandIndex];
  if (node.time && first) {
    const prefix = source.slice(node.pos, first.words[0]?.start);
    const time = /\btime\b/.exec(prefix);
    if (time)
      first.words.unshift({
        value: "time",
        dynamic: false,
        hasUnquotedGlob: false,
        start: node.pos + time.index,
        end: node.pos + time.index + 4,
      });
  }
}

function collectSimpleCommand(source, command, context) {
  const redirects = [...context.statementRedirects, ...command.redirects];
  const words = [command.name, ...command.suffix].filter(isWord);
  const argv = words.map(wordValue);
  const envAssignments = command.prefix.map((assignment) => ({
    name: assignment.name,
    value: assignment.value ? wordValue(assignment.value) : undefined,
  }));
  const hasDynamicWords =
    words.some(wordHasDynamicParts) ||
    command.prefix.some(
      (assignment) => assignment.value !== undefined && wordHasDynamicParts(assignment.value),
    ) ||
    redirectsHaveDynamicWords(redirects);

  if (hasDynamicWords) context.analysis.hasDynamicWords = true;
  if (redirects.length > 0) context.analysis.hasRedirects = true;

  const name = command.name ? wordValue(command.name) : "";
  context.analysis.commands.push({
    words: words.map((word) => {
      const fact = literalPosixWord(word.text, word.pos, word.end);
      // 只取顶层字面片段的 glob；变量/命令替换/brace 的载荷不是删除目标的词面证据。
      if (word.parts)
        fact.hasUnquotedGlob = word.parts.some(
          (part) =>
            part.type === "Literal" &&
            literalPosixWord(part.text, 0, part.text.length).hasUnquotedGlob,
        );
      return fact;
    }),
    argv,
    commandText: source.slice(command.pos, command.end),
    envAssignments,
    hasAssignmentPrefix: command.prefix.length > 0,
    hasDynamicWords,
    hasRedirects: redirects.length > 0,
    name,
    operatorBefore: context.operatorBefore,
    redirects: redirects.map((redirect) => ({
      fileDescriptor: redirect.fileDescriptor,
      operator: redirect.operator,
      target: redirectTargetValue(redirect),
    })),
  });
}

function redirectTargetValue(redirect) {
  if (redirect.target !== undefined) return wordValue(redirect.target);
  return redirect.content ?? "";
}

function redirectsHaveDynamicWords(redirects) {
  return redirects.some((redirect) => {
    return (
      (redirect.target !== undefined && wordHasDynamicParts(redirect.target)) ||
      (redirect.body !== undefined && wordHasDynamicParts(redirect.body))
    );
  });
}

function wordHasDynamicParts(word) {
  // 命令替换和进程替换会在主命令前执行，权限判断不能把它们当成普通 argv。
  return word.parts?.some(partHasDynamicExecution) ?? false;
}

function partHasDynamicExecution(part) {
  switch (part.type) {
    case "AnsiCQuoted":
    case "Literal":
    case "SingleQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(partHasDynamicExecution);
    case "CommandExpansion":
    case "ProcessSubstitution":
      return true;
    case "ArithmeticExpansion":
    case "BraceExpansion":
    case "ExtendedGlob":
    case "ParameterExpansion":
    case "SimpleExpansion":
      return true;
    default:
      return true;
  }
}

function wordValue(word) {
  return word.value ?? word.text;
}

function isWord(word) {
  return word !== undefined;
}

function emptyAnalysis() {
  return {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: false,
    hasRedirects: false,
    hasUnsupportedSyntax: false,
    unsupportedNodeTypes: [],
  };
}

function freezeAnalysis(analysis) {
  const unsupportedNodeTypes = [...analysis.unsupportedNodeTypes].filter(
    (type) => !SUPPORTED_CONTAINER_NODES.has(type),
  );

  return {
    commands: analysis.commands,
    hasDynamicWords: analysis.hasDynamicWords,
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasUnsupportedSyntax: unsupportedNodeTypes.length > 0,
    unsupportedNodeTypes,
  };
}
