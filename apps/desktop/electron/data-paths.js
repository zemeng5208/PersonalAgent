import path from 'node:path';

/** Pure host-side path selection. Never migrates, reads, or removes user data. */
export function desktopDataPaths({electronDir, userData, packaged = false, fakeRuntime = false,
  fakeModel = false, ephemeral = false, testUserData = false}) {
  const isolated = packaged || ephemeral || testUserData;
  return {
    runtime: fakeRuntime
      ? (packaged || testUserData || ephemeral
          ? path.join(userData, 'fake-runtime-application.sqlite')
          : path.resolve(electronDir, '../.cache/fake-runtime-application.sqlite'))
      : (isolated ? path.join(userData, 'runtime.sqlite') : path.resolve(electronDir, '../.cache/runtime.sqlite')),
    conversations: fakeRuntime || fakeModel || ephemeral ? null
      : (packaged || testUserData
          ? path.join(userData, 'conversations.json')
          : path.resolve(electronDir, '../.cache/conversations.json')),
  };
}
