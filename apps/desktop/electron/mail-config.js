import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const valid = value => value && typeof value.user === 'string'
  && /^[A-Za-z0-9._+-]+@qq\.com$/i.test(value.user) && value.user.length <= 254
  && typeof value.authCode === 'string' && /^[A-Za-z0-9]{8,128}$/.test(value.authCode);
const mask = user => user ? `${user.slice(0, 1)}***@qq.com` : '';

/** Main-process only. Persist credentials, never persist the local read consent. */
export function createMailConfig({userData, safeStorage, onRevoke = async () => {}}) {
  const target = path.join(userData, 'mail-config.json');
  let saved, sessionAllowed = false, boundRevision, failure = '';
  if (existsSync(target)) {
    try {
      const data = JSON.parse(readFileSync(target, 'utf8'));
      if (data.version !== 1 || typeof data.encrypted !== 'string' || !safeStorage.isEncryptionAvailable()) throw Error();
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(data.encrypted, 'base64')));
      if (!valid(value) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw Error();
      saved = value;
    } catch {failure = '邮箱加密配置无法读取，请重新保存';}
  }
  const snapshot = () => ({account: mask(saved?.user), configured: Boolean(saved), sessionAllowed,
    requiresRestart: Boolean(saved && boundRevision !== saved.revision), headersOnly: true,
    status: failure ? 'unavailable' : sessionAllowed ? 'enabled' : saved ? 'disabled' : 'unconfigured',
    reason: failure || (sessionAllowed ? '允许本会话整批收件箱信头本地分类；不会发送或修改邮件'
      : '读取许可不会跨应用重启恢复')});
  const revoke = async () => {
    sessionAllowed = false;
    await onRevoke();
    return snapshot();
  };
  return Object.freeze({
    snapshot,
    current: () => saved ? {...saved} : undefined,
    isSessionAllowed: revision => sessionAllowed && saved?.revision === revision && boundRevision === revision,
    markBound(revision) {
      if (!saved || revision !== saved.revision) throw Error('邮箱装配版本不匹配');
      boundRevision = revision;
    },
    async configure(input) {
      if (!input || Object.keys(input).some(key => !['user', 'authCode', 'readConsent'].includes(key))
        || input.readConsent !== true) throw Error('请明确允许本会话读取收件箱信头并在本地分类');
      const user = typeof input.user === 'string' ? input.user.trim().toLowerCase() : '';
      const value = {user, authCode: input.authCode || (user === saved?.user ? saved.authCode : ''),
        revision: (saved?.revision ?? 0) + 1};
      if (!valid(value)) throw Error('请填写 QQ 邮箱地址和 IMAP 授权码');
      if (!safeStorage.isEncryptionAvailable()) throw Error('本机安全存储不可用，未保存邮箱配置');
      const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
      await revoke();
      try {
        mkdirSync(userData, {recursive: true});
        const temporary = `${target}.tmp-${process.pid}`;
        writeFileSync(temporary, JSON.stringify({version: 1, encrypted}), 'utf8');
        renameSync(temporary, target);
      } catch {throw Error('邮箱加密配置保存失败');}
      saved = value; failure = ''; sessionAllowed = true;
      return snapshot();
    },
    enableSession(input) {
      if (!saved || !input || Object.keys(input).some(key => key !== 'readConsent') || input.readConsent !== true) {
        throw Error('请确认本会话收件箱信头读取和本地分类用途');
      }
      sessionAllowed = true;
      return snapshot();
    },
    revoke,
  });
}
