import {Client,EventCursor} from '@personal-agent/client';
import {FakeRuntime,FakeToolHost} from '@personal-agent/testkit';
import {register} from '../../packages/testkit/examples/connector-provider.mjs';
const runtime=new FakeRuntime({mode:'test',scenario:'cancel'});
const client=new Client(runtime,runtime.clock.now);
await client.connect();
const task=await client.call('task.submit',{goal:'测试取消',conversationId:'demo'},{idempotencyKey:'demo-submit'});
runtime.advance(task.taskId);
console.log({verification:'mock',cancel:await client.call('task.cancel',{taskId:task.taskId})});
runtime.advance(task.taskId);
const cursor=new EventCursor('tasks');
console.log({verification:'mock',states:cursor.accept(runtime.readEvents('tasks')).filter(e=>e.type==='task.state_changed').map(e=>e.payload.state)});
const host=new FakeToolHost(runtime.clock.now);
const dispose=register(host);
try {
  const result=await host.invoke('fixture.search',{query:'plan'},{
    taskId:task.taskId,runId:'fixture-run',authorizationRef:'fixture-auth',
    signal:new AbortController().signal,deadline:new Date(runtime.clock.now()+1000).toISOString(),scopes:['fixture:read'],
  });
  console.log({verification:'mock',connectorResults:result});
} finally {dispose();}
