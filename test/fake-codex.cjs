#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', s => input += s);
process.stdin.on('end', () => {
  if (input === 'wait') return setTimeout(() => {}, 30000);
  if (input === 'fail') {
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'Unsupported effort' } }));
    process.exitCode = 1; return;
  }
  if (input === 'empty') return;
  const args = process.argv.slice(2);
  const instructions = args.find(a => a.startsWith('model_instructions_file='));
  if (instructions) {
    const file = JSON.parse(instructions.slice('model_instructions_file='.length));
    if (!require('node:fs').readFileSync(file, 'utf8').trim()) throw new Error('Missing completion instructions');
    if (args.some(a => a.startsWith('developer_instructions='))) throw new Error('Duplicated instructions');
  }
  if (!args.includes('read-only') || args.includes('--dangerously-bypass-approvals-and-sandbox')) throw new Error('Bad sandbox');
  const result = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '먼저 입력 차원을 생각해 보세요. 어떤 값일까요?' } });
  process.stdout.write(result.slice(0, 30));
  setTimeout(() => process.stdout.write(result.slice(30) + '\n' + JSON.stringify({ type: 'turn.completed',
    usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 } })), 10);
});
