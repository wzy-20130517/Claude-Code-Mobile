// Claude Code Mobile - 导出对话
import { writeFileSync } from 'node:fs'
export class Exporter {
  static toMarkdown(messages) {
    const lines = ['# 对话记录\n']
    for (const msg of messages) {
      const role = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 AI' : '🔧 工具'
      lines.push(`## ${role}\n`)
      if (typeof msg.content === 'string') lines.push(msg.content)
      else if (Array.isArray(msg.content)) for (const b of msg.content) {
        if (b.type === 'text') lines.push(b.text)
        else if (b.type === 'tool_use') lines.push(`**调用工具**: \`${b.name}\`\n\`\`\`json\n${JSON.stringify(b.input,null,2)}\n\`\`\``)
        else if (b.type === 'tool_result') { const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content); lines.push(`**结果**:\n\`\`\`\n${c.slice(0,2000)}\n\`\`\``) }
      }
      lines.push('')
    }
    return lines.join('\n')
  }
  static save(messages, filePath) {
    let format = 'md'; if (filePath.endsWith('.html')) format='html'; else if (filePath.endsWith('.json')) format='json'
    let content; if (format==='html') content = Exporter.toHtml(messages); else if (format==='json') content = JSON.stringify(messages,null,2); else content = Exporter.toMarkdown(messages)
    writeFileSync(filePath, content, 'utf-8'); return filePath
  }
  static toHtml(messages, title='Claude Code 对话') {
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const lines = [`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:0 20px}.msg{margin:16px 0;padding:12px 16px;border-radius:8px}.user{background:#e3f2fd}.assistant{background:#f3e5f5}.tool{background:#fff3e0;font-family:monospace;font-size:13px}pre{background:#263238;color:#aed581;padding:8px;border-radius:4px;overflow-x:auto}</style></head><body><h1>${esc(title)}</h1>`]
    for (const msg of messages) {
      const cls = msg.role==='user'?'user':msg.role==='assistant'?'assistant':'tool'
      const role = msg.role==='user'?'👤 用户':msg.role==='assistant'?'🤖 AI':'🔧 工具'
      lines.push(`<div class="msg ${cls}"><strong>${role}</strong><br>`)
      if (typeof msg.content === 'string') lines.push(`<pre>${esc(msg.content)}</pre>`)
      else if (Array.isArray(msg.content)) for (const b of msg.content) {
        if (b.type === 'text') lines.push(`<pre>${esc(b.text)}</pre>`)
        else if (b.type === 'tool_use') lines.push(`<p><b>${esc(b.name)}</b></p>`)
        else if (b.type === 'tool_result') lines.push(`<pre>${esc(typeof b.content==='string'?b.content:JSON.stringify(b.content))}</pre>`)
      }
      lines.push('</div>')
    }
    lines.push('</body></html>'); return lines.join('\n')
  }
}
