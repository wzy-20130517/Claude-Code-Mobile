// 重启前硬闸：不依赖模型「记得」手动检查。
//
// 仅 node --check 不足：`visionApi is not defined` 一类错误语法完全合法，
// 只能在程序运行到那一行时才触发 ReferenceError。2026-08-18 曾因此让 CLI
// 重启后直接 main-fatal，所以预检必须同时检查：
//   1) node --check：语法；
//   2) AST 裸标识符检查：未声明变量（防运行期 ReferenceError）；
//   3) 本地 ESM import/export 链接检查（防 named export 不存在）。
//
// 安全原则：检查器自身不可用 / 扫描失败 / 任一检查失败 => 一律拒绝重启。
// CLI 入口 index.mjs 每次必查；其他模块检查最近修改的文件以控制等待时间。
import { existsSync, lstatSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { DATA_DIR } from './paths.mjs'

const require = createRequire(import.meta.url)
const RECENT_MS = 5 * 60 * 1000
const MAX_PARALLEL = 8

function collectMjs(path, out, errors, seen = new Set()) {
  try {
    if (!existsSync(path)) {
      errors.push({ file: relative(process.cwd(), path), detail: '路径不存在' })
      return
    }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      if (path.endsWith('.mjs')) out.push(path)
      return
    }
    if (!stat.isDirectory()) return
    const key = resolve(path)
    if (seen.has(key)) return
    seen.add(key)
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === '.git' || name === '.claude-code-mobile') continue
      collectMjs(join(path, name), out, errors, seen)
    }
  } catch (error) {
    errors.push({ file: relative(process.cwd(), path), detail: `扫描失败: ${error.message}` })
  }
}

function isRecentlyModified(file, now) {
  try { return now - statSync(file).mtimeMs < RECENT_MS } catch { return true }
}

// ── 未改动快路径（2026-09-17）─────────────────────────────
//
// 背景：Ctrl+X 每次重启都要跑一遍完整预检（module-links 递归解析全依赖图，
// 实测 3~9s）。但绝大多数重启的代码和上次预检成功时**一模一样**（用户没改任何东西，
// 比如连按 Ctrl+X、或启动后立刻重启），重跑纯浪费。
//
// 方案：成功一次就把「文件集 + 每个文件的 sha1」写进指纹文件。下次预检先比对：
// 全部一致 → 直接放行（~20ms）；任一不一致 → 走全量检查。
//
// 为什么不用 mtime：mtime 可以被保留/伪造（cp -p、tar 解包、touch -r），
// 而这是重启硬闸，不能用可伪造的弱证据。129 个文件共 2MB，
// 读+sha1 实测 30~110ms，换「内容确实没变」的强证明，值。
//
// 安全底线（宁可慢也不能漏）：
//   - 指纹缺失/损坏/读取异常 → 全量检查
//   - 任何文件读不出、集合不一致、哈希对不上 → 全量检查
//   - 预检**失败**时主动删指纹：失败期间的不一致状态绝不留给下一次
//   - STAMP_REV 是检查器逻辑版本：以后加/改检查项必须 +1，旧指纹全部作废
const STAMP_REV = 2
const STAMP_FILE = 'preflight-ok.json'
// 【2026-10-03】预检戳记改放用户数据目录（不再污染源码）
function stampPath(_projectRoot) { return join(DATA_DIR, STAMP_FILE) }

function sha1File(file) {
  try { return createHash('sha1').update(readFileSync(file)).digest('hex') } catch { return null }
}

function readStamp(projectRoot) {
  try {
    const raw = JSON.parse(readFileSync(stampPath(projectRoot), 'utf-8'))
    if (!raw || raw.rev !== STAMP_REV || !Array.isArray(raw.files)) return null
    return raw
  } catch { return null }
}

function writeStamp(projectRoot, files) {
  try {
    const dir = DATA_DIR
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const entries = files.map(f => [relative(projectRoot, f), sha1File(f)])
    if (entries.some(([, h]) => h == null)) return
    writeFileSync(stampPath(projectRoot), JSON.stringify({ rev: STAMP_REV, at: new Date().toISOString(), files: entries }), 'utf-8')
  } catch {}
}

function clearStamp(projectRoot) {
  try { rmSync(stampPath(projectRoot), { force: true }) } catch {}
}

/**
 * 快路径判定：文件集一致 + 每个文件 sha1 与上次通过时一致 → 可信放行。
 * 任何一步不满足都返回 false（走全量检查）。
 */
function canFastPass(projectRoot, files, stamp) {
  if (!stamp) return false
  const recorded = new Map(stamp.files)
  if (recorded.size !== files.length) return false
  for (const f of files) {
    const rel = relative(projectRoot, f)
    const expect = recorded.get(rel)
    if (typeof expect !== 'string') return false
    if (sha1File(f) !== expect) return false
  }
  return true
}

