import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../fixtures/w2/model.mjs';

test('model double requests evidence before returning a scored analysis', () => {
  const context = { ticket_data: { title: 'score-7' }, approved_evidence_catalog: {} };
  const messages = [{ role: 'system', content: 'fixture' }, { role: 'user', content: JSON.stringify(context) }];
  assert.equal(answer(messages).action, 'read');
  messages.push({ role: 'user', content: JSON.stringify({ evidence: { reference: 'ev:' + 'a'.repeat(64), repo_id: 'fixture-repo', base_commit: 'a'.repeat(40), path: 'src/items.js', content: 'return allItems;' } }) });
  const result = answer(messages).analysis;
  assert.equal(Object.values(result.assessment).reduce((sum, item) => sum + item.score, 0), 7);
  assert.equal(result.proposal.changes[0].before, 'return allItems;');
});
