import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createRuntimeApplication,createCalendarEventReadTool} from '@personal-agent/runtime/application';
import {Client} from '@personal-agent/client';
import {createDesktopCalendarMeetingHost,calendarConfigurationId,calendarApprovalResponse} from '../electron/calendar-meeting-host.js';

test('controlled calendar read makes zero requests before approval and persists a confirmed Runtime receipt', async t => {
  const cache=new URL('../../../.cache/calendar-read-approval/',import.meta.url);mkdirSync(cache,{recursive:true});
  const file=path.join(mkdtempSync(new URL('run-',cache)),'runtime.sqlite');
  const binding={providerKind:'caldav',accountRef:'fixture-account',secretRef:'fixture-ref',revision:1,
    calendarUrl:'https://example.test/calendar/',calendarName:'Test calendar'};
  let configured=false;
  const config={binding:()=>configured ? structuredClone(binding) : undefined,snapshot:()=>({configured})};
  const configurationId=calendarConfigurationId(binding);
  let calls=0;
  const tool=createCalendarEventReadTool({getBinding:()=>({configurationId,accountRef:binding.accountRef,
    calendarUrl:binding.calendarUrl}),readAuthorization:()=> 'Basic fixture',fetchImpl:async()=>{
      calls++;
      return {ok:true,status:207,text:async()=>'<multistatus><response><href>/calendar/one.ics</href><propstat><prop><calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T080000Z\r\nDTEND:20261001T090000Z\r\nSUMMARY:Meeting\r\nSEQUENCE:1\r\nEND:VEVENT\r\nEND:VCALENDAR</calendar-data></prop></propstat></response></multistatus>'};
    }});
  const host=createDesktopCalendarMeetingHost({config,namespace:'calendar-fixture',readTool:tool,
    readArguments:(_binding,externalId)=>({configurationId,externalId})});
  const app=createRuntimeApplication({path:file,profile:'huawei_ict_agentarts',hostUserNamespace:'calendar-fixture',tools:host.tools});
  app.runtime.provisionCoordinationStore('calendar-fixture');host.bindApplication(app);
  t.after(()=>{host.close();app.close();});
  assert.equal(host.snapshot().readAvailable,false);
  assert.equal(host.tools.length,1);
  const calendarReadPort=host.calendarReadPort;
  assert.throws(()=>calendarReadPort.readBaseline({}),{code:'UNAUTHORIZED'});
  configured=true;
  assert.equal(host.snapshot().readAvailable,true);
  assert.equal(host.calendarReadPort,calendarReadPort);
  const task=host.read({externalId:'uid'});
  async function until(predicate) {for(let round=0;round<100;round++) {if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Calendar task did not reach expected state');}
  await until(()=>app.readHostToolTask(task.taskId).approval?.state==='pending');
  assert.equal(calls,0);
  const approval=app.readHostToolTask(task.taskId).approval;
  const client=new Client(app,Date.now);await client.connect();
  await client.call('authorization.respond',calendarApprovalResponse({approvalId:approval.approvalId,
    revision:approval.revision,decision:'allow_once'}));
  await until(()=>app.runtime.getTask(task.taskId).state==='succeeded');
  assert.equal(calls,1);
  assert.equal(host.readTask(task.taskId).item.externalId,'uid');
  const records=app.runtime.readToolExecutions(task.taskId);
  assert.equal(records.length,1);assert.equal(records[0].state,'confirmed');
  assert.equal(records[0].policyDecision,'allow');assert.equal(records[0].executionStarted,true);
  assert.equal(app.readHostToolTask(task.taskId).confirmed.runId,`host-tool-${task.taskId}`);
});
