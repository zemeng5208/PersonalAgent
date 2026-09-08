import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
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
