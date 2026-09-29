import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStorage} from '@personal-agent/storage';
import {TaskRuntime, RUNTIME_MIGRATIONS} from '../dist/index.js';

const start='2026-09-27T10:00:00.000Z';
const schedule=(id, overrides={})=>({scheduleId:id,goal:'Reminder '+id,conversationId:'todo-owner',
  runAt:'2026-09-27T10:01:00.000Z',timeZone:'Asia/Shanghai',missedRunPolicy:'run_once',
  taskIdempotencyKey:'reminder-task:'+id,...overrides});
async function database(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'pa-schedule-sync-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));return path.join(directory,'runtime.sqlite');
}

test('authorized source reconciliation replaces pending reminders, cancels old ones and never replays dispatched tasks',async t=>{
  const file=await database(t);let now=new Date(start),runtime=new TaskRuntime(file,{now:()=>now});
  try {
    runtime.reconcileSchedules('todo-owner',[schedule('old-time'),schedule('rename')]);
    runtime.reconcileSchedules('todo-owner',[schedule('new-time'),schedule('rename',{goal:'Updated title'})]);
    assert.equal(runtime.getSchedule('old-time').status,'cancelled');
    assert.equal(runtime.getSchedule('rename').goal,'Updated title');
    runtime.close();runtime=new TaskRuntime(file,{now:()=>now});
    now=new Date('2026-09-27T10:02:00.000Z');
    const fired=runtime.recoverMissedSchedules();
    assert.deepEqual(fired.map(item=>item.scheduleId),['new-time','rename']);
    assert.equal(fired.find(item=>item.scheduleId==='rename').task.goal,'Updated title');
    const taskId=runtime.getSchedule('rename').taskId;
    runtime.reconcileSchedules('todo-owner',[schedule('rename',{goal:'Must not replay'})]);
    assert.equal(runtime.getSchedule('rename').taskId,taskId);
    assert.equal(runtime.getSchedule('rename').goal,'Updated title');
    assert.deepEqual(runtime.dispatchDueSchedules(),[]);
    // Removing a not-yet-fired reminder retains its identity; explicit re-add can resume it.
    runtime.reconcileSchedules('todo-owner',[schedule('old-time')]);
    assert.equal(runtime.getSchedule('old-time').status,'pending');
    assert.equal(runtime.dispatchDueSchedules().length,1);
    runtime.reconcileSchedules('todo-owner',[]);
    assert.deepEqual(runtime.dispatchDueSchedules(),[]);
  } finally {runtime.close();}
});

test('conflicting source identities roll back the complete reminder set',async t=>{
  const runtime=new TaskRuntime(await database(t),{now:()=>new Date(start)});
  try {
    runtime.createSchedule(schedule('other',{conversationId:'other-owner'}));
    runtime.reconcileSchedules('todo-owner',[schedule('keep')]);
    assert.throws(()=>runtime.reconcileSchedules('todo-owner',[schedule('new'),schedule('other')]),{code:'REVISION_CONFLICT'});
    assert.equal(runtime.getSchedule('keep').status,'pending');
    assert.throws(()=>runtime.getSchedule('new'),{code:'NOT_FOUND'});
    assert.equal(runtime.getSchedule('other').conversationId,'other-owner');
    assert.throws(()=>runtime.reconcileSchedules('todo-owner',[schedule('keep',{taskIdempotencyKey:'substitution'})]),{code:'REVISION_CONFLICT'});
    assert.throws(()=>runtime.reconcileSchedules('todo-owner',[schedule('x'),schedule('x')]),{code:'INVALID_ARGUMENT'});
  } finally {runtime.close();}
});

test('migration 8 preserves old pending/fired/skipped rows, task links and migration checksums',async t=>{
  const file=await database(t), old=openStorage(file,RUNTIME_MIGRATIONS.slice(0,7));
  old.prepare('INSERT INTO tasks (task_id,goal,conversation_id,attachment_refs_json,state,revision,updated_at,steps_json,evidence_refs_json) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('existing-task','Existing reminder','todo-owner','[]','succeeded',1,start,'[]','[]');
  for(const status of ['pending','fired','skipped']) old.prepare('INSERT INTO task_schedules VALUES (?,?,?,?,?,?,?,?,?)')
    .run(status,'Preserve '+status,'todo-owner',start,'UTC','run_once','old-key:'+status,status,status==='fired'?'existing-task':null);
  const checksums=old.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();old.close();
  const runtime=new TaskRuntime(file,{now:()=>new Date(start)});
  assert.equal(runtime.getSchedule('fired').taskId,'existing-task');
  assert.equal(runtime.getTask('existing-task').goal,'Existing reminder');
  assert.deepEqual(runtime.listSchedules('todo-owner').map(item=>item.status).sort(),['fired','pending','skipped']);
  runtime.reconcileSchedules('todo-owner',[]);assert.equal(runtime.getSchedule('pending').status,'cancelled');runtime.close();
  const db=openStorage(file,RUNTIME_MIGRATIONS);
  assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=7 ORDER BY version').all(),checksums);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  assert.throws(()=>openStorage(file,RUNTIME_MIGRATIONS.slice(0,7)),/newer/);
});
