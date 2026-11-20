// OpenAI-shaped local HTTP fixture: deterministic model double, never a real model.
import http from 'node:http';

const factors = ['cause_or_requirement', 'implementation', 'impact', 'scope_and_checks', 'verification'];
export function answer(messages) {
  const context = JSON.parse(messages[1].content);
  const last = JSON.parse(messages.at(-1).content);
  if (!last.evidence) return { action: 'read', request: { operation: 'read_repo_file', repo_id: 'fixture-repo', path: 'src/items.js' } };
  const evidence = last.evidence;
  if (!evidence.reference || !evidence.content.includes('return allItems;')) throw new Error('fixture requires current real repository evidence');
  const title = context.ticket_data.title;
  const match = /score-(\d+)/.exec(title);
  const score = match ? Number(match[1]) : 10;
  const assessment = Object.fromEntries(factors.map((name, i) => [name, { score: score >= 5 ? 1 + (i < score - 5 ? 1 : 0) : (i < score ? 1 : 0), reason: '已查核隔離測試資料。', evidence_refs: [evidence.reference] }]));
  if (score > 10) assessment.verification.score = 3;
  const base = { classification: 'bug', summary: '清單結果需檢查。', impact: '影響清單顯示。', criteria: ['結果符合預期。'], evidence_refs: [evidence.reference], missing_requirements: [], assessment };
  const proposal = { repo_id: evidence.repo_id, base_commit: evidence.base_commit, changes: [{ path: evidence.path, before: 'return allItems;', after: 'return uniqueItems;' }], verification: ['清單結果符合預期。'], required_check_ids: ['unit'], pending_decisions: [] };
  if (title.includes('explanation')) return { action: 'finish', analysis: { ...base, classification: 'explanation', customer_body: '請重新整理清單，再查看最新結果。' } };
  if (title.includes('needs-info') && context.ticket_data.messages.some(item => item.speaker === 'customer')) return { action: 'finish', analysis: { ...base, classification: 'explanation', customer_body: '已收到補充資料，請重新整理清單。' } };
  if (title.includes('needs-info')) return { action: 'finish', analysis: { ...base, classification: 'needs_information', missing_requirements: ['操作時間'], customer_body: '請補充發生問題的時間。' } };
  if (title.includes('pending')) return { action: 'finish', analysis: { ...base, classification: 'change_request', criteria: [], proposal: { ...proposal, pending_decisions: ['請確認業務規則。'] } } };
  return { action: 'finish', analysis: { ...base, proposal } };
}
export async function startModel() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const input = JSON.parse(raw); const output = answer(input.messages);
      calls.push({ at: Date.now(), action: output.action, title: JSON.parse(input.messages[1].content).ticket_data.title, leaked_fixture_secret: JSON.stringify(input.messages).includes('fixture-secret-1234567890') });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { url: `http://127.0.0.1:${server.address().port}/chat`, calls, close: () => new Promise(ok => { server.closeAllConnections(); server.close(ok); }) };
}
