const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const commands = new Map(), executed = [], listeners = {}, status = [];
const settings = { enabled: true, reasoningEffort: 'medium' };
let registered, resets = 0, invalidated;
let accepted;
let reportState, reportNotice, reportMetrics, warningMessage, warningAction;
let picker = choices => choices.find(c => c.description === 'high'), input, lastChoices, lastInputOptions;
let workspaceOverride = false;
const saves = [];
const catalog = { models: [{ slug: 'fast-test-model', display_name: 'Fast Test Model', supported_reasoning_levels: [{ effort: 'low' }] }] };
const disposable = () => ({ dispose() {} });
const event = name => fn => { listeners[name] = fn; return disposable(); };
const provider = { ...disposable(), reset() { resets++; }, invalidate(uri) { invalidated = uri; }, didAccept(uri, instruction) { accepted = { uri, instruction }; } };
const vscode = {
  workspace: { isTrusted: true,
    getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback,
      inspect: key => workspaceOverride ? { workspaceValue: settings[key] } : {},
      update: async (key, value, target) => {
      saves.push({ key, value, target });
      settings[key] = value; listeners.config?.({ affectsConfiguration: k => k === 'codeCoach' || k === `codeCoach.${key}` });
    } }),
    onDidChangeTextDocument: event('change'), onDidCloseTextDocument: event('close'), onDidChangeConfiguration: event('config') },
  window: { activeTextEditor: { document: { uri: { scheme: 'file' } } },
    createStatusBarItem: () => { const item = { ...disposable(), show() {}, hide() {} }; status.push(item); return item; },
    showInformationMessage() {}, showQuickPick: async choices => { lastChoices = choices; return picker(choices); },
    showInputBox: async options => { lastInputOptions = options; return input; } },
  languages: { registerInlineCompletionItemProvider: (selector, value) => { registered = { selector, value }; return disposable(); } },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); }, executeCommand: async id => { executed.push(id); } },
  StatusBarAlignment: { Right: 1 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
};
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return vscode;
  if (name === 'node:fs/promises') return { ...fs, readFile: async (file, ...options) =>
    String(file).endsWith('models_cache.json') ? JSON.stringify(catalog) : fs.readFile(file, ...options) };
  if (name === './inline') return { createInlineProvider: options => {
    reportState = options.onState; reportNotice = options.onNotice; reportMetrics = options.onMetrics; return provider;
  } };
  return original.call(this, name, ...args);
};
const { activate } = require('../src/extension');
Module._load = original;

test('파일용 인라인 제공자를 등록하고 수동 요청·추론 설정·끄기를 연결한다', async () => {
  const context = { subscriptions: [] }; activate(context);
  assert.equal(registered.selector.scheme, 'file'); assert.equal(registered.value, provider);
  commands.get('codeCoach.accepted')('file:///model.py', '모델 작성');
  assert.deepEqual(accepted, { uri: 'file:///model.py', instruction: '모델 작성' });
  assert.match(status[0].text, /코드 예시 ON/);
  reportState(true, '');
  assert.match(status[0].text, /코드 생성 중/);
  reportState(false, '');
  assert.match(status[0].text, /코드 예시 ON/);
  reportNotice('현재 주석에 대한 제안이 없습니다.');
  assert.match(status[0].text, /코드 제안 없음/); assert.ok(!status[0].text.includes('warning'));
  reportNotice('');
  reportMetrics({ fromCache: false, elapsedMs: 1200, usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 100 } });
  assert.match(status[0].tooltip, /입력 200/); assert.match(status[0].tooltip, /1.2초/);
  reportMetrics({ fromCache: true }); assert.match(status[0].tooltip, /추가 모델 호출 없음/);
  vscode.window.showWarningMessage = async message => { warningMessage = message; return warningAction; };
  reportState(false, '현재 파일 탐색 오류');
  assert.equal(status[0].command, 'codeCoach.error');
  assert.match(status[0].tooltip, /현재 파일 탐색 오류/);
  warningAction = '다시 제안'; await commands.get('codeCoach.error')();
  assert.match(warningMessage, /현재 파일 탐색 오류/);
  assert.ok(executed.includes('codeCoach.ask'));
  reportState(false, '');
  assert.equal(status[0].command, 'codeCoach.toggle');
  await commands.get('codeCoach.ask')();
  assert.ok(executed.includes('editor.action.inlineSuggest.trigger'));
  await commands.get('codeCoach.reasoning')(); assert.equal(settings.reasoningEffort, 'high');
  listeners.change({ contentChanges: [{}], document: { uri: { toString: () => 'file:///model.py' } } });
  assert.equal(invalidated, 'file:///model.py');
  await commands.get('codeCoach.toggle')();
  assert.equal(settings.enabled, false); assert.match(status[0].text, /코드 예시 OFF/);
  assert.ok(executed.includes('editor.action.inlineSuggest.hide')); assert.ok(resets >= 2);
  // The model control stays available while generation is off.
  const modelStatus = status.find(item => item.command === 'codeCoach.model');
  assert.ok(modelStatus); assert.match(modelStatus.text, /Codex 기본/);
  settings.reasoningEffort = 'high';
  picker = choices => choices.find(c => c.id === 'fast-test-model');
  const previousResets = resets;
  await commands.get('codeCoach.model')();
  assert.equal(settings.model, 'fast-test-model');
  assert.equal(settings.reasoningEffort, 'low', '새 모델이 지원하는 추론 수준으로 조정');
  assert.match(modelStatus.text, /fast-test-model/); assert.ok(resets > previousResets);
  picker = () => undefined;
  await commands.get('codeCoach.model')();
  assert.ok(lastChoices.some(c => c.id === 'fast-test-model' && c.description.includes('현재 선택')));
  assert.equal(settings.model, 'fast-test-model', '선택 취소 시 기존 모델 유지');
  picker = choices => choices.find(c => c.id === '__custom');
  input = undefined; await commands.get('codeCoach.model')();
  assert.equal(settings.model, 'fast-test-model');
  assert.ok(lastInputOptions.validateInput('')); assert.ok(lastInputOptions.validateInput('bad model'));
  assert.equal(lastInputOptions.validateInput('another-model'), undefined);
  input = 'another-model'; workspaceOverride = true;
  await commands.get('codeCoach.model')();
  assert.equal(settings.model, 'another-model');
  assert.equal(saves.at(-1).target, vscode.ConfigurationTarget.Workspace, '프로젝트 모델 설정이 있으면 해당 범위를 갱신');
  picker = () => undefined; await commands.get('codeCoach.model')();
  assert.ok(lastChoices.some(c => c.id === 'another-model' && c.description.includes('현재 선택')));
  picker = choices => choices.find(c => c.id === '');
  await commands.get('codeCoach.model')(); assert.equal(settings.model, '');
  assert.match(modelStatus.text, /Codex 기본/);
  for (const item of context.subscriptions.reverse()) item.dispose();
});
