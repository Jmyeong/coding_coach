const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vscode = {
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  InlineCompletionItem: class { constructor(insertText, range, command) { this.insertText = insertText; this.range = range; this.command = command; } },
  window: { activeTextEditor: null, showWarningMessage() {} }
};
const original = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { createInlineProvider } = require('../src/inline');
Module._load = original;

function harness() {
  let source = '# 양수만 골라 평균 구하기\n    ', isEnabled = true;
  const requests = [], states = [], payloads = [], notices = [], metrics = [], listeners = new Set();
  const doc = { uri: { scheme: 'file', toString: () => 'file:///project/train.py' }, version: 1, languageId: 'python', getText: () => source };
  const position = { line: 1, character: 4 };
  const settings = { debounceMs: 5, maxSuggestionLines: 12, reasoningEffort: 'high', model: 'my-model' };
  const editor = { document: doc, selection: { isEmpty: true, active: position }, options: { tabSize: 4, insertSpaces: true } };
  vscode.window.activeTextEditor = editor;
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
  const dependencies = {
    config: () => ({ get: (key, fallback) => settings[key] ?? fallback }), enabled: () => isEnabled,
    collectContext: async () => ({ currentFile: 'train.py', code: source }), findCodex: async () => '/codex',
    runCodex: async options => { requests.push(options); return JSON.stringify({ code: '    positives = [x for x in values if x > 0]' }); },
    onState: (busy, error) => states.push({ busy, error }), onPayload: p => payloads.push(p),
    onNotice: notice => notices.push(notice), onMetrics: value => metrics.push(value)
  };
  return { doc, position, settings, token, requests, states, payloads, notices, metrics, dependencies, editor,
    edit(next) { source = next; doc.version++; }, disable() { isEnabled = false; },
    cancel() { token.isCancellationRequested = true; for (const fn of listeners) fn(); } };
}
const automatic = { triggerKind: 1 }, explicit = { triggerKind: 0 };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('네이티브 고스트 텍스트를 반환하고 수락 전에는 원문을 수정하지 않는다', async () => {
  const h = harness(), provider = createInlineProvider(h.dependencies);
  const originalText = h.doc.getText();
  const items = await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(items.length, 1); assert.match(items[0].insertText, /positives/);
  assert.equal(items[0].range.start.character, 0); assert.equal(items[0].range.end.character, 4);
  assert.equal(h.doc.getText(), originalText);
  assert.equal(h.requests[0].effort, 'high'); assert.equal(h.requests[0].model, 'my-model');
  assert.equal(h.requests[0].outputSchema.properties.code.type, 'string');
  assert.equal(JSON.parse(h.payloads[0]).completion.instruction, '양수만 골라 평균 구하기');
  await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(h.requests.length, 1, '동일 문서·위치의 중복 호출은 캐시 사용');
  provider.dispose();
});

test('타이핑·기능 끄기·에디터 취소는 생성 요청을 중지한다', async () => {
  const h = harness(), provider = createInlineProvider(h.dependencies);
  const pending = provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  h.cancel();
  assert.deepEqual(await pending, []); assert.equal(h.requests.length, 0);
  provider.dispose();
  const h2 = harness();
  h2.dependencies.runCodex = options => { h2.requests.push(options); return new Promise(resolve => options.signal.addEventListener('abort', () => resolve('{"code":"obsolete"}'))); };
  const p2 = createInlineProvider(h2.dependencies);
  const waiting = p2.provideInlineCompletionItems(h2.doc, h2.position, explicit, h2.token);
  await tick(); h2.edit('# new instruction\nmanual_code'); p2.invalidate(h2.doc.uri.toString());
  assert.deepEqual(await waiting, []); assert.ok(h2.requests[0].signal.aborted);
  h2.disable(); p2.reset();
  assert.deepEqual(await p2.provideInlineCompletionItems(h2.doc, h2.position, explicit, h2.token), []);
  p2.dispose();
});

test('코드나 커서가 바뀌면 늦은 응답을 버린다', async () => {
  for (const scenario of ['edit', 'move', 'disable']) {
    const h = harness(); let finish;
    h.dependencies.runCodex = options => { h.requests.push(options); return new Promise(resolve => { finish = resolve; }); };
    const provider = createInlineProvider(h.dependencies);
    const pending = provider.provideInlineCompletionItems(h.doc, h.position, explicit, h.token);
    await tick();
    if (scenario === 'edit') h.edit('# changed\n    ');
    if (scenario === 'move') h.editor.selection.active = { line: 0, character: 0 };
    if (scenario === 'disable') h.disable();
    finish(JSON.stringify({ code: '    obsolete = True' }));
    assert.deepEqual(await pending, [], scenario); provider.dispose();
  }
});

