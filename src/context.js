const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { safeRelative, rankFiles, excerpt } = require('./core');
const execFileAsync = promisify(execFile);
const EXCLUDES = '**/{.*,node_modules,__pycache__,venv,env,dist,build,vendor,data,datasets,checkpoints,wandb}/**';

async function collectContext(doc, line, question, config) {
  const workspace = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath || path.dirname(doc.uri.fsPath);
  let root = workspace;
  for (let folder = path.dirname(doc.uri.fsPath); folder === workspace || folder.startsWith(workspace + path.sep); folder = path.dirname(folder)) {
    const markers = await Promise.all(['.git', 'pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod'].map(async name => {
      try { await fs.access(path.join(folder, name)); return true; } catch { return false; }
    }));
    if (markers.some(Boolean)) { root = folder; break; }
    if (folder === workspace || path.dirname(folder) === folder) break;
  }
  // A folder opened at Downloads may contain several independent projects.
  // Keep a file in train_test/src scoped to train_test, even without a manifest.
  if (/^(Downloads|Desktop|Documents)$/i.test(path.basename(root))) {
    const relative = path.relative(root, doc.uri.fsPath);
    const parts = relative.split(path.sep);
    if (parts.length > 1 && parts[0] !== '..' && !path.isAbsolute(relative)) root = path.join(root, parts[0]);
  }
  const current = path.relative(root, doc.uri.fsPath).replace(/\\/g, '/');
  if (!safeRelative(current)) throw new Error('이 파일은 컨텍스트 제외 대상입니다. 비밀 파일과 숨김 파일은 전송하지 않습니다.');
  const extra = config.get('exclude', []);
  const exclude = '{' + [EXCLUDES, ...extra].join(',') + '}';
  const standalone = /^(Downloads|Desktop|Documents)$/i.test(path.basename(root));
  let uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, standalone ? '*' : '**/*'), exclude, 800);
  if (standalone) uris = uris.filter(u => u.fsPath === doc.uri.fsPath);
  let files = uris.map(u => path.relative(root, u.fsPath).replace(/\\/g, '/')).filter(safeRelative);
  // Git's own ignore rules, including global excludes, govern both saved and unsaved context.
  try {
    const result = await execFileAsync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { maxBuffer: 2 * 1024 * 1024, timeout: 5000 });
    const allowed = new Set(result.stdout.split('\0'));
    files = files.filter(f => allowed.has(f));
    if (!allowed.has(current)) throw new Error('COACH_IGNORED');
  } catch (error) {
    if (error.message === 'COACH_IGNORED') throw new Error('Git에서 제외한 파일은 전송하지 않습니다.');
    // Without Git, built-in and user excludes still apply.
  }
  if (!uris.some(u => u.fsPath === doc.uri.fsPath)) throw new Error('현재 파일이 제외 패턴에 해당하거나 파일 목록 한도를 넘었습니다.');
  const max = config.get('maxContextChars', 6000);
  const active = excerpt(doc.getText(), line, Math.floor(max * 0.65));
  let remaining = max - active.length;
  const related = [];
  const realRoot = await fs.realpath(root);
  const realActive = await fs.realpath(doc.uri.fsPath);
  if (!realActive.startsWith(realRoot + path.sep)) throw new Error('프로젝트 밖을 가리키는 링크 파일은 전송하지 않습니다.');
  for (const relative of rankFiles(files, current, question + ' ' + active).slice(0, 10)) {
    if (remaining < 300 || related.length >= 2) break;
    const file = path.join(root, relative);
    try {
      const real = await fs.realpath(file);
      if (!real.startsWith(realRoot + path.sep)) continue;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 128000) continue;
      const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
      const text = open ? open.getText() : await fs.readFile(file, 'utf8');
      if (text.includes('\0')) continue;
      const content = excerpt(text, 0, Math.min(1800, remaining));
      related.push({ path: relative, content });
      remaining -= content.length;
    } catch { /* Missing or unreadable optional context. */ }
  }
  const diagnostics = vscode.languages.getDiagnostics(doc.uri).slice(0, 4).map(d => ({
    line: d.range.start.line + 1, message: d.message.slice(0, 200), severity: d.severity
  }));
  return { currentFile: current, language: doc.languageId, focusLine: line + 1, code: active,
    relatedFiles: related, fileList: files.slice(0, 30), diagnostics,
    note: standalone ? '일반 개인 폴더이므로 현재 파일만 참고합니다. 프로젝트 폴더 안에서는 관련 파일도 참고합니다.'
      : '파일 목록과 관련 파일은 한도 내 일부입니다. 현재 파일은 저장되지 않은 변경을 포함합니다.' };
}

module.exports = { collectContext };
