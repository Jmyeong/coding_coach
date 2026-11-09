const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
let root, files = [], documents = [];
const uri = fsPath => ({ fsPath });
const vscode = {
  workspace: {
    getWorkspaceFolder: () => ({ uri: uri(root) }),
    findFiles: async pattern => files.map(f => uri(path.join(root, f))).filter(u => {
      const relative = path.relative(pattern.base, u.fsPath);
      return relative && !relative.startsWith('..') && (pattern.pattern !== '*' || !relative.includes(path.sep));
    }),
    get textDocuments() { return documents; }
  },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  languages: { getDiagnostics: () => [] }
};
const original = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
const { collectContext } = require('../src/context');
Module._load = original;
const config = { get: (key, fallback) => key === 'maxContextChars' ? 4000 : fallback };

test('현재 저장 전 코드와 Git에서 허용한 관련 파일만 수집한다', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-context-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.py\n');
    await fs.writeFile(path.join(root, 'train.py'), 'saved code');
    await fs.writeFile(path.join(root, 'model.py'), 'related model');
    await fs.writeFile(path.join(root, 'ignored.py'), 'must not send');
    await fs.writeFile(path.join(root, 'README.md'), 'project context');
    await fs.writeFile(path.join(root, 'cookies.txt'), 'must not send');
    files = ['train.py', 'model.py', 'ignored.py', 'README.md', 'cookies.txt'];
    const doc = { uri: uri(path.join(root, 'train.py')), languageId: 'python', getText: () => 'unsaved model shape' };
    documents = [doc];
    const result = await collectContext(doc, 0, 'model shape?', config);
    assert.match(result.code, /unsaved model shape/);
    assert.ok(result.relatedFiles.some(f => f.path === 'model.py'));
    assert.ok(!result.fileList.includes('ignored.py'));
    assert.ok(!result.fileList.includes('cookies.txt'));
    await assert.rejects(collectContext({ ...doc, uri: uri(path.join(root, 'ignored.py')) }, 0, 'q', config), /Git에서 제외/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('개인 일반 폴더의 파일과 외부 심볼릭 링크를 확장하지 않는다', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-context-'));
  try {
    root = path.join(temp, 'Downloads'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'train.py'), 'current');
    await fs.writeFile(path.join(root, 'unrelated.py'), 'unrelated');
    files = ['train.py', 'unrelated.py'];
    const doc = { uri: uri(path.join(root, 'train.py')), languageId: 'python', getText: () => 'current' };
    documents = [doc];
    const result = await collectContext(doc, 0, 'q', config);
    assert.deepEqual(result.fileList, ['train.py']);
    assert.deepEqual(result.relatedFiles, []);
    await fs.writeFile(path.join(temp, 'external.py'), 'external');
    await fs.symlink(path.join(temp, 'external.py'), path.join(root, 'link.py'));
    files.push('link.py');
    await assert.rejects(collectContext({ ...doc, uri: uri(path.join(root, 'link.py')) }, 0, 'q', config), /프로젝트 밖/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('Downloads 아래 프로젝트의 dataset.py를 현재 코드와 관련 파일로 수집한다', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-context-'));
  try {
    root = path.join(temp, 'Downloads');
    await fs.mkdir(path.join(root, 'train_test', 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'other_project'));
    await fs.writeFile(path.join(root, 'train_test', 'dataset.py'), '# mnist 데이터로더\n');
    await fs.writeFile(path.join(root, 'train_test', 'model.py'), 'class Model: pass');
    await fs.writeFile(path.join(root, 'train_test', 'src', 'train.py'), 'train code');
    await fs.writeFile(path.join(root, 'other_project', 'private.py'), 'unrelated');
    files = ['train_test/dataset.py', 'train_test/model.py', 'train_test/src/train.py', 'other_project/private.py'];
    const doc = { uri: uri(path.join(root, 'train_test', 'dataset.py')), languageId: 'python', getText: () => '# mnist 데이터로더\n' };
    documents = [doc];
    const result = await collectContext(doc, 1, 'mnist 데이터로더', config);
    assert.equal(result.currentFile, 'dataset.py');
    assert.ok(result.relatedFiles.some(f => f.path === 'model.py'));
    assert.ok(!result.fileList.some(f => f.includes('other_project')));
    const nested = { ...doc, uri: uri(path.join(root, 'train_test', 'src', 'train.py')) };
    const nestedResult = await collectContext(nested, 0, 'train', config);
    assert.equal(nestedResult.currentFile, 'src/train.py');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
