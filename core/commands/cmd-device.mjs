// /device —— 设备 shell 通道管理
//
// 手机操作（phone use / 截屏 / 读 UI 树）需要 shell 身份，有两条路可走：
//   shizuku  —— 主通道，权限最完整
//   adb      —— 备用通道，本机回环，不依赖第三方 App
//
// 本命令只做三件事：看状态、切通道、配 adb 地址。
// 不要在这里做端口探测/自动重连 —— 那些属于本机环境，不属于命令层。
//
// 【ctx 需要】device（core/device.mjs 的导出集合）

export function makeDeviceCommand(ctx) {
  const { device } = ctx
  if (!device) return {}

  return {
    device: async (args) => {
      // 兼容两种入参形态：数组（多数命令模块的约定）和字符串（历史写法）。
      //
      // 【为什么必须兼容】CLI 的 handleCommand 统一传**数组**，而 Web 的
      // runWebCommand 早先传数组、后来我改过一次传字符串又改回来了。
      // 这个命令只做 `String(args).split()` 的话，数组进来会变成
      // "vd,status"（toString 带逗号）→ 报「未知子命令 vd,status」。
      // 与其依赖调用方统一，不如自己吃掉两种形态 —— 这比改全局约定安全得多。
      const parts = Array.isArray(args)
        ? args.map(String).filter(Boolean)
        : String(args || '').trim().split(/\s+/).filter(Boolean)
      const [head, ...rest] = parts

      // ── 无参 / status：看状态 ──
      if (!head || head === 'status') {
        const text = await device.describeDevice()
        return `${text}\n\n` + [
          '用法：',
          '  /device              看当前状态',
          '  /device shell auto    Shizuku 优先，失败落 adb（默认）',
          '  /device shell shizuku 只用 Shizuku',
          '  /device shell adb     只用 adb',
          '  /device adb <端口>    设置本机 adb 端口（如 5555）',
          '  /device adb off       清掉 adb 配置',
          '  /device rish <路径>   指定 rish 可执行文件位置',
          '  /device test          跑一次实测（命令 + 截屏）',
          '  /device vd start|stop|status   虚拟副屏进程（adb 通道）',
          '',
          '首次配 adb：bash ~/.claude-code-mobile/adb-setup.sh',
        ].join('\n')
      }

      // ── shell <auto|shizuku|adb>：切通道 ──
      if (head === 'shell') {
        const mode = rest[0]
        if (!['auto', 'shizuku', 'adb'].includes(mode)) {
          return `通道只能是 auto / shizuku / adb，收到的是「${mode || '(空)'}」`
        }
        if (mode === 'adb' && !device.adbTarget()) {
          return [
            '还没配 adb 端口，不能切成 adb-only。',
            '先跑：bash ~/.claude-code-mobile/adb-setup.sh',
            '或手动：/device adb 5555',
          ].join('\n')
        }
        device.saveDeviceConfig({ shell: mode })
        return `通道已切到 ${mode}\n\n` + await device.describeDevice()
      }

      // ── adb <port|off>：配 adb ──
      if (head === 'adb') {
        const v = rest[0]
        if (!v) {
          const t = device.adbTarget()
          return t ? `当前 adb：${t}` : '当前未配 adb 端口。用法：/device adb 5555'
        }
        if (v === 'off' || v === 'clear') {
          device.saveDeviceConfig({ adb: null })
          return 'adb 配置已清除。'
        }
        const port = Number(v)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return `端口不合法：「${v}」（应是 1-65535 的整数）`
        }
        device.saveDeviceConfig({ adb: { host: '127.0.0.1', port } })
        return `adb 已设为 127.0.0.1:${port}\n\n` + await device.describeDevice()
      }

      // ── mode 主屏|副屏|选择：手机操作模式偏好 ──
      //
      // 【语义】设了主屏/副屏就固定用它、以后不再弹选择；
      // 选「选择」则每次用手机工具都问。
      // 和另一版设计的区别：那版是「每次会话重选、不落盘」。
      if (head === 'mode') {
        const { getPhoneModePreference, setPhoneModePreference, getPhoneMode } = await import('../tools/tools-phone.mjs')
        const arg = rest[0]
        const MAP = {
          '主屏': 'foreground', '前台': 'foreground', 'foreground': 'foreground', 'fg': 'foreground',
          '副屏': 'background', '后台': 'background', 'background': 'background', 'bg': 'background',
          '选择': 'ask', '每次': 'ask', 'ask': 'ask',
        }
        if (!arg) {
          const pref = getPhoneModePreference()
          const now = getPhoneMode()
          return [
            `手机操作模式：${pref === 'foreground' ? '主屏（固定）'
              : pref === 'background' ? '副屏（固定）'
              : pref === 'ask' ? '每次都问'
              : '（还没设过，下次用手机工具时会问）'}`,
            now ? `  本次会话生效：${now}` : '',
            '',
            '  /device mode 主屏    固定用主屏，不再弹选择',
            '  /device mode 副屏    固定用副屏，不再弹选择',
            '  /device mode 选择    每次用手机工具都问你',
            '  /device mode off     清掉偏好，下次重新问一次',
            '',
            '（主屏 = 你能看见 AI 点哪；副屏 = 静默操作，不占你的屏）',
          ].filter(Boolean).join('\n')
        }
        if (arg === 'off' || arg === 'clear' || arg === '清掉') {
          setPhoneModePreference(null)
          return '已清掉手机操作模式偏好。下次用手机工具时会重新问你一次。'
        }
        const v = MAP[arg]
        if (!v) return `模式只能是 主屏 / 副屏 / 选择，收到「${arg}」`
        setPhoneModePreference(v)
        return v === 'ask'
          ? '已设为「每次都问」。之后每次用手机工具都会弹选择。'
          : `已设为「${v === 'foreground' ? '主屏' : '副屏'}」。以后不再弹选择（想改回每次问：/device mode 选择）。`
      }

      // ── rish <path>：指定 rish 位置 ──
      if (head === 'rish') {
        const p = rest[0]
        if (!p) {
          const cfg = device.loadDeviceConfig()
          return `当前 rish：${cfg.rish}`
        }
        device.saveDeviceConfig({ rish: p })
        return `rish 已设为 ${p}\n\n` + await device.describeDevice()
      }


      // ── vd：虚拟副屏进程管理 ──
      if (head === 'vd') {
        const { vdStart, vdStop, vdStatus } = await import('../phone/device.mjs')
        const sub = rest[0]
        if (sub === 'start') {
          const r = await vdStart({ timeout: 45000 })
          return r.ok
            ? `虚拟副屏已启动（display ${r.displayId}，端口 ${r.port}）${r.already ? '（已在运行）' : ''}`
            : `启动失败：${r.error}`
        }
        if (sub === 'stop') {
          const r = await vdStop()
          // vdStop 失败时返回 { ok:false, out }（没有 error 字段）——
          // 原来取 r.error 会打出 "停止失败：undefined"，用户完全看不懂。
          return r.ok
            ? '虚拟副屏已停止'
            : `停止失败：${r.error || r.out || 'adb 未就绪（需要先配置 /device adb <端口>）'}`
        }
        const st = await vdStatus()
        if (!st.running) return '虚拟副屏未运行。用 /device vd start 启动。'
        return [
          `虚拟副屏运行中`,
          `  display_id: ${st.display_id}`,
          `  尺寸: ${st.width}x${st.height} @${st.dpi}dpi`,
          `  帧缓存: ${st.frame_bytes} 字节，${st.frame_age_ms >= 0 ? Math.round(st.frame_age_ms / 1000) + ' 秒前' : '尚无画面'}`,
          `  模式: ${st.mode || '?'} → 目标屏 ${st.target_display_id ?? '?'}`,
        ].join('\n')
      }

      // ── test：实测 ──
      if (head === 'test') {
        const lines = []
        const r = await device.runShell('echo __ok__; id -u; getprop ro.product.model', 20000)
        lines.push(`命令测试：${r.ok && /__ok__/.test(r.out) ? '✅ 通过' : '❌ 失败'}`)
        lines.push(`  通道：${r.channel}${r.fellBack ? '（auto 降级）' : ''}`)
        if (r.ok) {
          const [uid, model] = r.out.split('\n').slice(1).map(s => s.trim())
          lines.push(`  uid=${uid || '?'}  机型=${model || '?'}`)
        } else {
          lines.push(`  原因：${r.err || r.out}`)
        }
        if (r.fellBack && r.shizukuErr) lines.push(`  （Shizuku 不可用：${r.shizukuErr}）`)

        const tmp = device.tmpShotPath ? device.tmpShotPath() : null
        if (tmp) {
          const s = await device.captureScreen(tmp, 25000)
          lines.push(`截屏测试：${s.ok ? `✅ 通过（${s.channel}/${s.via}）` : `❌ 失败：${s.err}`}`)
        }
        return lines.join('\n')
      }

      return `未知子命令「${head}」。敲 /device 看用法。`
    },
  }
}
