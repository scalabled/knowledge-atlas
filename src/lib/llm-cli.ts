import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rootDir } from './env'

/** Local agent CLIs that can answer a one-shot prompt. */
export type CliProvider = 'claude' | 'codex' | 'grok'

/** PATH plus the Grok Build install dir, so `grok` resolves when installed via its script. */
export function cliEnv(): NodeJS.ProcessEnv {
  const grokBin = path.join(os.homedir(), '.grok', 'bin')
  const pathParts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (!pathParts.includes(grokBin)) pathParts.unshift(grokBin)
  return { ...process.env, PATH: pathParts.join(path.delimiter) }
}

export function cliAvailable(command: string): boolean {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  const dirs = (cliEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  return dirs.some((dir) => extensions.some((ext) => {
    try {
      fs.accessSync(path.join(dir, `${command}${ext}`), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }))
}

export function runCli(command: string, args: string[], input: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited ${code}`)) })
    child.stdin.end(input)
  })
}

/** Grok Build reads long prompts from a file so library context stays off argv. */
export async function withGrokPromptFile(body: string, args: string[], timeoutMs: number): Promise<string> {
  const tmp = path.join(os.tmpdir(), `xbg-ask-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  await fs.promises.writeFile(tmp, body, 'utf8')
  try {
    const answer = await runCli('grok', ['--prompt-file', tmp, ...args, '--cwd', rootDir], '', timeoutMs)
    if (!answer.trim()) throw new Error('Grok Build CLI returned an empty answer')
    return answer
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/max turns? reached/i.test(message)) {
      throw new Error('Grok Build CLI hit its turn limit before finishing. Try a shorter question, or switch provider.')
    }
    throw error
  } finally {
    await fs.promises.unlink(tmp).catch(() => {})
  }
}

/** One tool-free answer from a local agent CLI. The prompt travels over stdin (or a temp file for grok), never argv. */
export function runCliPrompt(provider: CliProvider, prompt: string, timeoutMs = 180_000): Promise<string> {
  if (provider === 'grok') {
    return withGrokPromptFile(prompt, [
      '--output-format', 'plain', '--no-plan', '--disable-web-search', '--max-turns', '12', '--tools', '',
    ], timeoutMs)
  }
  if (provider === 'codex') {
    return runCli('codex', [
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-C', rootDir, '-',
    ], prompt, timeoutMs)
  }
  return runCli('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'text'], prompt, timeoutMs)
}
