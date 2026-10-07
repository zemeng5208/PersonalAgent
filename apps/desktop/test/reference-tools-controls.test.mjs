import test from 'node:test';
import assert from 'node:assert/strict';
import {mountReferenceToolsControls} from '../src/app/reference-tools-controls.js';

function harness(t,invoke) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const fields=Object.fromEntries(['state','result','path','mcp','skill','run'].map(name=>[name,
    {textContent:'',value:name==='path'?'reference.md':'',disabled:false,dataset:{reference:name}}]));
  const listeners=new Map();
  const host={isConnected:true,hidden:false,
    addEventListener:(event,handler)=>listeners.set(event,handler),
    querySelector(selector){
      const action=/\[data-reference="([^"]+)"\]/u.exec(selector)?.[1];
      return fields[action??/\[data-reference-([^\]]+)\]/u.exec(selector)?.[1]];
    }};
  globalThis.document={createElement:()=>host};
  const controls=mountReferenceToolsControls({append(){}},invoke);
  const render=state=>controls.render({mcp:{connected:state==='ready',state:state==='ready'?'connected':'unavailable'},
    skill:{health:{enabled:state==='ready',state}}});
  return {controls,fields,host,render,click:action=>listeners.get('click')({target:{closest:()=>fields[action]}})};
}

test('reference run stays pending across snapshots and a late receipt respects stopped service',async t=>{
  const calls=[];let resolve;
  const ui=harness(t,(action,input)=>{calls.push({action,input});return new Promise(done=>{resolve=done;});});
  ui.render('ready');const pending=ui.click('run');
  ui.render('ready');assert.equal(ui.fields.run.disabled,true);
  await ui.click('run');assert.equal(calls.length,1,'a refreshed pending action cannot submit another task');
  ui.render('disabled');resolve({taskId:'accepted-original'});await pending;
  assert.equal(ui.fields.run.disabled,true);
  await ui.click('run');assert.equal(calls.length,1,'an unavailable Skill cannot submit a task');
  ui.render('ready');assert.equal(ui.fields.run.disabled,false);
  const fresh=ui.click('run');assert.equal(calls.length,2);
  resolve({taskId:'fresh-task'});await fresh;
  assert.equal(ui.fields.run.disabled,false);assert.match(ui.fields.result.textContent,/fresh-task/);
  assert.deepEqual(calls.map(call=>call.input),[{path:'reference.md'},{path:'reference.md'}]);
});

test('reference failures unlock available actions and detached late responses leave controls inactive',async t=>{
  const calls=[];let resolve,reject;
  const ui=harness(t,action=>{calls.push(action);return new Promise((done,fail)=>{resolve=done;reject=fail;});});
  ui.render('ready');const pending=ui.click('run');ui.render('ready');reject(Error('synthetic-only'));await pending;
  assert.equal(ui.fields.run.disabled,false);assert.match(ui.fields.result.textContent,/操作未完成/);
  const next=ui.click('run');ui.host.isConnected=false;resolve({taskId:'late-detached'});await next;
  assert.equal(ui.fields.run.disabled,true);assert.equal(ui.fields.result.textContent,'');
  await ui.click('run');assert.equal(calls.length,2);
});
