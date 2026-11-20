-- Apply to a disposable Whippet database with the standard migration seeds.
-- The HTTP site for this published fixture can change without editing the test.
BEGIN;
CREATE TEMP TABLE inspection_fixture AS SELECT
  'http://host.docker.internal:19932'::text AS origin,
  '00000000-0000-4000-8000-000000000001'::uuid AS workspace_id,
  '10000000-0000-4000-8000-000000000002'::uuid AS test_id,
  '40000000-0000-4000-8000-000000000004'::uuid AS version_id,
  $spec$import { test, expect } from '@playwright/test';
test('TodoMVC model', async ({ page }) => {
  await page.goto('http://host.docker.internal:19932/');
  const saved = await page.evaluate(() => {
    let count = 0;
    const model = new window.app.Model({save() { count++; }});
    model.create('   ');
    return count;
  });
  await expect(saved, 'Blank titles are ignored').toBe(0);
});
$spec$::text AS script;
UPDATE workspaces w SET lifecycle='active',scope_status='confirmed',authorization_revision=1,
  canonical_config=jsonb_build_object('name','Inspection fixture','purpose','W4 QA','backgroundSummary','','exclusions','','dependencies','[]'::jsonb,'excludedOrigins','[]'::jsonb,'loginRoles','[]'::jsonb,'targets',
    jsonb_build_array(jsonb_build_object('name','Local test site','purpose','Inspection','origin',f.origin)),
    'defaultTestUrl',f.origin,'timeoutMs',60000)
FROM inspection_fixture f WHERE w.id=f.workspace_id;
INSERT INTO test_versions(id,test_id,version,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin)
SELECT f.version_id,f.test_id,3,f.script,encode(sha256(convert_to(f.script,'UTF8')),'hex'),60000,
  jsonb_build_object('revision',1,'defaultTestUrl',f.origin,'sites',jsonb_build_array(jsonb_build_object('name','Local test site','url',f.origin)),'timeoutMs',60000),
  jsonb_build_object('schemaVersion','1','workspaceId',w.id,'settingsRevision',1,'config',w.canonical_config,'roleRefs','[]'::jsonb),'manual'
FROM inspection_fixture f JOIN workspaces w ON w.id=f.workspace_id ON CONFLICT (id) DO NOTHING;
UPDATE tests t SET published_version_id=f.version_id FROM inspection_fixture f WHERE t.id=f.test_id;
COMMIT;
