const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkers, safeRelative, rankFiles, excerpt, completionTarget, completionText } = require('../src/core');

test('질문이 있는 실제 독립 주석만 감지한다', () => {
  assert.deepEqual(parseMarkers('x = "# @coach ignored"\n# @coach\n  # @coach 차원이 왜 달라질까?\n', 'python'), [{ line: 2, question: '차원이 왜 달라질까?' }]);
  assert.deepEqual(parseMarkers('const a = "// @coach ignored";\n// @coach How?', 'typescript'), [{ line: 1, question: 'How?' }]);
  assert.deepEqual(parseMarkers('<!-- @coach 왜? -->', 'html'), [{ line: 0, question: '왜?' }]);
});

test('여러 줄 문자열과 블록 주석의 예시는 요청하지 않는다', () => {
  assert.deepEqual(parseMarkers('x = """\n# @coach example\n"""\n# @coach real', 'python'), [{ line: 3, question: 'real' }]);
  assert.deepEqual(parseMarkers('const x = `\n// @coach example\n`;\n/*\n// @coach example\n*/\n// @coach real', 'javascript'), [{ line: 6, question: 'real' }]);
});

test('비밀 파일·데이터·경로 탈출을 컨텍스트에서 제외한다', () => {
  for (const f of ['.env', '.git/config', '../model.py', '/tmp/model.py', 'src/credentials.py', 'cookies.txt', 'data.csv', 'weights.pt', 'node_modules/index.js', 'photo.png', 'package-lock.json']) assert.equal(safeRelative(f), false, f);
  for (const f of ['src/model.py', 'README.md', 'AGENTS.md', 'pyproject.toml', 'package.json', 'requirements.txt']) assert.equal(safeRelative(f), true, f);
});

test('관련 파일을 우선하고 큰 코드도 질문 줄을 포함해 제한한다', () => {
  const ranked = rankFiles(['src/model.py', 'README.md', 'unrelated/file.py', '.env'], 'src/train.py', 'model shape');
  assert.ok(ranked.indexOf('src/model.py') < ranked.indexOf('unrelated/file.py'));
  const out = excerpt(Array.from({ length: 500 }, (_, i) => `line_${i}`).join('\n'), 300, 1000);
  assert.ok(out.includes('301: line_300'));
  assert.ok(out.length <= 1000);
});

test('일반 주석 다음 빈 줄에서 제안하고 직접 입력한 줄에서는 자동 재요청하지 않는다', () => {
  const source = '# 양수를 선택\n# 평균을 구하기\n    ';
  const target = completionTarget(source, 'python', 2, 4);
  assert.equal(target.instruction, '양수를 선택\n평균을 구하기');
  assert.equal(target.currentLinePrefix, '    ');
  assert.equal(completionTarget(source, 'python', 2, 4, false, true), null);
  assert.equal(completionTarget('# @coach 평균\n', 'python', 1, 0, false, true).instruction, '평균');
  assert.equal(completionTarget('# 평균\nres', 'python', 1, 3), null);
  assert.ok(completionTarget('# 평균\nres', 'python', 1, 3, true));
  assert.equal(completionTarget('# 평균\nresult = 1\n', 'python', 2, 0), null);
  assert.equal(completionTarget('# 평균\nresult', 'python', 1, 2, true), null);
  assert.equal(completionTarget('s = """\n# fake\n"""\n', 'python', 3, 0), null);
});

test('수락할 코드가 입력한 접두사를 보존하고 길이와 응답 형식을 검증한다', () => {
  const encode = code => JSON.stringify({ code });
  assert.equal(completionText(encode('    result = sum(values)'), '    res', 12), '    result = sum(values)');
  assert.throws(() => completionText(encode('result = 0'), 'my_value', 12), /입력한 코드/);
  assert.equal(completionText(encode('if values:\n    return sum(values)'), '    ', 12), '    if values:\n        return sum(values)');
  assert.equal(completionText(encode('a = 1\nb = 2'), '', 1), 'a = 1\nb = 2');
  assert.throws(() => completionText(encode('```python\na = 1\n```'), '', 12), /형식/);
  assert.throws(() => completionText('설명만 반환', '', 12), /응답 형식/);
});

test('8줄 목표여도 생성된 생성자·forward·닫는 괄호를 잘라내지 않는다', () => {
  const code = [
    'import torch', 'from torch import nn', '', 'class Model(nn.Module):',
    '    def __init__(self):', '        super().__init__()',
    '        self.encoder = nn.TransformerEncoder(',
    '            nn.TransformerEncoderLayer(64, 4),', '            num_layers=2,', '        )', '',
    '    def forward(self, x):', '        return self.encoder(x)'
  ].join('\n');
  const result = completionText(JSON.stringify({ code }), '', 8);
  assert.equal(result, code);
  assert.match(result, /return self.encoder\(x\)$/);
  const js = 'function model(x) {\n  return {\n    value: x\n  };\n}';
  assert.doesNotThrow(() => new Function(completionText(JSON.stringify({ code: js }), '', 2)));
});
