// Real captured dynamic video: validates startup, payload, cadence and resolution.
// Use LAN_CAST_EXECUTABLE for a package; all settings and viewers are isolated.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const packaged = !!process.env.LAN_CAST_EXECUTABLE;
const label = process.env.LAN_CAST_BITRATE_LABEL || `${packaged?'packaged':'source'}-${Date.now()}`;
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid probe label');
const incident = path.join(root, '.cache', `video-bitrate-${label}`);
const output = path.join(root, 'test-results', `video-bitrate-${label}`);
const codec = process.env.LAN_CAST_BITRATE_CODEC || 'HEVC';
if(!['HEVC','H264','VP8'].includes(codec))throw new Error('Invalid codec');
const motionFromStart = process.env.LAN_CAST_BITRATE_MOTION_FROM_START === '1';
const staticSamples = 5;
const motionSamples = Number(process.env.LAN_CAST_BITRATE_SAMPLES || 21);
if(!Number.isInteger(motionSamples)||motionSamples<6||motionSamples>181)throw new Error('Invalid sample count');
const fps = Number(process.env.LAN_CAST_BITRATE_FPS || 60);
const bitrateMbps = Number(process.env.LAN_CAST_BITRATE_MBPS || 15);
const minFps = Number(process.env.LAN_CAST_BITRATE_MIN_FPS ?? fps * 0.75);
// Judge actual dynamic video payload; targetBitrate also reflects pacing/overhead.
const startupPayloadRatio = 0.7;
const ceilingOnly = process.env.LAN_CAST_BITRATE_CEILING_ONLY === '1';
if(![30,60].includes(fps)||!Number.isInteger(bitrateMbps)||bitrateMbps<1||bitrateMbps>30
  ||!Number.isFinite(minFps)||minFps<0||minFps>fps)throw new Error('Invalid smoke budget');
