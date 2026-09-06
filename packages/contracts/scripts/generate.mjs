import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const schemaPath = new URL('../schema/protocol.json', import.meta.url);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const output = await compile(schema, 'ProtocolContracts', {bannerComment: '// Generated from schema/protocol.json. Do not edit.', unknownAny: true});
const runtime = '// Generated from schema/protocol.json. Do not edit.\nexport default ' + JSON.stringify(schema) + ';\n';
for (const [file, content] of [['generated.ts', output], ['schema.ts', runtime]]) {
  const path = new URL('../src/' + file, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== content) throw new Error('Generated files are stale; run contracts generate');
  } else await writeFile(path, content);
}
if (!process.argv.includes('--check')) await writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n');
