// Claude Code Mobile - 非交互模式（单条执行）
export async function runNonInteractive(agent, prompt, options = {}) {
  const timeout = options.timeout || 60000
  const result = await Promise.race([
    agent.run(prompt),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
  ])
  return result
}