const executable = process.env.LAN_CAST_EXECUTABLE || require('electron');
const realSettings = path.join(process.env.APPDATA, 'LAN Screen Cast/settings.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(read, accept, label) {
  const deadline = Date.now() + 25000;
  let result;
  while (Date.now() < deadline) {
    result = await read();
    if (accept(result)) return result;
    await delay(200);
  }
  throw new Error(`${label}: ${JSON.stringify(result)}`);
}
async function collect(page, side) {
  return page.evaluate(async side => {
    const snapshots = [];
    const wanted = ['id','type','kind','ssrc','timestamp','codecId','mimeType','sdpFmtpLine',
      'bytesSent','bytesReceived','packetsSent','packetsReceived','packetsLost','framesEncoded',
      'framesDecoded','frameWidth','frameHeight','framesPerSecond','targetBitrate','qpSum',
      'qualityLimitationReason','qualityLimitationDurations','qualityLimitationResolutionChanges',
      'totalEncodeTime','totalDecodeTime','framesDropped','freezeCount','nackCount','pliCount',
      'retransmittedBytesSent','encoderImplementation','decoderImplementation',
      'powerEfficientEncoder','powerEfficientDecoder','selectedCandidatePairId','state',
      'availableOutgoingBitrate','currentRoundTripTime','roundTripTime','jitter','frames',
      'keyFramesEncoded','totalEncodedBytesTarget','totalPacketSendDelay','packetsDiscardedOnSend',
      'width','height','mediaSourceId'];
    for (const [index, pc] of (window.__qualityPeers || []).entries()) {
      if (pc.connectionState !== 'connected') continue;
      const reports = await pc.getStats();
      const videoSdp=description=>String(description?.sdp||'').split(/\r?\nm=/).slice(1)
        .filter(section=>section.startsWith('video ')).flatMap(section=>section.split(/\r?\n/)
          .filter(line=>/^(video |a=rtpmap:|a=fmtp:|a=rtcp-fb:|a=extmap:|b=)/.test(line)));
      snapshots.push({ index, state: pc.connectionState,
        localVideoSdp:videoSdp(pc.localDescription),remoteVideoSdp:videoSdp(pc.remoteDescription),
        senders: pc.getSenders().filter(s => s.track?.kind === 'video').map(s => ({
          settings: s.track.getSettings(), contentHint: s.track.contentHint,
          parameters: {encodings:s.getParameters().encodings,degradationPreference:s.getParameters().degradationPreference}
        })),
        reports: [...reports.values()].filter(r => ['outbound-rtp','inbound-rtp',
          'remote-inbound-rtp','media-source','codec','transport','candidate-pair'].includes(r.type))
          .map(r => Object.fromEntries(wanted.filter(k => r[k] !== undefined).map(k => [k,r[k]])))
      });
    }
    const video = document.querySelector(side === 'sender' ? '#preview' : '#remote');
    return { at:Date.now(), peers:snapshots, video:video ? {
      width:video.videoWidth,height:video.videoHeight,displayWidth:video.clientWidth,displayHeight:video.clientHeight
    } : null };
  }, side);
}
function summarize(samples) {
  const snapshots = samples.map(s => s.sender.peers.flatMap(p => p.reports)
    .find(r => r.type === 'outbound-rtp' && r.kind === 'video'));
  const first = snapshots.find(Boolean), last = snapshots.filter(Boolean).at(-1);
  const seconds = first && last ? (last.timestamp-first.timestamp)/1000 : 0;
  const received = samples.at(-1)?.receiver.video;
  return { Mbps:seconds > 0 ? ((last.bytesSent-first.bytesSent)-((last.retransmittedBytesSent||0)-(first.retransmittedBytesSent||0)))*8/seconds/1e6 : null,
    encodedFps:seconds > 0 ? (last.framesEncoded-first.framesEncoded)/seconds : null,
    width:[...new Set(snapshots.map(r=>r?.frameWidth).filter(Boolean))],
    height:[...new Set(snapshots.map(r=>r?.frameHeight).filter(Boolean))],
    limitation:[...new Set(snapshots.map(r=>r?.qualityLimitationReason))],
    targetBitrate:last?.targetBitrate,encoder:last?.encoderImplementation,
    receivedWidth:received?.width,receivedHeight:received?.height };
}
async function main() {
  await fs.mkdir(output, {recursive:true});
  const originalBytes = await fs.readFile(realSettings).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const originalHash = originalBytes ? hash(originalBytes) : null;
  const report = {startedAt:new Date().toISOString(),executable,
    scope:'actual synthetic window capture; silent independent same-PC Electron receiver; executable and runtime.version identify the tested build; original remote network not reproduced',
    codec,fps,bitrateMbps,minFps,motionFromStart,mode:ceilingOnly?'ceiling':'startup',cases:[],completed:false};
  let app,profile;
  try {
    profile = path.join(incident, `profile-${Date.now()}`);
    await fs.mkdir(profile,{recursive:true});
    const config = {...require(path.join(root,'src/config')).DEFAULTS,host:'127.0.0.1',port:await freePort(),
      resolution:'1080',fps,bitrateMbps,maxViewers:2,codec,rtmpEnabled:false,
      microphone:false,systemAudio:false,roomName:'Quality diagnostic',forwardingEnabled:false,
      autoRouterAddress:false,sourceType:'window'};
    await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify(config));
    app = await _electron.launch({executablePath:executable,args:packaged ? [] : [root],
      env:{...process.env,LAN_CAST_DATA_DIR:profile},timeout:30000});
    const host = await app.firstWindow();
    host.setDefaultTimeout(15000);
    await host.waitForFunction(()=>window.lan && document.querySelector('.source-card'));
    report.runtime = await app.evaluate(({app,screen})=>({version:app.getVersion(),versions:process.versions,
      appPath:app.getAppPath(),executablePath:app.getPath('exe'),
      displays:screen.getAllDisplays().map(d=>({width:d.size.width,height:d.size.height,scaleFactor:d.scaleFactor}))}));
    report.runtime.executableSha256=hash(await fs.readFile(report.runtime.executablePath));
    if(report.runtime.appPath.endsWith('.asar'))report.runtime.asarSha256=hash(await fs.readFile(report.runtime.appPath));
    report.runtime.modules={};
    for(const file of ['src/renderer/host-media.js','src/shared/rtc.js']){
      const bytes=report.runtime.appPath.endsWith('.asar')
        ? asar.extractFile(report.runtime.appPath,path.join(...file.split('/')))
        : await fs.readFile(path.join(report.runtime.appPath,file));
      report.runtime.modules[file]=hash(bytes);
    }
    await host.evaluate(()=>{
      window.__qualityPeers=[];
      window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(target,args){
        const pc=Reflect.construct(target,args);window.__qualityPeers.push(pc);
        return pc;
      }});
    });
    await app.evaluate(async({BrowserWindow})=>{
      const fixture=new BrowserWindow({width:1920,height:1080,useContentSize:true,title:'LAN quality fixture',
        webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      globalThis.__qualityFixture=fixture;fixture.webContents.setAudioMuted(true);
      const html='<html><head><meta charset="utf-8"><title>LAN quality fixture</title><style>'+
        'html,body{margin:0;overflow:hidden;background:white;color:#111;font:16px Segoe UI}'+
        '#grid{width:2400px;display:grid;grid-template-columns:repeat(6,390px);gap:8px}'+
        '.cell{padding:7px;border:1px solid #777}.small{font-size:12px}.big{font-size:24px}'+
        '#moving{height:250px;background:repeating-conic-gradient(#023e8a 0% 25%,#ffb703 0% 50%) 0 0/31px 31px}'+
        'body.moving #grid{animation:scroll 4s linear infinite}body.moving #moving{animation:pattern 1s linear infinite}'+
        '@keyframes scroll{to{transform:translate(-300px,-70px)}}@keyframes pattern{to{background-position:280px 93px}}'+
        '</style></head><body><div id="moving"></div><div id="grid"></div><script>'+
        'document.querySelector("#grid").innerHTML=Array.from({length:96},(_,i)=>`<div class="cell">'+
        '<b>Screen quality 文字清晰度 ${i}</b><br><span class="small">0123456789 ABCDEFG abcdefg 基建广播测试</span>'+
        '<br><span class="big">1080p / 60 fps</span></div>`).join("");'+
        'window.setMotion=enabled=>document.body.classList.toggle("moving",enabled);</script></body></html>';
      await fixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('#refresh-sources').click();
    await host.locator('.source-card').filter({hasText:'LAN quality fixture'}).click();
    if(await host.locator('#rtmp-enabled').count())await host.locator('#rtmp-enabled').uncheck();
    await host.locator('#microphone').uncheck();await host.locator('#system-audio').uncheck();
    {
      if(motionFromStart)await app.evaluate(()=>globalThis.__qualityFixture.webContents.executeJavaScript('window.setMotion(true)'));
      console.log(`BEGIN 1080p${fps} ${codec} ${bitrateMbps}Mbps ${motionFromStart?'motion-from-start':'static-to-motion'} ${motionSamples} samples`);
      await host.locator('#fps').selectOption(String(fps));await host.locator('#start').click();
      await host.waitForFunction(()=>document.querySelector('#preview').videoWidth>0);
      const invite=await host.locator('#invite-link').inputValue();
      const ready=app.waitForEvent('window');
      await app.evaluate(async({BrowserWindow},invite)=>{
        const viewer=new BrowserWindow({width:1200,height:800,webPreferences:{sandbox:true,contextIsolation:true,
          nodeIntegration:false,backgroundThrottling:false,partition:`quality-${Date.now()}`}});
        globalThis.__qualityViewer=viewer;viewer.webContents.setAudioMuted(true);await viewer.loadURL(invite);
      },invite);
      const viewer=await ready;
      await viewer.evaluate(()=>{
        window.__qualityPeers=[];
        window.RTCPeerConnection=new Proxy(window.RTCPeerConnection,{construct(target,args){
          const pc=Reflect.construct(target,args);window.__qualityPeers.push(pc);return pc;
        }});
      });
      await viewer.locator('#watch').click();
      await until(()=>collect(viewer,'receiver'),s=>s.video?.width>0 && s.peers.length>0,'receiver decode timeout');
      for(const motion of motionFromStart ? [true] : [false,true]){
        await app.evaluate((_,motion)=>globalThis.__qualityFixture.webContents.executeJavaScript(`window.setMotion(${motion})`),motion);
        const phaseStartedAt=Date.now();
        await delay(1800);
        const result={fps,motion,phaseStartedAt,warmupMs:1800,samples:[]};
        report.cases.push(result);
        const count=motion?motionSamples:staticSamples;
        for(let i=0;i<count;i++){
          const [sender,receiver]=await Promise.all([collect(host,'sender'),collect(viewer,'receiver')]);
          result.samples.push({sender,receiver});
          if(i%5===0){
            const pc=sender.peers[0],out=pc?.reports.find(r=>r.type==='outbound-rtp'&&r.kind==='video');
            const src=pc?.reports.find(r=>r.type==='media-source'&&r.kind==='video');
            const pair=pc?.reports.find(r=>r.type==='candidate-pair'&&r.availableOutgoingBitrate!==undefined);
            const prior=result.samples.at(-2)?.sender.peers[0]?.reports.find(r=>r.id===out?.id);
            const seconds=prior&&out?(out.timestamp-prior.timestamp)/1000:0;
            console.log(JSON.stringify({sample:i,motion,sourceFps:src?.framesPerSecond,
              fps:seconds>0?(out.framesEncoded-prior.framesEncoded)/seconds:null,
              mbps:seconds>0?(out.bytesSent-prior.bytesSent)*8/seconds/1e6:null,
              targetMbps:out?.targetBitrate/1e6,bweMbps:pair?.availableOutgoingBitrate/1e6,
              limitation:out?.qualityLimitationReason,width:out?.frameWidth,height:out?.frameHeight}));
            await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
          }
          if(i<count-1)await delay(1000);
        }
        result.summary=summarize(result.samples);
        await viewer.locator('#remote').screenshot({path:path.join(output,`receiver-${fps}-${motion?'motion':'static'}.png`)});
        await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify({fps,motion,...result.summary}));
        if(motion){
          const outbound=s=>s.sender.peers[0]?.reports.find(r=>r.type==='outbound-rtp'&&r.kind==='video');
          const inbound=s=>s.receiver.peers[0]?.reports.find(r=>r.type==='inbound-rtp'&&r.kind==='video');
          const early=result.samples.filter(s=>s.sender.at-phaseStartedAt<=5000);
          assert.ok(early.length>=2,'too few samples within the first 5 seconds after motion');
          const a=outbound(early[0]),b=outbound(early.at(-1));
          const ra=inbound(early[0]),rb=inbound(early.at(-1));
          const seconds=(b.timestamp-a.timestamp)/1000;
          const expected=result.samples[0].sender.peers[0].senders[0].settings;
          const actualCodec=result.samples.at(-1).sender.peers[0].reports.find(r=>r.type==='codec'&&r.id===b.codecId)?.mimeType;
          result.startup={windowMs:5000,firstSampleAfterMs:early[0].sender.at-phaseStartedAt,
            payloadRatio:startupPayloadRatio,
            targetMbps:a.targetBitrate/1e6,
            mediaMbps:((b.bytesSent-a.bytesSent)-((b.retransmittedBytesSent||0)-(a.retransmittedBytesSent||0)))*8/seconds/1e6,
            encodedFps:(b.framesEncoded-a.framesEncoded)/seconds,
            decodedFps:(rb.framesDecoded-ra.framesDecoded)*1000/(rb.timestamp-ra.timestamp),
            actualCodec};
          await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
          if(!ceilingOnly){
            assert.ok(result.startup.mediaMbps>=bitrateMbps*startupPayloadRatio,'startup media payload remains too low in first 5 seconds');
          }
          assert.ok(result.summary.Mbps>0,'video payload did not advance');
          assert.ok(result.startup.encodedFps>=minFps,'startup encoding cadence below declared minimum');
          assert.ok(result.startup.decodedFps>=minFps*0.9,'startup decoding cadence below declared minimum');
          assert.ok(result.summary.width.every(w=>w>=expected.width*0.98),'sender reduced width');
          assert.ok(result.summary.height.every(h=>h>=expected.height*0.98),'sender reduced height');
          assert.ok(result.summary.receivedWidth>=expected.width*0.98,'receiver width degraded');
          assert.ok(result.summary.receivedHeight>=expected.height*0.98,'receiver height degraded');
          assert.ok(result.samples.every(s=>outbound(s).targetBitrate<=bitrateMbps*1e6*1.01),'encoder target exceeds configured ceiling');
          assert.ok(result.samples.every(s=>s.sender.peers[0].senders[0].parameters.encodings[0].maxBitrate===bitrateMbps*1e6),'sender ceiling changed');
          const expectedCodec={HEVC:'video/H265',H264:'video/H264',VP8:'video/VP8'}[codec];
          assert.equal(actualCodec.toLowerCase(),expectedCodec.toLowerCase(),'requested codec was not actually encoded');
          console.log(`PASS ${report.mode} ${JSON.stringify(result.startup)}`);
        }
      }
      await host.locator('#start').click();await host.waitForFunction(()=>!document.querySelector('#fps').disabled);
      await app.evaluate(()=>globalThis.__qualityViewer.destroy());
      await app.evaluate(()=>globalThis.__qualityFixture.webContents.executeJavaScript('window.setMotion(false)'));
    }
    report.completed=true;
  }catch(error){report.error={name:error.name,message:error.message};console.error(error.stack);process.exitCode=1;}
  finally{
    if(app){
      await app.evaluate(()=>{globalThis.__qualityViewer?.destroy();globalThis.__qualityFixture?.destroy();}).catch(()=>{});
      await app.close().catch(error=>{report.closeError=error.message;report.completed=false;process.exitCode=1;});
    }
    const finalBytes=await fs.readFile(realSettings).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    report.realSettingsUnchanged=originalHash===(finalBytes?hash(finalBytes):null);
    if(!report.realSettingsUnchanged){report.completed=false;process.exitCode=1;}
    if(profile&&!report.closeError){
      const cleanupPath=path.resolve(profile),cacheRoot=path.join(root,'.cache')+path.sep;
      assert.ok(cleanupPath.startsWith(cacheRoot),'test profile cleanup escaped cache');
      await fs.rm(cleanupPath,{recursive:true,force:true});
    }
    report.finishedAt=new Date().toISOString();
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({completed:report.completed,realSettingsUnchanged:report.realSettingsUnchanged,output:path.join(output,'report.json')}));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
