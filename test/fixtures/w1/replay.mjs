// W1 HTTP replay driver. The target must be an isolated test deployment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const valueAt = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const interpolate = (value, variables) => {
  if (typeof value === 'string') {
    const exact = /^\$\{([\w.]+)\}$/.exec(value);
    if (exact) {
      const result = valueAt(variables, exact[1]);
      assert.notEqual(result, undefined, `missing variable ${exact[1]}`);
      return result;
    }
    return value.replace(/\$\{([\w.]+)\}/g, (_, key) => {
      const result = valueAt(variables, key);
      assert.notEqual(result, undefined, `missing variable ${key}`);
      return encodeURIComponent(String(result));
    });
  }
  if (Array.isArray(value)) return value.map(item => interpolate(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, variables)]));
  return value;
};

export async function replay(scenario, options) {
  const { baseUrl, token, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), record = () => {} } = options;
  assert.ok(baseUrl && token, 'baseUrl and token are required');
  const variables = structuredClone(options.variables ?? {});
  for (const step of scenario.steps) {
    if (step.sleep_ms !== undefined) {
      const delay = interpolate(step.sleep_ms, variables);
      assert.ok(Number.isSafeInteger(delay) && delay >= 0 && delay <= 600_000, 'invalid delay');
      await sleep(delay);
      record({ step: step.name, sleep_ms: delay });
      continue;
    }
    const path = interpolate(step.path, variables);
    assert.ok(path.startsWith('/') && !path.startsWith('//'), 'only relative target paths allowed');
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: step.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(step.body ? { 'content-type': 'application/json' } : {}) },
      ...(step.body ? { body: JSON.stringify(interpolate(step.body, variables)) } : {}),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    assert.equal(response.status, step.status, `${step.name}: HTTP status`);
    for (const [path, expected] of Object.entries(step.equals ?? {})) {
      assert.deepEqual(valueAt(body, path), interpolate(expected, variables), `${step.name}: ${path}`);
    }
    for (const path of step.exists ?? []) assert.notEqual(valueAt(body, path), undefined, `${step.name}: missing ${path}`);
    if (!step.discard_response) {
      for (const [name, path] of Object.entries(step.capture ?? {})) {
        const value = valueAt(body, path);
        assert.notEqual(value, undefined, `${step.name}: missing capture ${path}`);
        variables[name] = value;
      }
    }
    // Never emit token, request/response bodies, or internal variables in the transcript.
    record({ step: step.name, status: response.status, discarded: !!step.discard_response });
  }
  return variables;
}

async function main() {
  const [scenarioPath, variablesPath] = process.argv.slice(2);
  assert.ok(scenarioPath && variablesPath, 'usage: node replay.mjs SCENARIO.json VARIABLES.json');
  const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
  const variables = JSON.parse(await readFile(variablesPath, 'utf8'));
  await replay(scenario, { baseUrl: process.env.W1_BASE_URL, token: process.env.W1_TOKEN, variables, record: entry => console.log(JSON.stringify(entry)) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
