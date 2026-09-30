import path from 'node:path';

/** Pure host-side path selection. Never migrates, reads, or removes user data. */
export function desktopDataPaths({electronDir, userData, packaged = false, fakeRuntime = false,
  fakeModel = false, ephemeral = false, testUserData = false, userDataOverride = false}) {
  const isolated = packaged || ephemeral || testUserData || userDataOverride;
  return {
    runtime: fakeRuntime
      ? (isolated
          ? path.join(userData, 'fake-runtime-application.sqlite')
          : path.resolve(electronDir, '../.cache/fake-runtime-application.sqlite'))
      : (isolated ? path.join(userData, 'runtime.sqlite') : path.resolve(electronDir, '../.cache/runtime.sqlite')),
    privateMemory: isolated ? path.join(userData, 'private-memory.sqlite')
      : path.resolve(electronDir, '../.cache/private-memory.sqlite'),
    conversations: fakeRuntime || fakeModel || ephemeral ? null
      : (packaged || testUserData || userDataOverride
          ? path.join(userData, 'conversations.json')
          : path.resolve(electronDir, '../.cache/conversations.json')),
  };
}