/** 并发执行 node --check。 */
function checkSyntax(files, cwd) {
  return new Promise(resolvePromise => {
    const errors = []
    if (!files.length) return resolvePromise(errors)
    let next = 0
    let active = 0
    let completed = 0

    const runNext = () => {
      while (active < MAX_PARALLEL && next < files.length) {
        const file = files[next++]
        active++
        let stderr = ''
        let spawnError = null
        let child
        try {
          child = spawn(process.execPath, ['--check', file], { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
          child.stderr.on('data', chunk => { stderr += String(chunk) })
          child.on('error', error => { spawnError = error })
          child.on('close', code => {
            active--
            completed++
            if (code !== 0 || spawnError) {
              errors.push({
                file: relative(cwd, file),
                detail: String(stderr).trim() || spawnError?.message || `node --check exit ${code}`,
              })
            }
            if (completed === files.length) resolvePromise(errors)
            else runNext()
          })
        } catch (error) {
          active--
          completed++
          errors.push({ file: relative(cwd, file), detail: `无法启动 node --check: ${error.message}` })
          if (completed === files.length) resolvePromise(errors)
        }
      }
    }
    runNext()
  })
}

// Node/ECMAScript 可作为裸全局引用的名称。静态检查目标是「未声明变量」，不是类型检查。
const KNOWN_GLOBALS = new Set([
  'AbortController', 'AbortSignal', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'Boolean',
  'Buffer', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Function',
  'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy',
  'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String',
  'Symbol', 'SyntaxError', 'TextDecoder', 'TextEncoder', 'TypeError', 'URIError', 'URL',
  'URLSearchParams', 'WeakMap', 'WeakRef', 'WeakSet', 'WebAssembly', 'atob', 'btoa',
  'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'fetch', 'global', 'globalThis',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'performance', 'process', 'queueMicrotask',
  'require', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone', 'undefined',
  'unescape', '__dirname', '__filename', 'exports', 'module',
  // TypedArray 全家（原来只有 ArrayBuffer / DataView，漏了这些 ——
  // core/vscreen.mjs 一直在用 Int32Array，只是那文件之前没被改动过、
  // 预检跳过未修改文件所以没暴露。2026-09-13 补）
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
  // Node functions historically used as direct globals in this codebase.
  'execSync',
  // 【2026-10-03 补】Node 18+ 的 Web 标准全局（Edge TTS 用 WebSocket、
  // imagegen 用 Blob/FormData 构造 multipart 请求）。
  // 漏了它们会误报「运行期未声明标识符」拦下重启 —— 实测踩到。
  'WebSocket', 'Blob', 'FormData', 'Headers', 'Request', 'Response',
  'ReadableStream', 'WritableStream', 'TransformStream', 'crypto',
])

function loadTypeScript(errors) {
  try {
    // Web build 已安装 TypeScript；只用其 AST parser，绝不执行受检源码。
    // 路径注意：本文件在 core/infra/，要回退两级到项目根（重组前在 core/ 只需一级）。
    return require('../../web/node_modules/typescript')
  } catch (error) {
    errors.push({
      file: 'core/infra/restart-preflight.mjs',
      detail: `无法加载 AST 静态检查器 TypeScript：${error.message}。为安全起见拒绝重启。`,
    })
    return null
  }
}

function addBindingNames(ts, name, bindings) {
  if (!name) return
  if (ts.isIdentifier(name)) {
    bindings.add(name.text)
    return
  }
  if (ts.isBindingElement(name)) {
    addBindingNames(ts, name.name, bindings)
    return
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements || []) addBindingNames(ts, element, bindings)
  }
}

/**
 * 收集全文件的声明名。为避免把闭包/块内局部变量误判，这里有意不做作用域严格校验；
 * 因而会漏掉「同名变量作用域错误」，但稳定抓住删掉 let/const/import 后留下的裸引用。
 */
function collectBindings(ts, source) {
  const bindings = new Set()
  const visit = node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      addBindingNames(ts, node.name, bindings)
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      bindings.add(node.name.text)
    } else if (ts.isImportClause(node)) {
      if (node.name) bindings.add(node.name.text)
      const named = node.namedBindings
      if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text)
      if (named && ts.isNamedImports(named)) for (const specifier of named.elements) bindings.add(specifier.name.text)
    } else if (ts.isCatchClause(node)?.variableDeclaration) {
      addBindingNames(ts, node.variableDeclaration.name, bindings)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return bindings
}