test('형식 오류는 자동 호출에서 알림을 띄우지 않고 수동 호출에서 알려준다', async () => {
  const h = harness(), warnings = [];
  vscode.window.showWarningMessage = value => warnings.push(value);
  h.dependencies.runCodex = async () => '잘못된 형식';
  const provider = createInlineProvider(h.dependencies);
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token), []);
  assert.equal(warnings.length, 0); assert.ok(h.states.at(-1).error);
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, h.position, explicit, h.token), []);
  assert.equal(warnings.length, 1);
  provider.dispose();
});

test('주석 입력 중이나 직접 작성한 코드에는 자동 제안을 요청하지 않는다', async () => {
  const h = harness(), provider = createInlineProvider(h.dependencies);
  h.edit('# 의도 작성 중');
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, { line: 0, character: h.doc.getText().length }, automatic, h.token), []);
  h.edit('# 의도\n    my_own_code');
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, { line: 1, character: 15 }, automatic, h.token), []);
  assert.equal(h.requests.length, 0); provider.dispose();
});

test('모델 변경 후 이전 제안 캐시를 버리고 새 모델로 생성한다', async () => {
  const h = harness(), provider = createInlineProvider(h.dependencies);
  await provider.provideInlineCompletionItems(h.doc, h.position, explicit, h.token);
  h.settings.model = 'new-selected-model'; h.settings.reasoningEffort = 'low'; provider.reset();
  await provider.provideInlineCompletionItems(h.doc, h.position, explicit, h.token);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].model, 'new-selected-model'); assert.equal(h.requests[1].effort, 'low');
  provider.dispose();
});

test('Enter 후 대기 시간부터 생성 상태를 표시하고 취소하면 해제한다', async () => {
  const h = harness(); h.settings.debounceMs = 100;
  const provider = createInlineProvider(h.dependencies);
  const pending = provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(h.states.at(-1).busy, true, 'API 호출 전 입력 대기 시간에도 생성 상태 표시');
  assert.equal(h.requests.length, 0);
  h.cancel(); await pending;
  assert.equal(h.states.at(-1).busy, false);
  provider.dispose();
});

test('빈 제안은 오류로 처리하지 않고 안내를 표시한다', async () => {
  const h = harness(); h.dependencies.runCodex = async () => JSON.stringify({ code: '' });
  const provider = createInlineProvider(h.dependencies);
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token), []);
  assert.equal(h.states.at(-1).error, ''); assert.match(h.notices.at(-1), /제안이 없습니다/);
  provider.dispose();
});

test('긴 응답을 온전히 보존하고 동일 주석의 추가 빈 줄은 호출 없이 재사용한다', async () => {
  const h = harness();
  h.dependencies.runCodex = async options => {
    h.requests.push(options);
    return JSON.stringify({ code: Array.from({ length: 20 }, (_, i) => `value${i} = ${i}`).join('\n') });
  };
  const provider = createInlineProvider(h.dependencies);
  const result = await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(result.length, 1); assert.equal(result[0].insertText.split('\n').length, 20);
  h.edit('# 양수만 골라 평균 구하기\n\n    '); h.position.line = 2;
  provider.invalidate(h.doc.uri.toString());
  const reused = await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(reused[0].range.start.line, 2); assert.equal(h.requests.length, 1);
  assert.equal(h.metrics.at(-1).fromCache, true);
  provider.invalidate('file:///project/dataset.py');
  await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(h.requests.length, 2, '관련 파일을 수정하면 새 컨텍스트로 생성');
  const payload = JSON.parse(h.payloads[0]);
  assert.equal(payload.completion.codeBeforeCursor, undefined);
  assert.equal(payload.completion.codeAfterCursor, undefined);
  provider.dispose();
});

test('Tab 수락 뒤 Enter에서 이어 제안하고 직접 입력하면 자동 이어 제안을 멈춘다', async () => {
  const h = harness(), provider = createInlineProvider(h.dependencies);
  const first = await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(first[0].command.command, 'codeCoach.accepted');
  const instruction = first[0].command.arguments[1];
  h.edit('# 양수만 골라 평균 구하기\n    positives = [x for x in values if x > 0]');
  h.position.character = h.doc.getText().split('\n')[1].length;
  provider.invalidate(h.doc.uri.toString()); provider.didAccept(h.doc.uri.toString(), instruction);
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token), []);
  assert.equal(h.requests.length, 1, '수락만으로 추가 모델 호출을 시작하지 않음');
  h.edit(h.doc.getText() + '\n    '); h.position.line = 2; h.position.character = 4;
  provider.invalidate(h.doc.uri.toString());
  const next = await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token);
  assert.equal(next.length, 1); assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].prompt).completion.instruction, instruction);
  h.edit(h.doc.getText() + 'my_own_code'); provider.invalidate(h.doc.uri.toString());
  h.edit(h.doc.getText() + '\n    '); h.position.line = 3;
  provider.invalidate(h.doc.uri.toString());
  assert.deepEqual(await provider.provideInlineCompletionItems(h.doc, h.position, automatic, h.token), []);
  assert.equal(h.requests.length, 2, '직접 작성한 뒤에는 자동 재요청하지 않음');
  provider.dispose();
});
