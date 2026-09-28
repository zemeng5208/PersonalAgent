import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export function createLiveVoiceConfig({userData, safeStorage}) {
  const target = path.join(userData, 'live-voice-config.json');
  let saved;
  let failure = '';
  const valid = value => value && /^[A-Za-z0-9-]{1,128}$/.test(value.workspaceId)
    && typeof value.apiKey === 'string' && value.apiKey.length > 0 && value.apiKey.length <= 4096
    && !/\s/.test(value.apiKey) && /^F([1-9]|1[0-9]|2[0-4])$/.test(value.hotkey)
    && value.audioConsent === true;
  if (existsSync(target)) {
    try {
      const data = JSON.parse(readFileSync(target, 'utf8'));
      if (data.version !== 1 || !safeStorage.isEncryptionAvailable() || typeof data.key !== 'string') throw Error();
      const value = {...data, apiKey: safeStorage.decryptString(Buffer.from(data.key, 'base64'))};
      if (!valid(value)) throw Error();
      saved = value;
    } catch {failure = 'Live 加密配置无法读取，请重新保存';}
  }
  const snapshot = () => ({configured: Boolean(saved), provider: 'qwen',
    model: 'qwen3.8-omni-flash-realtime', region: 'cn-beijing', hotkey: saved?.hotkey ?? 'F8',
    workspaceId: saved?.workspaceId ?? '', reason: failure || (saved ? 'Live 已配置，尚需连接与真实语音验收' : '请配置百炼北京业务空间和 API Key')});
  return {
    snapshot,
    current: () => saved ? {workspaceId: saved.workspaceId, apiKey: saved.apiKey} : undefined,
    configure(input) {
      if (!input || Object.keys(input).some(key => !['workspaceId', 'apiKey', 'hotkey', 'audioConsent'].includes(key))) throw Error('Live 配置格式无效');
      const value = {...input, apiKey: input.apiKey || saved?.apiKey};
      if (!valid(value)) throw Error('请填写北京业务空间、API Key、F1 至 F24 快捷键并确认音频用途');
      if (!safeStorage.isEncryptionAvailable()) throw Error('本机安全存储不可用，未保存密钥');
      const key = safeStorage.encryptString(value.apiKey).toString('base64');
      mkdirSync(userData, {recursive: true});
      const temp = `${target}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify({version: 1, workspaceId: value.workspaceId, key,
        hotkey: value.hotkey, audioConsent: true}), 'utf8');
      renameSync(temp, target);
      saved = value; failure = '';
      return snapshot();
    },
  };
}
