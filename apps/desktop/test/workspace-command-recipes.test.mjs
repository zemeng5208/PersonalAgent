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

test('project scripts gatekeeping: npm build/test recipes require all conditions to be satisfied', t => {
  const root = createTempDir('pa-cmd-npm-gate-');
  const externalDir = createTempDir('pa-cmd-npm-ext-');
  t.after(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(externalDir, {recursive: true, force: true});
  });

  const fakeHelperName = process.platform === 'win32' ? 'WindowsJobProcessHost.exe' : 'job-helper';
  const externalHelper = path.join(externalDir, fakeHelperName);
  writeFileSync(externalHelper, 'fake-helper');

  const externalNpmCli = path.join(externalDir, 'npm-cli.js');
  writeFileSync(externalNpmCli, 'console.log("fake npm cli");');

  writeFileSync(path.join(root, 'index.js'), 'console.log(1);\n');

  // Case 1: allowProjectScripts is false (default) -> no npm recipes
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
  }

  // Case 2: allowProjectScripts is true, but no helper -> job_helper_missing
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
    });
    assert.equal(recipes.length, 1);
    assert.equal(diagnostics.projectScriptsAllowed, true);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.startsWith('job_helper_missing')));
  }

  // Case 3: helper provided, but no npmCliPath -> npm_cli_missing
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
    });
    assert.equal(recipes.length, 1);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.startsWith('npm_cli_missing')));
  }

  // Case 4: helper and npmCli provided, but no package.json -> package_json_missing
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      npmCliPath: externalNpmCli,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
    });
    assert.equal(recipes.length, 1);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.startsWith('package_json_missing')));
  }

  // Add package.json with build and test scripts
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'test-app',
    scripts: {
      build: 'echo build',
      test: 'echo test',
    },
  }));

  // Case 5: package.json exists, but node_modules missing -> dependencies_missing
  {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      npmCliPath: externalNpmCli,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
    });
    assert.equal(recipes.length, 1);
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.startsWith('dependencies_missing')));
  }

  // Add node_modules directory
  mkdirSync(path.join(root, 'node_modules'));

  // Case 6: ALL gates satisfied -> generates npm-build and npm-test recipes
  {
    const mockEnv = {
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SECRET_TOKEN: 'leak_attempt',
      GITHUB_KEY: 'leak_attempt',
    };
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      npmCliPath: externalNpmCli,
      checkFiles: ['index.js'],
      allowProjectScripts: true,
      projectScriptEnvSource: mockEnv,
    });
    assert.equal(diagnostics.projectScriptsAllowed, true);
    assert.equal(diagnostics.projectScriptsExposed, true);
    assert.equal(recipes.length, 3); // node-check, npm-build, npm-test

    const buildRecipe = recipes.find(r => r.id === 'npm-build');
    assert.ok(buildRecipe, 'npm-build recipe created');
    assert.ok(path.isAbsolute(buildRecipe.executable));
    assert.deepEqual(buildRecipe.args.slice(-2), ['run', 'build']);
    assert.equal(buildRecipe.args[buildRecipe.args.length - 3], externalNpmCli);
    assert.equal(buildRecipe.args[buildRecipe.args.length - 4], '--');
    assert.equal(buildRecipe.args[0], '--cwd');
    assert.equal(buildRecipe.args[2], '--exe');

    const testRecipe = recipes.find(r => r.id === 'npm-test');
    assert.ok(testRecipe, 'npm-test recipe created');
    assert.deepEqual(testRecipe.args.slice(-2), ['run', 'test']);
    assert.equal(testRecipe.args[testRecipe.args.length - 3], externalNpmCli);
    assert.equal(testRecipe.args[testRecipe.args.length - 4], '--');

    // Check safe environment filtering:
    assert.equal(buildRecipe.env.SystemRoot, 'C:\\Windows');
    assert.equal(buildRecipe.env.SECRET_TOKEN, undefined);
    assert.equal(buildRecipe.env.GITHUB_KEY, undefined);
  }

  // Case 7: Security: jobHelper inside workspace is rejected
  const internalHelper = path.join(root, fakeHelperName);
  writeFileSync(internalHelper, 'fake');
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    jobHelperExecutable: internalHelper,
    npmCliPath: externalNpmCli,
    allowProjectScripts: true,
  }), /outside the writable workspace/i);

  // Case 8: Security: npmCli inside workspace is rejected
  const internalNpmCli = path.join(root, 'npm-cli.js');
  writeFileSync(internalNpmCli, 'fake');
  assert.throws(() => buildWorkspaceCommandRecipes({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    jobHelperExecutable: externalHelper,
    npmCliPath: internalNpmCli,
    allowProjectScripts: true,
  }), /outside the writable workspace/i);

  // Case 9: Security: package.json as a symbolic link pointing outside workspace is rejected
  const symlinkRoot = createTempDir('pa-cmd-symlink-root-');
  t.after(() => rmSync(symlinkRoot, {recursive: true, force: true}));
  const externalPkg = path.join(externalDir, 'secret-package.json');
  writeFileSync(externalPkg, JSON.stringify({name: 'secret', scripts: {build: 'echo secret'}}));
  let fileSymlinkCreated = true;
  try {
    symlinkSync(externalPkg, path.join(symlinkRoot, 'package.json'), 'file');
  } catch {
    fileSymlinkCreated = false;
  }
  if (fileSymlinkCreated) {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: symlinkRoot,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      npmCliPath: externalNpmCli,
      allowProjectScripts: true,
    });
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.includes('package.json must not be a symbolic link')));
  }

  // Case 10: Security: node_modules as a symbolic link/junction pointing outside workspace is rejected
  const junctionRoot = createTempDir('pa-cmd-junction-root-');
  t.after(() => rmSync(junctionRoot, {recursive: true, force: true}));
  writeFileSync(path.join(junctionRoot, 'package.json'), JSON.stringify({name: 'app', scripts: {build: 'echo 1'}}));
  const externalModules = path.join(externalDir, 'external_node_modules');
  mkdirSync(externalModules);
  let junctionCreated = true;
  try {
    symlinkSync(externalModules, path.join(junctionRoot, 'node_modules'), 'junction');
  } catch {
    junctionCreated = false;
  }
  if (junctionCreated) {
    const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
      workspaceRoot: junctionRoot,
      nodeExecutable: process.execPath,
      jobHelperExecutable: externalHelper,
      npmCliPath: externalNpmCli,
      allowProjectScripts: true,
    });
    assert.equal(diagnostics.projectScriptsExposed, false);
    assert.ok(diagnostics.reasons.some(r => r.includes('dependencies_missing')));
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
