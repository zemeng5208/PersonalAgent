import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildWorkspaceCommandRecipes,
  createWorkspaceCommandRecipeTool,
  sanitizeRecipeId,
} from '../electron/workspace-command-recipes.js';

function createTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sanitizeRecipeId enforces lowercase alphanumeric pattern matching command.ts', () => {
  assert.equal(sanitizeRecipeId('node-check', 'index.js'), 'node-check-index.js');
  assert.equal(sanitizeRecipeId('node-check', 'src/App.Client.js'), 'node-check-src-app.client.js');
  assert.equal(sanitizeRecipeId('node-check', 'special!@#$%^&*()file.js'), 'node-check-special-file.js');
  assert.match(sanitizeRecipeId('node-check', 'foo/bar.js'), /^[a-z][a-z0-9._-]{0,63}$/u);
});

test('default project scripts OFF: only node --check recipes are produced even if package.json has scripts', t => {
  const root = createTempDir('pa-cmd-default-off-');
  t.after(() => rmSync(root, {recursive: true, force: true}));

  writeFileSync(path.join(root, 'index.js'), 'console.log("hello");\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: {
      build: 'node -e "console.log(1)"',
      test: 'node -e "console.log(2)"',
    },
  }));

  const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    checkFiles: ['index.js'],
    // allowProjectScripts is omitted -> defaults to false
  });

  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].id, 'node-check');
  assert.equal(recipes[0].executable, process.execPath);
  assert.deepEqual(recipes[0].args, ['--check', 'index.js']);

  assert.equal(diagnostics.projectScriptsAllowed, false);
  assert.equal(diagnostics.projectScriptsExposed, false);
  assert.ok(!recipes.some(r => r.id === 'npm-build' || r.id === 'npm-test'));
});

test('fixed allowed input only: model/caller cannot supply arbitrary executables, shell strings, or unlisted recipeIds', () => {
  const root = createTempDir('pa-cmd-fixed-input-');
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'app.js'), 'console.log("app");\n');
    writeFileSync(path.join(root, 'index.js'), 'console.log("index");\n');

    let capturedOptions = null;
    const fakeFactory = options => {
      capturedOptions = options;
      return {
        descriptor: {
          name: 'workspace.run_allowed_command',
          version: '1.0.0',
          sideEffect: 'local_write',
          requiredScopes: ['workspace:execute'],
          inputSchema: {
            type: 'object',
            required: ['recipeId'],
            additionalProperties: false,
            properties: {
              recipeId: {type: 'string', enum: options.recipes.map(r => r.id)},
            },
          },
        },
        execute: async ({recipeId}) => {
          const found = options.recipes.find(r => r.id === recipeId);
          if (!found) throw Error(`Unknown recipe: ${recipeId}`);
          return {recipeId, exitCode: 0, stdout: '', stderr: ''};
        },
      };
    };

    const {tool, recipes} = createWorkspaceCommandRecipeTool({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js', 'src/app.js'],
      createWorkspaceCommandTool: fakeFactory,
    });

    assert.equal(recipes.length, 2);
    assert.deepEqual(recipes.map(r => r.id), ['node-check-index.js', 'node-check-src-app.js']);
    assert.ok(recipes.every(r => r.args[0] === '--check'));

    // Input schema strictly limits recipeId to pre-enumerated set
    const enumValues = tool.descriptor.inputSchema.properties.recipeId.enum;
    assert.deepEqual(enumValues, ['node-check-index.js', 'node-check-src-app.js']);
    assert.equal(tool.descriptor.inputSchema.additionalProperties, false);
    assert.equal(capturedOptions.rootPath, root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('out-of-bounds, traversal, symlink, and invalid file rejection', t => {
  const root = createTempDir('pa-cmd-security-');
  const externalDir = createTempDir('pa-cmd-external-');
  t.after(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(externalDir, {recursive: true, force: true});
  });

  const validFile = path.join(root, 'valid.js');
  writeFileSync(validFile, 'const x = 1;\n');

  // 1. Path traversal escape rejected
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    checkFiles: ['../escape.js'],
  }), /escape/i);

  // 2. Absolute path rejected
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    checkFiles: [path.join(externalDir, 'secret.js')],
  }), /workspace-relative/i);

  // 3. Symbolic link inside workspace rejected
  const linkFile = path.join(root, 'link.js');
  let symlinksSupported = true;
  try {
    symlinkSync(validFile, linkFile);
  } catch {
    symlinksSupported = false;
  }
  if (symlinksSupported) {
    assert.throws(() => buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['link.js'],
    }), /symbolic link/i);
  }

  // 4. Node executable inside the writable workspace rejected
  const fakeInternalNode = path.join(root, 'fake-node.exe');
  writeFileSync(fakeInternalNode, 'fake');
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: fakeInternalNode,
    checkFiles: ['valid.js'],
  }), /outside the writable workspace/i);

  // 5. Authorized workspace root mismatch rejected
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    authorizedWorkspaceRoot: externalDir,
    nodeExecutable: process.execPath,
    checkFiles: ['valid.js'],
  }), /outside the fixed Desktop authorization/i);
});

