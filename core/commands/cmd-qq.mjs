// QQ 桥命令 /qq（handleCommand 拆分第九批）
//
// 管的是「QQ 作为输入通道」的配置：监听开关、主人号、端点、队列、打断策略。
// QQ 桥本身在 core/qq-bridge.mjs，这里只是命令层。
//
// 【为什么 pendingInputs 不进 ctx】原实现里有两处
// `taskState.setQueueLength(pendingInputs.length ...)` —— 那是 index.mjs 的
// 私有状态（终端输入队列）。模块不该知道它存在，所以抽成 refreshQueueLength()
// 回调，由 index.mjs 决定怎么算队列长度（它要合并终端队列 + QQ 队列）。

/**
 * @param {object} ctx
 *   C, config
 *   qqBridge            QQ 桥实例（活对象）
 *   saveQqConfig        持久化到 qq-config.json
 *   runWizard           向导
 *   isNonInteractive    () => 是否非交互环境（QQ/Agent 调用）
 *   rl / fsSession      () => 交互层
 *   refreshQueueLength  () => void，更新看板上的队列长度显示
 */
export function makeQqCommand(ctx) {
  return {
    async qq(args) {
        // ── 桥缺失时的只读替身 ──
        //
        // 【为什么需要】Web/CCM 侧的桥是异步创建的，/qq 无参或 status 时
        // 它可能还是 null。而这些子命令只是**读配置**（显示端口、主人号、
        // 各端开关），完全不需要桥实例。
        //
        // 原来代码里到处是裸用的 ctx.qqBridge.owner / .port / .getEndpoints()，
        // 桥一为 null 就崩（实测：TypeError: Cannot read properties of null
        // (reading 'owner')，位置是帮助文案里的 ${ctx.qqBridge.owner}）。
        //
        // 与其在 20 处加 ?.，不如在入口统一替换成替身：
        // 读操作返回配置里的值（本来就该这样 —— 配置才是真相来源），
        // 写操作/需要真桥的操作由调用方在分支里拦（见 NEEDS_BRIDGE）。
        // 注意：这里用**原始 ctx**（_ctx 还没定义，用了会 TDZ 报错）
        const cfgNow = typeof ctx.loadQqConfig === 'function' ? ctx.loadQqConfig() : {}
        const bridgeStub = {
          running: false,
          port: cfgNow.port ?? 3000,
          owner: cfgNow.owner ?? '',
          napcatApi: cfgNow.napcatApi ?? 'http://127.0.0.1:5700',
          allowInterrupt: !!cfgNow.allowInterrupt,
          openMode: !!cfgNow.openMode,
          endpointLabel: cfgNow.endpoint ?? null,
          pendingCount: () => 0,
          groupCacheCount: () => 0,
          peekQueue: () => [],
          getEndpoints: () => ({
            running: false,
            port: cfgNow.port ?? 3000,
            api: cfgNow.napcatApi ?? 'http://127.0.0.1:5700',
            owner: cfgNow.owner ?? '',
            allowInterrupt: !!cfgNow.allowInterrupt,
            openMode: !!cfgNow.openMode,
          }),
          // 这些是「真要桥才能做」的 —— 返回明确的失败而不是静默
          start: () => { throw new Error('QQ 桥实例不存在') },
          stop: () => {},
          send: async () => { throw new Error('QQ 桥实例不存在') },
          setOwner: () => ({ ok: false, msg: 'QQ 桥实例不存在' }),
          setPort: () => ({ ok: false, msg: 'QQ 桥实例不存在' }),
          setApi: () => ({ ok: false, msg: 'QQ 桥实例不存在' }),
          setAllowInterrupt: () => ({ ok: false, msg: 'QQ 桥实例不存在' }),
          setOpenMode: () => ({ ok: false, msg: 'QQ 桥实例不存在' }),
          clearQueue: () => 0,
          deleteQueued: () => false,
        }
        // 用替身组装出 _ctx —— 下面所有裸用点自动走它，不用改 20 处。
        // 这是刻意的：改动面越小，回归风险越低。
        //
        // ⚠ 顺序：qqBridge 必须先取（从**原始 ctx** 取，不是从 _ctx），
        // 否则 _ctx 还没初始化就被读 → ReferenceError: Cannot access '_ctx'
        // before initialization（实测踩过）。
        const qqBridge = ctx.qqBridge || bridgeStub
        const _ctx = { ...ctx, qqBridge }
        // /qq — 极简 QQ 桥：只有主人私聊会进会话。
        // 2026-08-21 按用户要求砍掉白名单/群消息/收件箱/屏蔽/禁言/群 slash 代理，
        // 只留「能在 QQ 上说话」这一件事 + owner 安全底线。
        const sub = String(args[0] || '').toLowerCase()
        switch (sub) {
          case 'on': {
            // ── 开启 ──
            //
            // 【2026-09-24 三次修订，每次都有实测依据】
            //   ① 原来直接 ctx.qqBridge.start() —— Web 侧首次调用时它是 null → 崩
            //   ② 改成先 startQqBridge 创建；但 `if (bridge.running) return` 提前返回，
            //      导致 saveQqConfig 被跳过 → 配置不落盘 → 重启又变回未启用
            //   ③ 现在：先确保 running，再无条件写配置；并且**用带冲突诊断的启动**
            //
            // 【为什么要冲突诊断】CLI / Web / CCM 三端可能抢同一个端口
            //（proot 与 Termux 共享网络命名空间）。原来的失败是静默的，
            // 用户只看到「QQ 消息没反应」，查不出原因。
            // 现在端口被自己人占着时，直接说清是谁占的、去哪个端关。
            let bridge = _ctx.qqBridge

            // 已有桥实例：走带诊断的启动
            if (bridge && typeof bridge.startChecked === 'function' && !bridge.running) {
              const r = await bridge.startChecked()
              if (!r.ok) {
                // 冲突时不写 enabled:true —— 写了会让下次启动又去抢，抢不到还是白搭
                return `⚠️ QQ 桥启动失败\n\n${r.reason}`
              }
              _ctx.saveQqConfig({ enabled: true })
              return `QQ 桥已启动：监听 ${bridge.port}，仅主人 ${bridge.owner} 私聊生效`
            }

            // 还没有桥实例：让宿主环境创建
            if (!bridge && typeof _ctx.startQqBridge === 'function') {
              const r = await _ctx.startQqBridge({})
              if (!r?.ok) {
                return `⚠️ QQ 桥启动失败\n\n${r?.reason || '未知原因'}`
              }
              bridge = r.bridge
            }
            if (!bridge) return 'QQ 桥不可用（当前环境不支持）。'

            if (bridge.running) {
              _ctx.saveQqConfig({ enabled: true })
              return `QQ 桥已在运行（端口 ${bridge.port}，配置已确认）`
            }
            bridge.start()
            _ctx.saveQqConfig({ enabled: true })
            return `QQ 桥已启动：监听 ${bridge.port}，仅主人 ${bridge.owner} 私聊生效`
          }
          case 'off': {
            // 同样可能为 null（用户没开过就 /qq off）
            if (_ctx.qqBridge) _ctx.qqBridge.stop()
            if (typeof _ctx.stopQqBridge === 'function') _ctx.stopQqBridge()
            _ctx.saveQqConfig({ enabled: false })
            return 'QQ 桥已停止'
          }
          case 'send': {
            // /qq send <内容>   给自己发一条（测试用）
            const content = args.slice(1).join(' ').trim()
            if (!content) return '用法: /qq send <内容>（发给主人自己，测试连通性）'
            const r = await _ctx.qqBridge.send(_ctx.qqBridge.owner, null, content)
            return r?.status === 'ok' || r?.retcode === 0
              ? '已发送'
              : `发送失败: ${r?.msg || JSON.stringify(r || {}).slice(0, 120)}`
          }
          case 'setup': {
            // 三项配置原来分散在 owner/port/api 三个子命令里，一次配完更省事
            const e = _ctx.qqBridge.getEndpoints()
            const a = await _ctx.runWizard({
              rl: _ctx.rl(), fsSession: _ctx.fsSession(), C: _ctx.C, title: 'QQ 桥配置',
              steps: [
                { key: 'owner', label: '主人 QQ 号', required: true, default: String(e.owner || ''),
                  hint: '10001', desc: '只有这个号的私聊会进会话',
                  validate: v => /^\d{5,12}$/.test(v) ? null : 'QQ 号应为 5-12 位数字' },
                { key: 'port', label: '监听端口', default: String(e.port || 3000), hint: '3000',
                  validate: v => (+v >= 1 && +v <= 65535) ? null : '端口范围 1-65535' },
                { key: 'api', label: 'NapCat API', default: String(e.api || 'http://127.0.0.1:5700'),
                  hint: 'http://127.0.0.1:5700',
                  validate: v => /^https?:\/\//.test(v) ? null : '需以 http:// 开头' },
              ],
            })
            if (!a) return '已取消'
            const out = []
            for (const [fn, val, key] of [['setOwner', a.owner, 'owner'], ['setPort', a.port, 'port'], ['setApi', a.api, 'napcatApi']]) {
              const r = _ctx.qqBridge[fn](val)
              if (!r.ok) { out.push(`${_ctx.C.dim}✗${_ctx.C.reset} ${r.msg}`); continue }
              _ctx.saveQqConfig({ [key]: r.owner ?? r.port ?? r.api })
              out.push(`${_ctx.C.green}✓${_ctx.C.reset} ${r.msg}`)
            }
            out.push(`${_ctx.C.dim}改了端口需 /qq off 再 /qq on 才重新监听${_ctx.C.reset}`)
            return out.join('\n')
          }
          case 'owner': {
            if (!args[1]) return `当前主人 QQ: ${_ctx.qqBridge.owner}\n用法: /qq owner <QQ号>`
            const r = _ctx.qqBridge.setOwner(args[1])
            if (!r.ok) return r.msg
            _ctx.saveQqConfig({ owner: r.owner })
            return r.msg + '\n(已保存到 qq-config.json)'
          }
          case 'interrupt': {
            const v = String(args[1] || '').toLowerCase()
            if (!v) {
              return `从 QQ 打断正在跑的任务，两种方式：\n\n`
                + `1. 直接发关键词（随时可用，不用开关）\n`
                + `   停 / 停止 / 停下 / 暂停 / 打断 / 中断 / 别跑了 / stop / abort / cancel\n`
                + `   → 立刻中止，并挂起队列等你的下一条指示\n`
                + `   → 发「继续」放行队列\n`
                + `   注意：整条消息就是这个词才触发，「这个要停止吗」不会误触发\n\n`
                + `2. 全局开关：任何新消息都打断\n`
                + `   当前状态: ${_ctx.qqBridge.allowInterrupt ? '开启' : '关闭'}\n`
                + `   /qq interrupt on|off\n`
                + `   开启后你随便说句话都会中止当前任务，适合「我说话就该优先」的场景`
            }
            if (v !== 'on' && v !== 'off') return '用法: /qq interrupt on|off'
            const r = _ctx.qqBridge.setAllowInterrupt(v === 'on')
            _ctx.saveQqConfig({ allowInterrupt: r.allowInterrupt })
            return r.msg + '\n(已保存到 qq-config.json)'
          }
          case 'open': {
            const v = String(args[1] || '').toLowerCase()
            if (!v) {
              return `放行模式（群内任何人 @ 都能唤醒 Agent）\n\n`
                + `当前: ${_ctx.qqBridge.openMode ? '开启' : '关闭'}\n\n`
                + `开启后：\n`
                + `  · 群里**任何人** @ 我都会唤醒会话（不再限主人）\n`
                + `  · 非主人的消息会标明来源（「放行模式｜非主人消息，来自 xxx」），\n`
                + `    我据此判断可信度、敏感操作会先跟你确认\n`
                + `  · 发现有恶意消息，我自己会 /qq open off 关上\n\n`
                + `⚠ 这等于把手机操作权限开放给群里所有人 —— 只在信任的群里开。\n`
                + `用法: /qq open on|off`
            }
            if (v !== 'on' && v !== 'off') return '用法: /qq open on|off'
            const r = _ctx.qqBridge.setOpenMode(v === 'on')
            _ctx.saveQqConfig({ openMode: r.openMode })
            return r.msg + '\n(已保存到 qq-config.json)'
          }
          case 'queue': {
            const items = _ctx.qqBridge.peekQueue()
            if (!items.length) return 'QQ 队列为空'
            const sub2 = String(args[1] || '').toLowerCase()
            if (sub2 === 'clear') {
              const n = _ctx.qqBridge.clearQueue()
              _ctx.refreshQueueLength()
              return `已清空 QQ 队列（${n} 条）`
            }
            if (/^\d+$/.test(sub2)) {
              const removed = _ctx.qqBridge.deleteQueued(Number(sub2) - 1)
              if (!removed) return `没有第 ${sub2} 条（当前 ${items.length} 条）`
              _ctx.refreshQueueLength()
              return `已删除第 ${sub2} 条：${String(removed.message || '').slice(0, 40)}`
            }
            return `QQ 队列（${items.length} 条）：\n`
              + items.map((it, i) => `  ${i + 1}. ${it.message.replace(/\s+/g, ' ').slice(0, 46)}${it.hasImages ? ' [图片]' : ''}`).join('\n')
              + `\n\n删除: /qq queue <序号> · 清空: /qq queue clear\n终端里也可用 Ctrl+P/N 翻看、Ctrl+G 删除、Ctrl+S 立即发送`
          }
          case 'port': {
            if (!args[1]) return `当前监听端口: ${_ctx.qqBridge.port}\n用法: /qq port <1-65535>`
            const r = _ctx.qqBridge.setPort(args[1])
            if (!r.ok) return r.msg
            _ctx.saveQqConfig({ port: r.port })
            return r.msg + '\n(已保存到 qq-config.json)'
          }
          case 'api': {
            if (!args[1]) return `当前 NapCat API: ${_ctx.qqBridge.napcatApi}\n用法: /qq api <http://host:port>`
            const r = _ctx.qqBridge.setApi(args[1])
            if (!r.ok) return r.msg
            _ctx.saveQqConfig({ napcatApi: r.api })
            return r.msg + '\n(已保存到 qq-config.json)'
          }
          case 'status': {
            const e = _ctx.qqBridge.getEndpoints()
            // 各端开关一览：
            // 【为什么要显示】开关是**按端分**的，而端口共用（同一时间只允许
            // 一个端监听）。用户换端前需要知道「另一个端是不是还开着」，
            // 否则会撞上「端口被占用」却不知道该去哪关。
            const epList = typeof _ctx.listQqEndpoints === 'function' ? _ctx.listQqEndpoints() : []
            const self = typeof _ctx.detectQqEndpoint === 'function' ? _ctx.detectQqEndpoint() : null
            const epLines = epList.length
              ? '\n- 各端开关: ' + epList.map(x =>
                  `${_ctx.labelQqEndpoint ? _ctx.labelQqEndpoint(x.name) : x.name}${x.name === self ? '(本端)' : ''}=${x.enabled ? '开' : '关'}`
                ).join(' · ')
              : ''
            const others = epList.filter(x => x.name !== self && x.enabled)
            const conflictHint = others.length
              ? `\n- ⚠️ ${others.map(x => _ctx.labelQqEndpoint ? _ctx.labelQqEndpoint(x.name) : x.name).join('、')}也开着 —— 端口 ${e.port} 只能有一个端监听，换端前请先在那里 /qq off`
              : ''
            return `QQ 桥状态:\n- 监听: ${e.running ? `运行中 (${e.port})` : `未启动 (配置端口 ${e.port})`}`
              + epLines + conflictHint
              + `\n- NapCat API: ${e.api}`
              + `\n- 主人 QQ: ${e.owner}（只有这个号私聊会进会话）`
              + `\n- 待处理: ${_ctx.qqBridge.pendingCount() || '无'}${_ctx.qqBridge.pendingCount() ? ' 条（/qq queue 查看）' : ''}`
              + `\n- 打断: 发「停」立刻中止 · 发「继续」放行队列`
              + `\n- 全局打断开关: ${e.allowInterrupt ? '开启（任何消息都打断）' : '关闭'}（/qq interrupt on|off）`
              + `\n- 群唤醒: ${e.openMode ? '放行模式（任何人 @ 都唤醒）⚠' : '仅主人 @ 唤醒'}（/qq open on|off）`
              + `\n- 群消息: 不自动进会话，可用 QQRecall 回溯（缓存 ${_ctx.qqBridge.groupCacheCount?.() ?? 0} 条）`
              + `\n- 发送失败不提示: QQ 发不出去不影响终端（排查用 /qq send <内容> 手动测）`
          }
          default:
            return `用法（QQ 桥：在 QQ 上直接跟我说话）:
/qq on                  启动监听
/qq off                 停止监听
/qq status              查看状态
/qq setup               向导：主人号 / 端口 / API 一次配完
/qq owner <QQ号>        设置主人号（默认 ${_ctx.qqBridge.owner}）
/qq open on|off         放行模式：群里任何人 @ 都能唤醒（默认关，只认主人）
/qq port <端口>         监听端口（默认 3000）
/qq api <URL>           NapCat API 地址（默认 http://127.0.0.1:5700）
/qq send <内容>         给自己发一条（测连通性）
/qq queue               查看/删除待处理消息
/qq interrupt on|off    新消息是否打断正在跑的任务

说明：
  · 主人私聊 → 进会话，回复发回私聊
  · 主人在群 @ 我 → 进会话，回复发回**那个群**
  · 其他群消息 → 不打扰，但我可以用 QQRecall 主动回溯（「看下刚才群里那张图」）
  · 回复里的 key/token 自动打码`
        }
    },
  }
}
