import {execFile} from 'node:child_process';
import {existsSync, renameSync, statSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(__dirname, '../host/WindowsSystemSpeechHost.cs');
const OUTPUT_PATH = path.resolve(__dirname, '../host/windows-system-speech-host.exe');
const TEMP_OUTPUT_PATH = path.resolve(__dirname, '../host/windows-system-speech-host.tmp.exe');

function isStale() {
  if (!existsSync(OUTPUT_PATH) || !existsSync(SOURCE_PATH)) return true;
  try {
    const outStat = statSync(OUTPUT_PATH);
    if (!outStat.isFile() || outStat.size === 0) return true;
    const srcStat = statSync(SOURCE_PATH);
    return srcStat.mtimeMs > outStat.mtimeMs;
  } catch {
    return true;
  }
}

function cleanupStaleExe() {
  try {
    if (existsSync(OUTPUT_PATH) && isStale()) {
      unlinkSync(OUTPUT_PATH);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function findSystemRoot() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root || typeof root !== 'string' || !path.win32.isAbsolute(root) || root.includes('\0')) {
    return null;
  }
  return path.win32.resolve(root);
}

function resolveControlledPaths(systemRoot) {
  const compilerCandidates = [
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const assemblyCandidates = [
    path.win32.join(systemRoot, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'System.Speech', 'v4.0_4.0.0.0__31bf3856ad364e35', 'System.Speech.dll'),
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', 'System.Speech.dll'),
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'WPF', 'System.Speech.dll'),
  ];

  const compilerPath = compilerCandidates.find(candidate => existsSync(candidate)) || null;
  const assemblyPath = assemblyCandidates.find(candidate => existsSync(candidate)) || null;

  return {compilerPath, assemblyPath};
}

export async function buildWindowsSpeechHost(options = {}) {
  const {force = false} = options;

  if (process.platform !== 'win32') {
    console.log(`[voice] Skipping Windows System.Speech host compilation on non-Windows platform (${process.platform}).`);
    return {status: 'skipped', reason: 'non-windows'};
  }

  if (!existsSync(SOURCE_PATH)) {
    cleanupStaleExe();
    throw new Error(`[voice] Host source file not found at ${SOURCE_PATH}`);
  }

  if (!force && !isStale()) {
    console.log('[voice] Windows System.Speech host binary is up-to-date.');
    return {status: 'up-to-date', path: OUTPUT_PATH};
  }

  const systemRoot = findSystemRoot();
  if (!systemRoot) {
    cleanupStaleExe();
    throw new Error('[voice] Invalid or missing Windows SystemRoot environment variable.');
  }

  const {compilerPath, assemblyPath} = resolveControlledPaths(systemRoot);
  if (!compilerPath) {
    cleanupStaleExe();
    throw new Error('[voice] Windows .NET Framework C# compiler (csc.exe) not found at controlled system locations.');
  }
  if (!assemblyPath) {
    cleanupStaleExe();
    throw new Error('[voice] Windows System.Speech assembly not found at controlled system locations.');
  }

  try {
    if (existsSync(TEMP_OUTPUT_PATH)) {
      unlinkSync(TEMP_OUTPUT_PATH);
    }
  } catch {
    // Best-effort cleanup.
  }

  const args = [
    '/nologo',
    '/target:exe',
    `/r:${assemblyPath}`,
    `/out:${TEMP_OUTPUT_PATH}`,
    SOURCE_PATH,
  ];

  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  };
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;

  try {
    await execFileAsync(compilerPath, args, {
      shell: false,
      windowsHide: true,
      env,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    try {
      if (existsSync(TEMP_OUTPUT_PATH)) unlinkSync(TEMP_OUTPUT_PATH);
    } catch {}
    cleanupStaleExe();
    const details = (error.stderr || error.stdout || error.message || '').toString().slice(0, 4096).trim();
    throw new Error(`[voice] Windows System.Speech host compilation failed (exit code ${error.code ?? 'unknown'}): ${details}`);
  }

  try {
    if (!existsSync(TEMP_OUTPUT_PATH) || statSync(TEMP_OUTPUT_PATH).size === 0) {
      cleanupStaleExe();
      throw new Error('[voice] Compiler succeeded but produced an empty or missing executable.');
    }
    if (existsSync(OUTPUT_PATH)) {
      unlinkSync(OUTPUT_PATH);
    }
    renameSync(TEMP_OUTPUT_PATH, OUTPUT_PATH);
  } catch (error) {
    try {
      if (existsSync(TEMP_OUTPUT_PATH)) unlinkSync(TEMP_OUTPUT_PATH);
    } catch {}
    cleanupStaleExe();
    throw error;
  }

  console.log(`[voice] Successfully built Windows System.Speech host: ${OUTPUT_PATH}`);
  return {status: 'built', path: OUTPUT_PATH};
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes('--force');
  buildWindowsSpeechHost({force}).catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}
