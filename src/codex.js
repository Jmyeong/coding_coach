const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { codexArgs } = require('./core');

function stopProcess(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { child.kill(); }
}

function cleanError(text) {
  return text.replace(/sk-[\w-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(-1000);
}

/** @param {{ executable: string, prompt: string, effort: string, model?: string, timeoutMs?: number, signal?: AbortSignal, rules?: string, outputSchema?: object, onUsage?: (usage: any) => void }} options */
async function runCodex({ executable, prompt, effort, model = '', timeoutMs = 180000, signal, rules, outputSchema, onUsage }) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'code-coach-'));
  try {
    if (signal?.aborted) throw new Error('요청이 취소되었습니다.');
    let instructionsPath = '';
    if (rules) {
      instructionsPath = path.join(cwd, 'completion-instructions.txt');
      await fs.writeFile(instructionsPath, rules);
    }
    const args = codexArgs(effort, model, rules, instructionsPath);
    if (outputSchema) {
      const schemaPath = path.join(cwd, 'response.schema.json');
      await fs.writeFile(schemaPath, JSON.stringify(outputSchema));
      args.splice(args.length - 1, 0, '--output-schema', schemaPath);
    }
    if (signal?.aborted) throw new Error('요청이 취소되었습니다.');
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let buffer = '', stderr = '', final = '', failure = '', bytes = 0, settled = false;
      const abort = () => { stopProcess(child); finish(new Error('요청이 취소되었습니다.')); };
      const timer = setTimeout(() => {
        stopProcess(child); finish(new Error('응답 제한 시간을 넘겼습니다. 추론 수준을 낮추거나 다시 질문해 주세요.'));
      }, timeoutMs);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      }
      function eventLine(line) {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text || final;
        if (event.type === 'turn.completed' && event.usage) onUsage?.(event.usage);
        if (event.type === 'turn.failed') failure = event.error?.message || 'Codex 요청이 실패했습니다.';
        if (event.type === 'error') failure = event.message || failure;
      }
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) { stopProcess(child); finish(new Error('Codex 응답 크기를 초과했습니다.')); return; }
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          eventLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', error => finish(new Error(/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
        ? 'Codex CLI를 찾지 못했습니다. codeCoach.codexPath를 설정해 주세요.' : cleanError(error.message))));
      child.stdin.on('error', () => {});
      child.on('close', code => {
        if (buffer) eventLine(buffer);
        if (code !== 0 || failure) finish(new Error(cleanError(failure || stderr || `Codex 종료 코드: ${code}`)));
        else if (!final.trim()) finish(new Error('Codex가 코칭 응답을 반환하지 않았습니다. 로그인과 모델 설정을 확인해 주세요.'));
        else finish(null, final.trim());
      });
      child.stdin.end(prompt);
    });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

module.exports = { runCodex };