function isNonReferenceIdentifier(ts, node) {
  const parent = node.parent
  if (!parent) return false
  // obj.foo 的 foo、对象字面量 key、声明名等都不是变量引用。
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  // import.meta：meta 是 MetaProperty 的语法组成，不是运行期变量。
  if (ts.isMetaProperty?.(parent)) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  // 解构重命名的源键名：const { Tool: McpBaseTool } = mod
  // 这里的 Tool 是被解构对象的属性名，不是当前作用域的变量引用。
  // 少了这条会把它误判成「运行期未声明标识符」，白白拦下重启。
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true

  if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node) return true
  // static get XXX() / set XXX(v)：getter/setter 名是类成员名，不是变量引用
  if ((ts.isGetAccessorDeclaration?.(parent) || ts.isSetAccessorDeclaration?.(parent)) && parent.name === node) return true
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node) return true
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node) return true
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent)) return true
  if (ts.isLabeledStatement(parent) && parent.label === node) return true
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return true
  // Type-only nodes do not exist at runtime.
  if (ts.isTypeReferenceNode?.(parent) || ts.isQualifiedName?.(parent)) return true
  return false
}

function findUndeclaredReferences(ts, file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const bindings = collectBindings(ts, source)
  const found = new Map()
  const visit = node => {
    if (ts.isIdentifier(node) && !isNonReferenceIdentifier(ts, node)) {
      const name = node.text
      if (!bindings.has(name) && !KNOWN_GLOBALS.has(name) && !found.has(name)) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
        found.set(name, { name, line: pos.line + 1, column: pos.character + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found.values()]
}

function hasModifier(ts, node, kind) {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === kind))
}

function resolveLocalModule(file, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
  const base = specifier.startsWith('/') ? resolve(specifier) : resolve(dirname(file), specifier)
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.cjs`,
    join(base, 'index.mjs'),
    join(base, 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) return resolve(candidate)
    } catch {
      // 文件可能在预检期间消失，统一按模块不存在处理。
    }
  }
  return undefined
}

function getModuleSpecifier(ts, node) {
  return node?.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null
}

function collectRuntimeExports(ts, file, cache = new Map()) {
  const key = resolve(file)
  if (cache.has(key)) return cache.get(key)

  const exports = new Set()
  cache.set(key, exports)
  const source = ts.createSourceFile(key, readFileSync(key, 'utf8'), ts.ScriptTarget.Latest, true)

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(ts, declaration.name, exports)
      }
      continue
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)) exports.add('default')
      else if (statement.name) exports.add(statement.name.text)
      continue
    }

    if (ts.isExportAssignment(statement)) {
      exports.add('default')
      continue
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const specifier = getModuleSpecifier(ts, statement)
    const clause = statement.exportClause

    if (!specifier) {
      if (clause && ts.isNamedExports(clause)) {
        for (const item of clause.elements) {
          if (!item.isTypeOnly) exports.add(item.name.text)
        }
      }
      continue
    }

    const sourceFile = resolveLocalModule(key, specifier)
    if (!sourceFile) continue
    const sourceExports = collectRuntimeExports(ts, sourceFile, cache)
    if (!clause) {
      for (const name of sourceExports) {
        if (name !== 'default') exports.add(name)
      }
    } else if (ts.isNamespaceExport(clause)) {
      exports.add(clause.name.text)
    } else if (ts.isNamedExports(clause)) {
      for (const item of clause.elements) {
        if (!item.isTypeOnly) exports.add(item.name.text)
      }
    }
  }

  return exports
}

function moduleLinkLocation(ts, source, node) {
  const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${pos.line + 1}:${pos.character + 1}`
}

function findModuleLinkErrors(ts, file, root, state) {
  const key = resolve(file)
  if (state.visited.has(key)) return []
  state.visited.add(key)

  const source = ts.createSourceFile(key, readFileSync(key, 'utf8'), ts.ScriptTarget.Latest, true)
  const errors = []
  const report = detail => errors.push({ file: relative(root, key), detail })

  const checkReference = (node, specifier, importedNames) => {
    const localFile = resolveLocalModule(key, specifier)
    if (localFile === null) return // node: / npm 包交给 Node 解析，不在这里猜包导出。
    if (!localFile) {
      report(`本地 ESM 模块不存在：${specifier}（${moduleLinkLocation(ts, source, node)}）。重启已阻止。`)
      return
    }

    const available = collectRuntimeExports(ts, localFile, state.exportCache)
    for (const { name, kind } of importedNames) {
      if (!available.has(name)) {
        report(`本地 ESM ${kind} 不存在：${name}（来自 ${specifier}；${moduleLinkLocation(ts, source, node)}）。重启已阻止。`)
      }
    }
    errors.push(...findModuleLinkErrors(ts, localFile, root, state))
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = getModuleSpecifier(ts, statement)
      if (!specifier) continue
      const clause = statement.importClause
      const importedNames = []
      if (clause?.name) importedNames.push({ name: 'default', kind: 'default import' })
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          if (!item.isTypeOnly) {
            importedNames.push({ name: item.propertyName?.text || item.name.text, kind: 'named export' })
          }
        }
      }
      checkReference(statement, specifier, importedNames)
      continue
    }

    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const specifier = getModuleSpecifier(ts, statement)
      if (!specifier) continue
      const clause = statement.exportClause
      const importedNames = []
      if (clause && ts.isNamedExports(clause)) {
        for (const item of clause.elements) {
          if (!item.isTypeOnly) {
            importedNames.push({ name: item.propertyName?.text || item.name.text, kind: 're-export' })
          }
        }
      }
      checkReference(statement, specifier, importedNames)
    }
  }

  return errors
}

