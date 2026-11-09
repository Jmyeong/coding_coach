const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runCodex } = require('../src/codex');
const executable = path.join(__dirname, 'fake-codex.cjs');
fs.chmodSync(executable, 0o755);
const request = { executable, effort: 'medium', timeoutMs: 3000 };

test('분할 JSONL과 마지막 줄의 개행 생략을 처리한다', async () => {
  let usage;
  assert.match(await runCodex({ ...request, prompt: 'question', onUsage: value => { usage = value; } }), /입력 차원/);
  assert.deepEqual(usage, { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 });
});
test('모델 실패와 빈 응답을 숨기지 않는다', async () => {
  await assert.rejects(runCodex({ ...request, prompt: 'fail' }), /Unsupported effort/);
  await assert.rejects(runCodex({ ...request, prompt: 'empty' }), /반환하지 않았습니다/);
});
test('제한 시간과 사용자 취소로 진행 중 프로세스를 종료한다', async () => {
  await assert.rejects(runCodex({ ...request, prompt: 'wait', timeoutMs: 80 }), /제한 시간/);
  const abort = new AbortController();
  const pending = runCodex({ ...request, prompt: 'wait', signal: abort.signal });
  setTimeout(() => abort.abort(), 80);
  await assert.rejects(pending, /취소/);
});
test('CLI 설치가 없으면 안내를 반환한다', async () => {
  await assert.rejects(runCodex({ ...request, executable: '/nonexistent/code-coach-codex', prompt: 'q' }), /찾지 못했습니다/);
});

test('전용 자동완성 지침은 짧은 지침 파일로 전달한다', async () => {
  assert.match(await runCodex({ ...request, prompt: 'question', rules: 'Return only a short code completion.' }), /입력 차원/);
});
