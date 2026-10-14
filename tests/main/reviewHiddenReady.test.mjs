import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import electron from 'electron';
import {renderLineReviewHtml} from '../../src/shared/core/html.ts';

const directory=await mkdtemp(path.join(os.tmpdir(),'yn-hidden-review-'));
let passed=false;
try {
  const html=path.join(directory,'review.html');
  await writeFile(html,process.env.YN_HIDDEN_READY_INPUT?await readFile(process.env.YN_HIDDEN_READY_INPUT,'utf8'):renderLineReviewHtml({
    title:'Hidden review initialization',sourceText:'First source.\nSecond source.',lineReviewPath:html
  }));
  await writeFile(path.join(directory,'preload.cjs'),`const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('workshopHtml',{readLineReviewState:async()=>({state:{documentRevision:7,edits:{1:'Restored translation.'},status:{1:'manual'}}})});`);
  const entry=path.join(directory,'main.mjs');
  await writeFile(entry,`import {app,BrowserWindow,BrowserView} from 'electron';import {writeFile} from 'node:fs/promises';
    app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
    void app.whenReady().then(async()=>{let window,view;const result={};try{
      window=new BrowserWindow({show:false});
      view=new BrowserView({webPreferences:{preload:${JSON.stringify(path.join(directory,'preload.cjs'))},contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:false}});
      window.addBrowserView(view);view.setBounds({x:0,y:0,width:0,height:0});
      const start=performance.now();await view.webContents.loadFile(${JSON.stringify(html)});
      const ready=view.webContents.executeJavaScript('(async()=>{await window.translationWorkshopLineReviewReady;return {inert:document.body.inert,editable:document.querySelector(".target").contentEditable,text:document.querySelector(".target").textContent}})()');
      const state=await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Hidden review readiness is blocked on a compositor frame')),2000))]);
      if(state.inert||state.editable!=='true'||state.text!=='Restored translation.')throw Error('Canonical translation is not restored and editable: '+JSON.stringify(state));
      result.pass=true;result.readyMs=performance.now()-start;result.state=state;result.visible=window.isVisible();
    }catch(error){result.pass=false;result.error=error.stack;}finally{await writeFile(${JSON.stringify(path.join(directory,'result.json'))},JSON.stringify(result));if(view){window.removeBrowserView(view);view.webContents.close();}window?.close();app.quit();}});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const code=await new Promise((resolve,reject)=>{const child=spawn(electron,['--no-sandbox',entry],{windowsHide:true,env,stdio:'ignore'});child.once('error',reject);child.once('exit',resolve);});
  const result=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
  assert.equal(code,0);assert.equal(result.pass,true,result.error);assert.equal(result.visible,false);
  console.log('PASS hidden non-offscreen canonical restoration without activation or paint frame: '+JSON.stringify(result));passed=true;
} finally {if(passed)await rm(directory,{recursive:true,force:true});else console.error('Hidden review diagnostics retained: '+directory);}
