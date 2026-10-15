const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {CastServer} = require('../src/cast-server');
const {DEFAULTS} = require('../src/config');

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fake(config, task = deferred()){
  const rtmp=new EventEmitter();
  Object.assign(rtmp,{task,closed:false,begins:0,prepare:()=>task.promise,
    getInfo:()=>({enabled:true,phase:rtmp.closed?'stopped':'waiting',localUrl:`rtmp://${config.host}:${config.rtmpPort}/live/session`,
      forwardedUrl:`rtmp://${rtmp.wan||config.advertisedHost}:${config.advertisedRtmpPort}/live/session`}),
    updateAdvertisedHost:address=>{rtmp.wan=address;},
    begin:async()=>{rtmp.begins++;return{generation:'owned'};},
    stop:async()=>{rtmp.closed=true;task.reject(new Error('cancelled'));}});
  return rtmp;
}

test('optional RTMP preparation cannot delay or fail the real web listener',async t=>{
  let rtmp;
  const server=new CastServer({...DEFAULTS,host:'127.0.0.1',port:0},{createRtmp:config=>(rtmp=fake(config))});
  t.after(()=>server.stop());
  const info=await server.start();
  assert.match(info.localInviteUrl,/http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(info.localUrl+'api/status')).status,200);
  rtmp.task.reject(new Error('RTMP port is occupied'));
  await assert.rejects(server.beginRtmp({mimeType:'video/webm;codecs=vp8,opus'}),/occupied/);
  assert.equal((await fetch(info.localUrl+'api/status')).status,200);
});

test('stopping while RTMP preparation is pending rejects late begin and releases web listener',async t=>{
  let rtmp;
  const server=new CastServer({...DEFAULTS,host:'127.0.0.1',port:0},{createRtmp:config=>(rtmp=fake(config))});
  t.after(()=>server.stop()); const info=await server.start();
  const begin=server.beginRtmp({mimeType:'video/webm;codecs=vp8,opus'});
  // Observe the rejection before stop cancels the pending dependency.
  const rejected=assert.rejects(begin,/cancelled/);
  await server.stop();await rejected;
  assert.equal(rtmp.begins,0); assert.equal(rtmp.closed,true);
  await assert.rejects(fetch(info.localUrl));
});

test('same-room WAN refresh updates both protocols while preserving invitation identities',async t=>{
  let rtmp;
  const server=new CastServer({...DEFAULTS,host:'127.0.0.1',port:0,forwardingEnabled:true,advertisedHost:'10.2.3.4',
    advertisedPort:18765,advertisedRtmpPort:11935},{createRtmp:config=>(rtmp=fake(config))});
  t.after(()=>server.stop());const first=await server.start();rtmp.task.resolve();
  const next=server.updateAdvertisedHost('10.2.3.5');
  assert.equal(next.roomId,first.roomId);assert.equal(next.token,first.token);
  assert.equal(next.rtmp.forwardedUrl,'rtmp://10.2.3.5:11935/live/session');
  assert.equal(next.rtmp.localUrl,first.rtmp.localUrl);assert.match(next.forwardedInviteUrl,/10\.2\.3\.5:18765/);
});
