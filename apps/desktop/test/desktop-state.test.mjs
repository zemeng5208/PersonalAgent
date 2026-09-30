import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DesktopState, fitBounds, snapBounds} from '../electron/desktop-state.js';

test('desktop settings and negative-origin window positions survive restart; corrupt input falls back', () => {
  const root = fileURLToPath(new URL('../.cache/', import.meta.url));mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'desktop-state-'));const file=path.join(directory,'settings.json');
  try {
    const store=new DesktopState(file);store.update({language:'en',fontScale:1.2,hover:false});
    store.remember('orb',{x:-1500,y:100,width:112,height:112});
    const restored=new DesktopState(file);
    assert.equal(restored.value.settings.language,'en');assert.equal(restored.value.settings.hover,false);
    assert.equal(restored.value.windows.orb.x,-1500);
    writeFileSync(file,'broken');assert.equal(new DesktopState(file).value.settings.hover,true);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('removed screens, DPI work areas and edge snapping keep windows reachable',()=>{
  const area={x:-1280,y:-100,width:1280,height:720};
  assert.deepEqual(fitBounds({x:2000,y:1800,width:1600,height:1000},area),{x:-1280,y:-100,width:1280,height:720});
  assert.deepEqual(snapBounds({x:-1270,y:-90,width:112,height:112},area),{x:-1280,y:-100,width:112,height:112});
  assert.equal(snapBounds({x:-800,y:100,width:112,height:112},area).x,-800);
});

test('trusted host namespace persists across restart without losing legacy desktop settings', () => {
  const root=fileURLToPath(new URL('../.cache/', import.meta.url));mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'desktop-identity-'));const file=path.join(directory,'state.json');
  try {
    writeFileSync(file,JSON.stringify({settings:{hover:false},windows:{orb:{x:-200,y:50,width:112,height:112}}}));
    const first=new DesktopState(file);
    const namespace=first.ensureHostUserNamespace();
    assert.match(namespace,/^desktop-user-v1:[0-9a-f-]{36}$/);
    assert.equal(first.ensureHostUserNamespace(),namespace);
    const restarted=new DesktopState(file);
    assert.equal(restarted.ensureHostUserNamespace(),namespace);
    assert.equal(restarted.value.settings.hover,false);
    assert.equal(restarted.value.windows.orb.x,-200);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).hostUserNamespace,namespace);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('damaged or invalid identity settings refuse a new namespace without replacing the file', () => {
  const root=fileURLToPath(new URL('../.cache/', import.meta.url));mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(path.join(root,'desktop-identity-invalid-'));
  try {
    for(const [name,content] of [['broken','{broken'],['invalid',JSON.stringify({settings:{hover:false},hostUserNamespace:'unexpected'})]]) {
      const file=path.join(directory,name+'.json');writeFileSync(file,content);
      const store=new DesktopState(file);
      assert.throws(()=>store.ensureHostUserNamespace(),/recovery/);
      assert.throws(()=>store.update({hover:false}),/recovery/);
      assert.equal(readFileSync(file,'utf8'),content);
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});
