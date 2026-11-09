const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { collectContext } = require('./context');
const { runCodex } = require('./codex');
const { createInlineProvider } = require('./inline');

async function findCodex(config) {
  const explicit = config.get('codexPath', '').trim();
  if (explicit) return explicit;
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (ext) {
    const platform = process.platform === 'darwin' ? `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    const candidate = path.join(ext.extensionPath, 'bin', platform, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await fs.access(candidate); return candidate; } catch { /* Try PATH. */ }
  }
  return 'codex';
}

async function modelCatalog() {
  try {
    const cache = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    const data = JSON.parse(await fs.readFile(cache, 'utf8'));
    return (data.models || []).filter(m => m.slug && m.visibility !== 'hide');
  } catch { return []; }
}

function activate(extensionContext) {
  const config = () => vscode.workspace.getConfiguration('codeCoach');
  const enabled = () => vscode.workspace.isTrusted && config().get('enabled', false);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  const effortStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const modelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'codeCoach.toggle'; effortStatus.command = 'codeCoach.reasoning';
  modelStatus.command = 'codeCoach.model';
  modelStatus.name = '코드 코치 모델 선택';
  modelStatus.accessibilityInformation = { label: '코드 코치 모델 변경', role: 'button' };
  let busy = false, lastError = '', lastNotice = '', lastPayload = '', lastMetrics = null;
  function updateStatus() {
    status.text = !enabled() ? '$(code) 코드 예시 OFF' : busy ? '$(loading~spin) 코드 생성 중…'
      : lastNotice && !lastError ? '$(info) 코드 제안 없음' : `${lastError ? '$(warning)' : '$(code)'} 코드 예시 ON`;
    status.command = enabled() && (lastError || lastNotice) ? 'codeCoach.error' : 'codeCoach.toggle';
    status.tooltip = busy ? '주석과 주변 코드로 예시를 생성하고 있습니다. 모델 응답에 수 초 이상 걸릴 수 있습니다.'
      : lastError || lastNotice ? `${lastError || lastNotice}\n\n클릭하여 내용 확인 및 다시 시도` : '주석 아래 코드 예시 · Tab 수락 / Esc 닫기 · 클릭하여 켜기·끄기';
    if (lastMetrics?.fromCache) status.tooltip += '\n\n캐시 재사용 · 추가 모델 호출 없음';
    else if (lastMetrics) {
      status.tooltip += `\n\n최근 생성: ${(lastMetrics.elapsedMs / 1000).toFixed(1)}초`;
      if (lastMetrics.usage) status.tooltip += ` · 입력 ${lastMetrics.usage.input_tokens ?? 0} / 출력 ${lastMetrics.usage.output_tokens ?? 0} 토큰 (캐시 입력 ${lastMetrics.usage.cached_input_tokens ?? 0})`;
    }
    effortStatus.text = `$(settings-gear) ${config().get('reasoningEffort', 'low')}`;
    effortStatus.tooltip = `추론 수준 선택 · 모델: ${config().get('model', '') || 'Codex 기본값'}`;
    modelStatus.text = `$(hubot) 모델: ${config().get('model', '') || 'Codex 기본'}`;
    modelStatus.tooltip = '클릭하여 코드 예시 생성 모델 변경 · 선택은 저장되며 다음 요청부터 적용됩니다.';
    modelStatus.show();
    status.show(); enabled() ? effortStatus.show() : effortStatus.hide();
  }
  const provider = createInlineProvider({ config, enabled, collectContext, runCodex, findCodex,
    onState(isBusy, error) { busy = isBusy; lastError = error; updateStatus(); },
    onPayload(payload) { lastPayload = payload; },
    onNotice(message) { lastNotice = message; updateStatus(); },
    onMetrics(metrics) { lastMetrics = metrics; updateStatus(); } });

  async function selectEffort() {
    const catalog = await modelCatalog();
    const selected = catalog.find(m => m.slug === config().get('model'));
    const available = selected?.supported_reasoning_levels?.map(r => r.effort) || ['low', 'medium', 'high', 'xhigh', 'max'];
    const names = { low: '낮음 · 빠른 제안', medium: '보통 · 균형', high: '높음 · 깊은 분석', xhigh: '매우 높음', max: '최대' };
    /** @type {{ label: string, description: string, effort: string }[]} */
    const choices = available.filter(e => names[e]).map(e => ({ label: names[e], description: e, effort: e }));
    const pick = await vscode.window.showQuickPick(choices, { title: '코드 예시 추론 수준', placeHolder: '높은 수준은 제안이 나오기까지 더 오래 걸릴 수 있습니다.' });
    if (pick) await saveSetting('reasoningEffort', pick.effort);
  }

  async function selectModel() {
    const models = await modelCatalog();
    const current = config().get('model', '');
    const pick = await vscode.window.showQuickPick([
      { label: 'Codex 기본 모델', description: current ? '' : '현재 선택', detail: 'CLI 기본 모델을 사용합니다.', id: '' },
      ...(current && !models.some(m => m.slug === current)
        ? [{ label: current, description: '현재 선택 · 직접 지정한 모델', id: current }] : []),
      ...models.map(m => ({ label: m.display_name || m.slug,
        description: `${m.slug}${m.slug === current ? ' · 현재 선택' : ''}`,
        detail: `지원 추론: ${(m.supported_reasoning_levels || []).map(r => r.effort).filter(e => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)).join(', ') || '모델에 따라 다름'}`, id: m.slug })),
      { label: '모델 ID 직접 입력…', id: '__custom' }
    ], { title: '코드 예시 모델 변경', matchOnDescription: true,
      placeHolder: models.length ? '모델을 검색해 선택하세요. 목록은 로컬 Codex 캐시 기준입니다.' : '캐시된 모델이 없습니다. 모델 ID를 직접 입력할 수 있습니다.' });
    if (!pick) return;
    const model = pick.id === '__custom' ? await vscode.window.showInputBox({
      title: 'Codex 모델 ID', value: current, prompt: '계정에서 사용할 수 있는 모델 ID를 입력하세요.',
      validateInput: value => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.trim())
        ? undefined : '공백 없이 유효한 모델 ID를 입력하세요.'
    }) : pick.id;
    if (model === undefined) return;
    const nextModel = model.trim();
    if (pick.id === '__custom' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(nextModel)) return;
    await saveSetting('model', nextModel);
    const supported = models.find(m => m.slug === nextModel)?.supported_reasoning_levels?.map(r => r.effort)
      .filter(e => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e));
    if (supported?.length && !supported.includes(config().get('reasoningEffort', 'low'))) {
      await saveSetting('reasoningEffort', supported.includes('medium') ? 'medium' : supported[0]);
    }
    updateStatus();
  }

  function saveSetting(key, value) {
    const setting = config().inspect(key);
    const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return config().update(key, value, target);
  }

  function register(name, callback) { extensionContext.subscriptions.push(vscode.commands.registerCommand(`codeCoach.${name}`, callback)); }
  register('accepted', (uri, instruction) => provider.didAccept(uri, instruction));
  register('error', async () => {
    if (!lastError && !lastNotice) { vscode.window.showInformationMessage('최근 코드 제안 오류가 없습니다.'); return; }
    const action = lastError ? await vscode.window.showWarningMessage(`코드 제안 오류: ${lastError}`, '다시 제안', '켜기/끄기')
      : await vscode.window.showInformationMessage(lastNotice, '다시 제안', '켜기/끄기');
    if (action === '다시 제안') await vscode.commands.executeCommand('codeCoach.ask');
    if (action === '켜기/끄기') await vscode.commands.executeCommand('codeCoach.toggle');
  });
  register('toggle', async () => {
    if (!vscode.workspace.isTrusted) { vscode.window.showInformationMessage('신뢰하는 작업 폴더에서 사용할 수 있습니다.'); return; }
    await config().update('enabled', !enabled(), vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  });
  register('ask', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
    if (!enabled()) await config().update('enabled', true, vscode.ConfigurationTarget.Global);
    provider.reset();
    if (!vscode.workspace.getConfiguration('editor', editor.document.uri).get('inlineSuggest.enabled', true)) {
      vscode.window.showInformationMessage('VS Code 설정의 Editor › Inline Suggest: Enabled를 켜 주세요.'); return;
    }
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  });
  register('reasoning', selectEffort); register('model', selectModel);
  register('context', async () => {
    if (!lastPayload) { vscode.window.showInformationMessage('아직 전송한 코드 예시 요청이 없습니다.'); return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(JSON.parse(lastPayload), null, 2) });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  extensionContext.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, provider),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length) provider.invalidate(e.document.uri.toString()); }),
    vscode.workspace.onDidCloseTextDocument(doc => provider.invalidate(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('codeCoach')) return;
      provider.reset();
      if (!enabled()) { lastPayload = ''; lastMetrics = null; }
      void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
      updateStatus();
    }), provider, status, effortStatus, modelStatus
  );
  updateStatus();
}

module.exports = { activate };