export async function runRestartPreflight(root = process.cwd()) {
  const projectRoot = resolve(root)
  const files = []
  const errors = []
  const entryFile = join(projectRoot, 'index.mjs')

  collectMjs(entryFile, files, errors)
  collectMjs(join(projectRoot, 'core'), files, errors)
  collectMjs(join(projectRoot, 'web'), files, errors)
  if (!files.length) {
    errors.push({ file: '.', detail: '没有找到任何待检查的 .mjs 文件' })
    return { ok: false, checked: 0, skipped: 0, errors }
  }

  // 快路径：与上次成功预检相比文件集与内容哈希均未变 → 直接放行（~20ms）。
  // 只在扫描无错时尝试；stamp 读取的任何异常都会返回 null → 退回全量。
  if (errors.length === 0) {
    const stamp = readStamp(projectRoot)
    if (canFastPass(projectRoot, files, stamp)) {
      return { ok: true, checked: 0, skipped: files.length, cached: true, errors: [] }
    }
  }

  const now = Date.now()
  const targets = files.filter(file => isRecentlyModified(file, now))
  // CLI 入口是最重要的运行边界：不允许因为 mtime 过期而跳过。
  if (existsSync(entryFile) && !targets.includes(entryFile)) targets.push(entryFile)
  targets.sort()

  // syntax（node --check 子进程，Android 上单次 ~500ms）与 TS 加载彼此独立：
  // 先起 syntax 的并发执行，再同步加载 TS —— 两边重叠，省 0.5~1s 串行等待。
  const syntaxPromise = checkSyntax(targets, projectRoot)
  const ts = loadTypeScript(errors)
  errors.push(...(await syntaxPromise))

  // 第二道门：专门防 `visionApi is not defined` 类语法绿、运行红的问题。
  if (ts) {
    for (const file of targets) {
      try {
        for (const ref of findUndeclaredReferences(ts, file)) {
          errors.push({
            file: relative(projectRoot, file),
            detail: `运行期未声明标识符：${ref.name}（${ref.line}:${ref.column}）。重启已阻止。`,
          })
        }
      } catch (error) {
        errors.push({ file: relative(projectRoot, file), detail: `未声明变量静态检查失败: ${error.message}` })
      }
    }

    // 第三道门：node --check 不会解析 ESM 的 named export 是否真的存在。
    // 从 targets 递归检查本地静态依赖，覆盖「import 名字被改了但 export 没改」这类重启即崩。
    const moduleLinkState = { exportCache: new Map(), visited: new Set() }
    for (const file of targets) {
      try {
        errors.push(...findModuleLinkErrors(ts, file, projectRoot, moduleLinkState))
      } catch (error) {
        errors.push({ file: relative(projectRoot, file), detail: `ESM import/export 静态检查失败: ${error.message}` })
      }
    }
  }

  const ok = errors.length === 0
  if (ok) {
    // 记录「这次通过时每个文件的 sha1」：下次未改动直接放行
    writeStamp(projectRoot, files)
  } else {
    // 失败不留指纹：把不一致状态彻底留给全量检查
    clearStamp(projectRoot)
  }
  return { ok, checked: targets.length, skipped: files.length - targets.length, errors }
}

export function formatRestartPreflightFailure(result) {
  const shown = result.errors.slice(0, 5).map(({ file, detail }) => `\n[${file}]\n${detail}`).join('\n')
  const more = result.errors.length > 5 ? `\n... 另有 ${result.errors.length - 5} 个文件失败` : ''
  const skipped = result.skipped ? `（跳过 ${result.skipped} 个未修改文件）` : ''
  return `重启已拦截：预检失败（语法、运行期未声明变量或 ESM import/export 链接；检查 ${result.checked} 个 .mjs${skipped}，失败 ${result.errors.length} 个）${shown}${more}`
}
