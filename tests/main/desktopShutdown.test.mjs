import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {registerDesktopShutdown} from '../../src/main/desktopShutdown.ts';
const app=new EventEmitter();let release;const gate=new Promise(resolve=>{release=resolve});let settled=0,exited=0,prevented=0;
registerDesktopShutdown(app,{settle:async()=>{settled++;await gate},exit:()=>{exited++},onFailure:error=>{throw error}});
const event={preventDefault(){prevented++}};app.emit('before-quit',event);app.emit('before-quit',event);await new Promise(resolve=>setImmediate(resolve));
assert.equal(exited,0);assert.equal(settled,1);assert.equal(prevented,2);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(exited,1);
const retry=new EventEmitter();let attempts=0,error,completed=0;
registerDesktopShutdown(retry,{settle:async()=>{if(++attempts===1)throw new Error('disk failure')},exit:()=>{completed++},onFailure:value=>{error=value}});
retry.emit('before-quit',event);await new Promise(resolve=>setImmediate(resolve));assert.match(error.message,/disk failure/);assert.equal(completed,0);
retry.emit('before-quit',event);await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,1);
const delayed=new EventEmitter();let unblock,reporting=0,delayedAttempts=0;
const reportingGate=new Promise(resolve=>{unblock=resolve});
registerDesktopShutdown(delayed,{settle:async()=>{delayedAttempts++;throw new Error('save failure')},exit:()=>assert.fail('failed quit cannot exit'),onFailure:async()=>{reporting++;await reportingGate}});
delayed.emit('before-quit',event);await new Promise(resolve=>setImmediate(resolve));delayed.emit('before-quit',event);
assert.equal(reporting,1);assert.equal(delayedAttempts,1,'quit stays coalesced while the failure UI is open');unblock();await new Promise(resolve=>setImmediate(resolve));
const brokenReporter=new EventEmitter(),originalError=console.error;let reported;
try{
 console.error=(message,error)=>{reported={message,error}};
 registerDesktopShutdown(brokenReporter,{settle:async()=>{throw new Error('save failure')},exit:()=>assert.fail('failed quit cannot exit'),onFailure:()=>{throw new Error('dialog failure')}});
 brokenReporter.emit('before-quit',event);await new Promise(resolve=>setImmediate(resolve));
 assert.ok(reported.error instanceof AggregateError);assert.deepEqual(reported.error.errors.map(error=>error.message),['save failure','dialog failure']);
}finally{console.error=originalError;}
console.log('Desktop quit awaits persistence, coalesces requests and retains a retry path after visible failure');
