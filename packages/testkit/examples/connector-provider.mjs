import {FakeConnector} from '../dist/index.js';
export function register(host) {
  const connector = new FakeConnector([{
    source:'fixture',accountRef:'fake-account',externalId:'note-1',
    occurredAt:'2026-09-05T12:00:00Z',fetchedAt:'2026-09-05T12:00:00Z',
    contentRef:'fixture://project-plan',sensitivity:'test',dedupeKey:'fixture:note-1',
  }]);
  connector.connect();
  const unregister = host.register({
    descriptor:{name:'fixture.search',version:'0.1.0',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},
      outputSchema:{type:'array',items:{type:'object'}},sideEffect:'read',requiredScopes:['fixture:read'],
      idempotencySupport:true,recoverySupport:true,requiresPresence:false},
    execute:async(input)=>connector.search('fake-account',input.query),
  });
  return () => {unregister();connector.disconnect();};
}
