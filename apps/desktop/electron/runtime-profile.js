export function resolveRuntimeProfile({profile,fakeRuntime=false,fakeModel=false}={}) {
  const selected=profile===undefined ? fakeRuntime || fakeModel ? 'local' : 'huawei_ict_agentarts' : profile;
  if (!['local','huawei_ict_agentarts'].includes(selected)) throw Error('PA_RUNTIME_PROFILE 只允许 local 或 huawei_ict_agentarts');
  if (selected==='huawei_ict_agentarts' && (fakeRuntime || fakeModel)) throw Error('Competition Profile 不能与 Fake 同时启用');
  return selected;
}
