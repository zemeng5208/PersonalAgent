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

test('host-fixed recipes and factory delegation: helper generates bounded recipes and delegates to factory', () => {
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

    // Fails closed if createWorkspaceCommandTool is missing or not a function
    assert.throws(() => createWorkspaceCommandRecipeTool({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
    }), /Public createWorkspaceCommandTool factory is required/);

    const {tool, recipes} = createWorkspaceCommandRecipeTool({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js', 'src/app.js'],
      createWorkspaceCommandTool: fakeFactory,
    });

    assert.equal(recipes.length, 2);
    assert.deepEqual(recipes.map(r => r.id), ['node-check-index.js', 'node-check-src-app.js']);
    assert.ok(recipes.every(r => r.args[0] === '--check'));

    // Helper pre-constructs fixed recipes and passes them to factory.
    // The public command.ts contract enforces that input is strictly constrained to recipeId.
    const enumValues = tool.descriptor.inputSchema.properties.recipeId.enum;
    assert.deepEqual(enumValues, ['node-check-index.js', 'node-check-src-app.js']);
    assert.equal(capturedOptions.rootPath, root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('nodeExecutable requires explicit injection, basename verification, and workspace separation', t => {
  const root = createTempDir('pa-cmd-node-check-');
  const externalDir = createTempDir('pa-cmd-node-ext-');
  t.after(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(externalDir, {recursive: true, force: true});
  });

  const validJs = path.join(root, 'index.js');
  writeFileSync(validJs, 'console.log("ok");\n');

  // 1. Missing nodeExecutable throws immediately (no PATH/where.exe search fallback)
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    checkFiles: ['index.js'],
  }), /Trusted absolute node\.exe executable path is required/i);

  // 2. Relative nodeExecutable throws
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: 'node.exe',
    checkFiles: ['index.js'],
  }), /Trusted absolute node\.exe executable path is required/i);

  // 3. Binary with non-node basename is rejected
  const fakeCmd = path.join(externalDir, 'cmd.exe');
  writeFileSync(fakeCmd, 'fake');
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: fakeCmd,
    checkFiles: ['index.js'],
  }), /Node executable must be named/i);

  // 4. Node executable inside writable workspace is rejected
  const internalNodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const internalNode = path.join(root, internalNodeName);
  writeFileSync(internalNode, 'fake');
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: internalNode,
    checkFiles: ['index.js'],
  }), /outside the writable workspace/i);
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

  // 4. Authorized workspace root mismatch rejected
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    authorizedWorkspaceRoot: externalDir,
    nodeExecutable: process.execPath,
    checkFiles: ['valid.js'],
  }), /outside the fixed Desktop authorization/i);
});

test('project scripts policy: npm build/test recipes are NOT exposed regardless of switch', t => {
  const root = createTempDir('pa-cmd-npm-policy-');
  t.after(() => rmSync(root, {recursive: true, force: true}));

  writeFileSync(path.join(root, 'index.js'), 'console.log(1);\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sample-project',
    scripts: {
      build: 'node -e "console.log(1)"',
      test: 'node -e "console.log(2)"',
    },
  }));

  // Case A: allowProjectScripts is false (default)
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: false,
    });
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].id, 'node-check');
    assert.equal(diagnostics.projectScriptsAllowed, false);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(!recipes.some(r => r.id === 'npm-build' || r.id === 'npm-test'));
  }

  // Case B: allowProjectScripts is true -> STILL no npm recipes exposed, clear diagnostic reason recorded
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
    });
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0].id, 'node-check');
    assert.equal(diagnostics.projectScriptsAllowed, true);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(!recipes.some(r => r.id === 'npm-build' || r.id === 'npm-test'));
    assert.ok(diagnostics.reasons.some(r => r.includes('npm project scripts are not exposed')));
    assert.ok(diagnostics.npmHurdles.length > 0);
  }
});

test('public command contract validation: recipe limits and properties', async t => {
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
