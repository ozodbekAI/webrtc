// webrtc_client.js – fully refactored & aligned with backend signalling
// -----------------------------------------------------------
// Key points (v2):
// • Message type for ICE candidates reverted to **ice_candidate** so that
//   the Django channels backend no longer logs “Invalid message type … ice”.
// • All send/receive branches updated accordingly.
// • No functional changes otherwise – still uses replaceTrack, auto‑renegotiation,
//   ICE restart, etc.
// -----------------------------------------------------------

let roomId, name, ws;
let localStream; // current outgoing stream
const pcs = {};        // {peer: RTCPeerConnection}
const iceQueue = {};   // {peer: [candidates]}
const analysers = {};  // {peer: {ctx,an}}
let iceServers = [];

// UI & state
let mutedAudio = false;
let mutedVideo = false;
let isFrontCamera = true;
let isScreenSharing = false;

//------------------------------------------------------------------
// Helper functions
//------------------------------------------------------------------
const log = (...a)=>console.log('[client]',...a);
const status = (msg,err=false)=>{
  const wrap=document.getElementById('statusMessages');
  const d=document.createElement('div');
  d.className=`p-2 rounded-lg ${err?'bg-red-100 text-red-800':'bg-blue-100 text-blue-800'}`;
  d.textContent=`${new Date().toLocaleTimeString()} — ${msg}`;
  wrap.appendChild(d); wrap.scrollTop=wrap.scrollHeight; };
const youInitiate = peer => name < peer; // deterministic

//------------------------------------------------------------------
// Media capture helpers
//------------------------------------------------------------------
async function getCamera(facing='user'){
  return navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
    video:{width:{ideal:1280},height:{ideal:720},facingMode:facing}
  });
}
async function getScreen(){ return navigator.mediaDevices.getDisplayMedia({video:true}); }
function showLocal(stream){ const v=document.getElementById('localVideo'); v.srcObject=stream; v.play().catch(()=>{}); }

//------------------------------------------------------------------
// Track publishing
//------------------------------------------------------------------
function publishTrack(track){
  Object.values(pcs).forEach(pc=>{
    const sender=pc.getSenders().find(s=>s.track && s.track.kind===track.kind);
    sender?sender.replaceTrack(track).catch(log):pc.addTrack(track,localStream);
  });
}
function republishAll(){ localStream?.getTracks().forEach(publishTrack); }

//------------------------------------------------------------------
// PeerConnection lifecycle
//------------------------------------------------------------------
function getPC(peer){
  if(pcs[peer]) return pcs[peer];
  const pc=new RTCPeerConnection({iceServers,iceTransportPolicy:'all'});
  pcs[peer]=pc; iceQueue[peer]=[];

  republishAll();

  pc.onicecandidate=({candidate})=>{
    if(candidate) ws?.send(JSON.stringify({type:'ice_candidate',to:peer,candidate}));
  };
  pc.ontrack=({track,streams})=>handleRemoteTrack(peer,track,streams[0]);
  pc.onnegotiationneeded=async()=>{
    try{
      await pc.setLocalDescription(await pc.createOffer());
      ws?.send(JSON.stringify({type:'offer',to:peer,sdp:pc.localDescription}));
      status(`offer → ${peer}`);
    }catch(e){log('negotiation',e);} };
  pc.oniceconnectionstatechange=()=>{
    if(pc.iceConnectionState==='failed') pc.restartIce();
    if(['closed','failed','disconnected'].includes(pc.connectionState)) cleanupPeer(peer);
  };
  pc.onconnectionstatechange=()=>status(`${peer}: ${pc.connectionState}`);
  return pc;
}

