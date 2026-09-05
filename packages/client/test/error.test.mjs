import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '../dist/index.js';
test('structured rate limit metadata survives client errors',async()=>{
  const client=new Client({send:async request=>({
    kind:'response',protocolVersion:'1.0.0',requestId:request.requestId,outcome:'error',
    error:{code:'RATE_LIMITED',message:'fixture limit',retryable:true,retryAfterMs:100},
    evidenceRefs:[],
  })});
  await assert.rejects(client.connect(),{code:'RATE_LIMITED',retryable:true,retryAfterMs:100});
});