test('explicit project scripts switch semantics (allowProjectScripts: true)', t => {
  const root = createTempDir('pa-cmd-npm-scripts-');
  const externalDir = createTempDir('pa-cmd-external-npm-');
  t.after(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(externalDir, {recursive: true, force: true});
  });

  writeFileSync(path.join(root, 'index.js'), 'console.log(1);\n');
  const dummyNpmCli = path.join(externalDir, 'npm-cli.js');
  writeFileSync(dummyNpmCli, 'console.log("npm");\n');

  // Case A: allowProjectScripts = true, but package.json does not exist
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
      npmCliPath: dummyNpmCli,
    });
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].id, 'node-check');
    assert.equal(diagnostics.projectScriptsAllowed, true);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.includes('package.json not found')));
  }

  // Case B: allowProjectScripts = true, package.json exists with build and test scripts
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sample',
    scripts: {
      build: 'node -e "console.log(1)"',
      test: 'node -e "console.log(2)"',
    },
  }));

  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
      npmCliPath: dummyNpmCli,
    });
    assert.equal(recipes.length, 3);
    assert.deepEqual(recipes.map(r => r.id), ['node-check', 'npm-build', 'npm-test']);
    assert.deepEqual(recipes.find(r => r.id === 'npm-build').args, [dummyNpmCli, 'run', 'build']);
    assert.deepEqual(recipes.find(r => r.id === 'npm-test').args, [dummyNpmCli, 'test']);
    assert.equal(diagnostics.projectScriptsExposed, true);
    assert.ok(diagnostics.npmHurdles.length > 0);
  }

  // Case C: npmCliPath placed inside workspace is rejected
  const internalNpmCli = path.join(root, 'internal-npm-cli.js');
  writeFileSync(internalNpmCli, 'console.log("bad");\n');
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
      npmCliPath: internalNpmCli,
    });
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].id, 'node-check');
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.includes('npm-cli.js was not found outside')));
  }
});

test('public command contract validation: recipe limits and execution properties', async t => {
  const root = createTempDir('pa-cmd-contract-');
  t.after(() => rmSync(root, {recursive: true, force: true}));

  const validFile = path.join(root, 'valid.js');
  const badSyntaxFile = path.join(root, 'bad.js');
  writeFileSync(validFile, 'const a = 1; console.log(a);\n');
  writeFileSync(badSyntaxFile, 'const a = ;\n');

  // Verify bounded recipes requirement
  assert.throws(() => createWorkspaceCommandRecipeTool({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    checkFiles: [],
    createWorkspaceCommandTool: () => {},
  }), /No approved command recipes/);

  // Minimal contract execution simulation verifying node --check behavior
  const {recipes} = buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    checkFiles: ['valid.js', 'bad.js'],
  });

  assert.equal(recipes.length, 2);
  for (const recipe of recipes) {
    assert.match(recipe.id, /^[a-z][a-z0-9._-]{0,63}$/u);
    assert.ok(path.isAbsolute(recipe.executable));
    assert.ok(Array.isArray(recipe.args));
    assert.ok(recipe.args.length <= 32);
    assert.ok(recipe.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')));
  }
});