//------------------------------------------------------------------
// Signalling handlers
//------------------------------------------------------------------
async function handleOffer({from,sdp}){
  const pc=getPC(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await pc.setLocalDescription(await pc.createAnswer());
  ws?.send(JSON.stringify({type:'answer',to:from,sdp:pc.localDescription}));
  status(`answer → ${from}`);
  flushIce(from);
}
async function handleAnswer({from,sdp}){
  const pc=pcs[from]; if(!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  flushIce(from);
}
function handleIceCandidate({from,candidate}){
  const pc=pcs[from];
  if(pc?.remoteDescription){ pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(log); }
  else iceQueue[from].push(candidate);
}
function flushIce(peer){ iceQueue[peer].forEach(c=>pcs[peer].addIceCandidate(new RTCIceCandidate(c)).catch(log)); iceQueue[peer]=[]; }

//------------------------------------------------------------------
// Remote media UI
//------------------------------------------------------------------
function handleRemoteTrack(peer,track,stream){
  if(track.kind==='video'){
    let vid=document.getElementById(`v-${peer}`);
    if(!vid){
      const wrap=document.createElement('div');
      wrap.className='bg-gray-50 p-4 rounded-lg shadow';
      wrap.innerHTML=`<h3 class="text-lg font-semibold mb-1">${peer}</h3><video id="v-${peer}" playsinline autoplay class="w-full h-48 rounded object-cover"></video><div id="vol-${peer}" class="h-1.5 bg-green-500 w-0"></div>`;
      document.getElementById('remoteVideos').appendChild(wrap);
      vid=wrap.querySelector('video');
    }
    vid.srcObject=stream;
  }else if(track.kind==='audio'){
    let aud=document.getElementById(`a-${peer}`);
    if(!aud){ aud=document.createElement('audio'); aud.id=`a-${peer}`; aud.autoplay=true; aud.playsInline=true; document.body.appendChild(aud); }
    aud.srcObject=stream; setupAnalyser(peer,stream);
  }
}
function setupAnalyser(peer,stream){
  if(analysers[peer]) return;
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const src=ctx.createMediaStreamSource(stream);
  const an=ctx.createAnalyser(); an.fftSize=256; src.connect(an);
  analysers[peer]={ctx,an}; drawVol(peer);
}
function drawVol(peer){
  const {an}=analysers[peer]||{}; if(!an) return;
  const data=new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(data);
  const pct=Math.min(100,data.reduce((s,v)=>s+v,0)/data.length/255*100);
  const bar=document.getElementById(`vol-${peer}`); if(bar) bar.style.width=`${pct}%`;
  requestAnimationFrame(()=>drawVol(peer));
}

//------------------------------------------------------------------
// Cleanup
//------------------------------------------------------------------
function cleanupPeer(peer){
  const pc=pcs[peer]; if(!pc) return;
  pc.close(); delete pcs[peer]; delete iceQueue[peer];
  analysers[peer]?.ctx.close(); delete analysers[peer];
  document.getElementById(`v-${peer}`)?.parentElement?.remove();
  document.getElementById(`a-${peer}`)?.remove();
}

//------------------------------------------------------------------
// UI actions
//------------------------------------------------------------------
async function toggleAudio(){
  mutedAudio=!mutedAudio;
  localStream?.getAudioTracks().forEach(t=>t.enabled=!mutedAudio);
  ws?.send(JSON.stringify({type:'mute_state',audio_muted:mutedAudio,video_muted:mutedVideo}));
  updateButtons();
}
async function toggleVideo(){
  mutedVideo=!mutedVideo;
  localStream?.getVideoTracks().forEach(t=>t.enabled=!mutedVideo);
  ws?.send(JSON.stringify({type:'mute_state',audio_muted:mutedAudio,video_muted:mutedVideo}));
  updateButtons();
}
async function switchCamera(){
  if(isScreenSharing) return;
  const cam=await getCamera(isFrontCamera?'environment':'user');
  const newTrack=cam.getVideoTracks()[0];
  localStream.getVideoTracks()[0].stop();
  localStream.removeTrack(localStream.getVideoTracks()[0]);
  localStream.addTrack(newTrack); publishTrack(newTrack); showLocal(localStream);
  isFrontCamera=!isFrontCamera; status(`Camera → ${isFrontCamera?'front':'rear'}`);
}
async function toggleScreen(){
  if(isScreenSharing){
    const cam=await getCamera(isFrontCamera?'user':'environment');
    swapVideoTrack(cam.getVideoTracks()[0]);
    isScreenSharing=false; status('Screen‑share stopped');
  }else{
    const scr=await getScreen();
    const t=scr.getVideoTracks()[0]; t.onended=toggleScreen;
    swapVideoTrack(t); isScreenSharing=true; status('Screen‑share started');
  }
  updateButtons();
}
function swapVideoTrack(newTrack){
  localStream.getVideoTracks()[0]?.stop();
  localStream.removeTrack(localStream.getVideoTracks()[0]);
  localStream.addTrack(newTrack); publishTrack(newTrack); showLocal(localStream);
}
function updateButtons(){
  const bA=document.getElementById('toggleAudio');
  bA.innerHTML=mutedAudio?'<i class="fas fa-microphone-slash"></i> Unmute':'<i class="fas fa-microphone"></i> Mute';
  bA.className=`flex-1 p-3 rounded-lg ${mutedAudio?'bg-red-500':'bg-blue-500'} text-white`;
  const bV=document.getElementById('toggleVideo');
  bV.innerHTML=mutedVideo?'<i class="fas fa-video-slash"></i> Enable':'<i class="fas fa-video"></i> Disable';
  bV.className=`flex-1 p-3 rounded-lg ${mutedVideo?'bg-red-500':'bg-blue-500'} text-white`;
  const bS=document.getElementById('toggleScreenShare');
  bS.innerHTML=isScreenSharing?'<i class="fas fa-stop"></i> Stop':'<i class="fas fa-desktop"></i> Share';
  bS.className=`flex-1 p-3 rounded-lg ${isScreenSharing?'bg-red-500':'bg-teal-500'} text-white`;
}

//------------------------------------------------------------------
// Signalling – WebSocket
//------------------------------------------------------------------
function connectWS(){
  const url=(location.protocol==='https:'?'wss://':'ws://')+location.host+`/ws/${roomId}/${name}`;
  ws=new WebSocket(url);
  ws.onopen=async()=>{
    status('WebSocket open');
    if(!localStream){ localStream=await getCamera('user'); showLocal(localStream); }
    republishAll();
  };
  ws.onmessage=({data})=>{
    try{ const m=JSON.parse(data);
      switch(m.type){
        case 'ice_servers': iceServers=m.ice_servers; break;
        case 'room_state': renderRoom(m.users); break;
        case 'offer': handleOffer(m); break;
        case 'answer': handleAnswer(m); break;
        case 'ice_candidate': handleIceCandidate(m); break;
        case 'chat': addChat(m.from,m.text); break;
      }
    }catch(e){log('msg',e);} };
  ws.onclose=()=>{status('WebSocket closed',true); setTimeout(connectWS,1000);};
  ws.onerror=e=>status('WebSocket error',true);
}

//------------------------------------------------------------------
// Room rendering
//------------------------------------------------------------------
function renderRoom(users){
  const ul=document.getElementById('userList'); ul.innerHTML='';
  users.forEach(u=>{
    const li=document.createElement('li'); li.textContent=u.name+(u.name===name?' (you)':''); ul.appendChild(li);
    if(u.name!==name && !pcs[u.name] && youInitiate(u.name)) getPC(u.name);
  });
  Object.keys(pcs).forEach(p=>{ if(!users.find(u=>u.name===p)) cleanupPeer(p); });
}

//------------------------------------------------------------------
// Join logic
//------------------------------------------------------------------
document.getElementById('joinButton').onclick=()=>{
  roomId=document.getElementById('roomIdInput').value.trim();
  name  =document.getElementById('nameInput').value.trim();
  if(!roomId||!name) return alert('Enter room & name');
  document.getElementById('joinSection').classList.add('hidden');
  document.getElementById('roomSection').classList.remove('hidden');
  Object.keys(pcs).forEach(cleanupPeer);
  localStream?.getTracks().forEach(t=>t.stop()); localStream=null;
  ws?.close();
  connectWS();
};

document.getElementById('toggleAudio').onclick=toggleAudio;
document.getElementById('toggleVideo').onclick=toggleVideo;
document.getElementById('switchCamera').onclick=switchCamera;
document.getElementById('toggleScreenShare').onclick=toggleScreen;

// Chat helpers unchanged (omitted)
