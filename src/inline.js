const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { completionTarget, completionText, COMPLETION_RULES, COMPLETION_SCHEMA } = require('./core');

function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const cancel = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(true); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Native ghost-text provider. Only VS Code applies the edit when the user accepts it. */
function createInlineProvider({ config, enabled, collectContext, runCodex, findCodex, onState, onPayload,
  onNotice = (_message) => {}, onMetrics = (_metrics) => {} }) {
  let active = null, lastError = '';
  const cache = new Map();
  const continuations = new Map();
  const cancel = () => { active?.abort.abort(); active = null; onState(false, lastError); };
  const reset = () => { cancel(); cache.clear(); continuations.clear(); lastError = ''; onNotice(''); onState(false, ''); };
  const invalidate = uri => {
    // Own-document edits change the content hash. Retain past results for undo/extra blank lines.
    // An edit in another document may change related context, so invalidate those results.
    for (const [key, entry] of cache) if (entry.uri !== uri) cache.delete(key);
    if (active?.uri === uri) cancel();
    const accepted = continuations.get(uri), editor = vscode.window.activeTextEditor;
    if (accepted && editor?.document.uri.toString() === uri && editor.document.getText().trimEnd() !== accepted.source) continuations.delete(uri);
    onNotice('');
  };

  const didAccept = (uri, instruction) => {
    const editor = vscode.window.activeTextEditor;
    if (!enabled() || !editor || editor.document.uri.toString() !== uri || typeof instruction !== 'string') return;
    continuations.set(uri, { source: editor.document.getText().trimEnd(), instruction, time: Date.now() });
    while (continuations.size > 16) continuations.delete(continuations.keys().next().value);
  };

  return {
    reset, invalidate, didAccept, dispose: reset,
    /** @type {import('vscode').InlineCompletionItemProvider['provideInlineCompletionItems']} */
    async provideInlineCompletionItems(document, position, context, token) {
      if (!enabled() || document.uri.scheme !== 'file' || token.isCancellationRequested || context.selectedCompletionInfo) return [];
      const settings = config(), uri = document.uri.toString();
      const explicit = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
      const source = document.getText();
      let target = completionTarget(source, document.languageId, position.line, position.character,
        explicit, settings.get('commentTrigger', 'all') === 'marked');
      if (!target) {
        const accepted = continuations.get(uri), lines = source.split(/\r?\n/), current = lines[position.line];
        if (accepted && Date.now() - accepted.time < 300000 && accepted.source === source.trimEnd()
          && current !== undefined && !current.trim() && position.character === current.length
          && !lines.slice(position.line + 1).join('\n').trim()) {
          target = { instruction: accepted.instruction, currentLinePrefix: current,
            codeBeforeCursor: '', codeAfterCursor: '' };
        }
      }
      if (!target) { cancel(); return []; }
      const version = document.version;
      const contentHash = createHash('sha256').update(source.trimEnd()).digest('hex');
      const key = JSON.stringify([uri, contentHash, target.instruction, target.currentLinePrefix, target.codeAfterCursor.trim(),
        settings.get('model', ''), settings.get('reasoningEffort', 'low'), settings.get('maxSuggestionLines', 8)]);
      const item = code => [new vscode.InlineCompletionItem(code, new vscode.Range(position.line, 0, position.line, position.character),
        { command: 'codeCoach.accepted', title: '코드 예시 수락', arguments: [uri, target.instruction] })];
      const cached = cache.get(key);
      if (cached && Date.now() - cached.time < 300000) {
        cancel(); lastError = ''; onNotice(cached.notice); onState(false, ''); onMetrics({ fromCache: true });
        return cached.code ? item(cached.code) : [];
      }
      cancel();
      const request = { uri, abort: new AbortController() }; active = request;
      const { signal } = request.abort;
      const subscription = token.onCancellationRequested(() => request.abort.abort());
      try {
        lastError = ''; onNotice(''); onState(true, '');
        if (!await pause(explicit ? 0 : settings.get('debounceMs', 600), signal)) return [];
        if (signal.aborted || !enabled() || document.version !== version) return [];
        const project = await collectContext(document, position.line, target.instruction, settings);
        if (signal.aborted) return [];
        const editor = vscode.window.activeTextEditor;
        const maxLines = settings.get('maxSuggestionLines', 8);
        // The numbered project excerpt already contains both sides of the cursor.
        const prompt = JSON.stringify({ project, completion: { instruction: target.instruction, currentLinePrefix: target.currentLinePrefix, maxLines,
          cursor: { line: position.line + 1, character: position.character },
          indentation: { insertSpaces: editor?.options.insertSpaces, tabSize: editor?.options.tabSize } } });
        onPayload(prompt);
        const executable = await findCodex(settings);
        if (signal.aborted) return [];
        const started = Date.now(); let usage;
        const result = await runCodex({ executable, prompt, effort: settings.get('reasoningEffort', 'low'),
          model: settings.get('model', ''), timeoutMs: settings.get('requestTimeoutSeconds', 180) * 1000,
          signal, rules: COMPLETION_RULES, outputSchema: COMPLETION_SCHEMA, onUsage: value => { usage = value; } });
        onMetrics({ fromCache: false, elapsedMs: Date.now() - started, promptChars: prompt.length, usage });
        if (signal.aborted || token.isCancellationRequested || !enabled() || document.version !== version) return [];
        const currentEditor = vscode.window.activeTextEditor;
        if (currentEditor && (currentEditor.document.uri.toString() !== uri || !currentEditor.selection.isEmpty
          || currentEditor.selection.active.line !== position.line || currentEditor.selection.active.character !== position.character)) return [];
        const code = completionText(result, target.currentLinePrefix, maxLines);
        const notice = code ? '' : '현재 주석에 대한 제안이 없습니다. 원하는 다음 동작을 구체적으로 적거나 수동으로 다시 제안해 주세요.';
        onNotice(notice);
        cache.set(key, { uri, code, notice, time: Date.now() });
        while (cache.size > 16) cache.delete(cache.keys().next().value);
        return code ? item(code) : [];
      } catch (error) {
        if (!signal.aborted) {
          lastError = String(error.message).slice(0, 1000);
          if (explicit) vscode.window.showWarningMessage(`코드 제안 실패: ${lastError}`);
        }
        return [];
      } finally {
        subscription.dispose();
        if (active === request) { active = null; onState(false, lastError); }
      }
    }
  };
}

module.exports = { createInlineProvider };
