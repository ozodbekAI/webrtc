let ws = null;             // WebSocket
let localStream = null;    // MediaStream
const pcs = {};            // { peerName: RTCPeerConnection }
const iceQueues = {};      // { peerName: [candidates] }
const audioAnalysers = {}; // { peerName: AnalyserNode }
let iceServers = [];
let me = "";               // current username
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let isJoining = false;     // Prevent multiple joins
let localAudioMuted = false;
let localVideoMuted = false;

// ---------- helpers ---------- //
const $ = sel => document.querySelector(sel);
const log = (...a) => console.log("[client]", ...a);
const uiStatus = msg => {
  const div = document.createElement("div");
  div.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
  div.className = msg.includes("error") ? "status-error" : "status-info";
  $("#statusMessages").appendChild(div);
  $("#statusMessages").scrollTop = $("#statusMessages").scrollHeight;
};

// deterministic initiator: alphabetical order
const amInitiator = peer => me < peer;

// attach local tracks if not already added
function attachTracks(pc) {
  if (!localStream) {
    log("No local stream available to attach");
    return;
  }
  const kinds = pc.getSenders().map(s => s.track?.kind || "");
  localStream.getTracks().forEach(t => {
    if (!kinds.includes(t.kind) && ((t.kind === "audio" && !localAudioMuted) || (t.kind === "video" && !localVideoMuted))) {
      log(`Attaching track: ${t.kind} to ${pc}`);
      pc.addTrack(t, localStream);
    }
  });
}

// create audio analyser for volume visualization
function createAnalyser(stream, peer) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    audioAnalysers[peer] = { analyser, ctx: audioCtx };
    log(`Analyser created for ${peer}`);
    updateVolume(peer);
  } catch (err) {
    log(`Error creating analyser for ${peer}:`, err);
    uiStatus(`Error setting up audio for ${peer}`);
  }
}

// update volume visualizer
function updateVolume(peer) {
  const { analyser } = audioAnalysers[peer] || {};
  if (!analyser) return;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);
  const average = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
  const volume = Math.min(100, (average / 255) * 100);
  const meter = document.getElementById(`volume-${peer}`);
  if (meter) {
    meter.style.width = `${volume}%`;
    meter.className = `volume-meter ${volume > 10 ? 'active' : ''}`;
  }
  requestAnimationFrame(() => updateVolume(peer));
}

// cleanup peer connection
function cleanupPeer(peer) {
  log(`Cleaning up peer: ${peer}`);
  if (pcs[peer]) {
    pcs[peer].close();
    delete pcs[peer];
    delete iceQueues[peer];
    if (audioAnalysers[peer]) {
      audioAnalysers[peer].ctx.close().catch(err => log(`Error closing audio context for ${peer}:`, err));
      delete audioAnalysers[peer];
    }
    const peerWrap = document.getElementById(`peer-${peer}`);
    if (peerWrap) peerWrap.remove();
  }
}

// create / reuse RTCPeerConnection
function getPC(peer) {
  if (pcs[peer]) return pcs[peer];
  log(`Creating new RTCPeerConnection for ${peer}`);
  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: "relay"  // Mobil tarmoqlarda TURN server majburiy ishlatiladi
  });
  pcs[peer] = pc;
  iceQueues[peer] = [];

  attachTracks(pc);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      log(`Sending ICE candidate for ${peer}:`, candidate);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ice_candidate", to: peer, candidate }));
      }
    }
  };

  pc.ontrack = ({ streams, track }) => {
    log(`Received track for ${peer}: ${track.kind}`, streams);
    let peerWrap = document.getElementById(`peer-${peer}`);
    if (!peerWrap) {
      log(`Creating media elements for ${peer}`);
      peerWrap = document.createElement("div");
      peerWrap.id = `peer-${peer}`;
      peerWrap.className = "peer-card";
      peerWrap.innerHTML = `
        <div class="peer-header">
          <span class="peer-name">${peer}</span>
          <span id="audio-status-${peer}" class="status-icon"></span>
          <span id="video-status-${peer}" class="status-icon"></span>
        </div>
        <div class="video-container">
          <video id="video-${peer}" autoplay playsinline></video>
        </div>
        <div class="volume-container">
          <div id="volume-${peer}" class="volume-meter"></div>
        </div>`;
      $("#peerStreams").appendChild(peerWrap);
    }
    if (track.kind === "video") {
      const video = document.getElementById(`video-${peer}`);
      video.srcObject = streams[0];
      video.setAttribute("playsinline", ""); // Mobil uchun qo‘shimcha
      video.play().catch(err => {
        log(`Video play error for ${peer}:`, err);
        uiStatus(`Video error for ${peer}: ${err.message}`);
        const btn = document.createElement("button");
        btn.textContent = `Play ${peer}'s Video`;
        btn.className = "play-btn";
        btn.onclick = () => video.play();
        peerWrap.appendChild(btn);
      });
    } else if (track.kind === "audio") {
      const audio = document.getElementById(`audio-${peer}`) || document.createElement("audio");
      audio.id = `audio-${peer}`;
      audio.controls = true;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.srcObject = streams[0];
      peerWrap.appendChild(audio);
      audio.play().catch(err => {
        log(`Audio play error for ${peer}:`, err);
        uiStatus(`Audio error for ${peer}: ${err.message}`);
        const btn = document.createElement("button");
        btn.textContent = `Play ${peer}'s Audio`;
        btn.className = "play-btn";
        btn.onclick = () => audio.play();
        peerWrap.appendChild(btn);
      });
      if (streams[0]) createAnalyser(streams[0], peer);
    }
  };

  pc.onconnectionstatechange = () => uiStatus(`⇄ ${peer}: ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => {
    uiStatus(`ICE ${peer}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "closed" || pc.iceConnectionState === "failed") {
      cleanupPeer(peer);
    }
  };
  return pc;
}

// ---------- signaling handlers ---------- //
async function sendOffer(peer) {
  const pc = getPC(peer);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "offer", to: peer, sdp: offer }));
      uiStatus(`offer → ${peer}`);
      log(`Sent offer to ${peer}:`, offer);
    }
  } catch (err) {
    log(`Error sending offer to ${peer}:`, err);
    uiStatus(`Error sending offer to ${peer}`);
  }
}

async function onOffer({ from, sdp }) {
  const pc = getPC(from);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    attachTracks(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "answer", to: from, sdp: answer }));
      uiStatus(`answer → ${from}`);
      log(`Sent answer to ${from}:`, answer);
    }
    flushIce(from);
  } catch (err) {
    log(`Error handling offer from ${from}:`, err);
    uiStatus(`Error handling offer from ${from}`);
  }
}

async function onAnswer({ from, sdp }) {
  const pc = pcs[from];
  if (!pc) {
    log(`No peer connection for ${from}`);
    return;
  }
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    log(`Set remote description for ${from}`);
    flushIce(from);
  } catch (err) {
    log(`Error handling answer from ${from}:`, err);
    uiStatus(`Error handling answer from ${from}`);
  }
}

function onIce({ from, candidate }) {
  const pc = pcs[from];
  if (pc && pc.remoteDescription) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
      log(`Error adding ICE candidate from ${from}:`, err);
      uiStatus(`Error adding ICE candidate from ${from}`);
    });
  } else {
    iceQueues[from] = iceQueues[from] || [];
    iceQueues[from].push(candidate);
    log(`Queued ICE candidate from ${from}`);
  }
}

function flushIce(peer) {
  if (iceQueues[peer]) {
    iceQueues[peer].forEach(c => {
      pcs[peer].addIceCandidate(new RTCIceCandidate(c)).catch(err => {
        log(`Error flushing ICE candidate for ${peer}:`, err);
        uiStatus(`Error flushing ICE candidate for ${peer}`);
      });
    });
    iceQueues[peer] = [];
  }
}

// ---------- WebSocket reconnect logic ---------- //
function connectWebSocket(roomid, name) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log("WebSocket already open, closing previous connection");
    ws.close();
  }
  // To‘g‘ri WebSocket sxemasini hosil qilish
  let wsUrl;
  if (location.protocol === 'https:') {
    wsUrl = `wss://${location.host}/ws/${roomid}/${name}`;
  } else {
    wsUrl = `ws://${location.host}/ws/${roomid}/${name}`;
  }
  log(`Connecting to WebSocket: ${wsUrl}`);
  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    uiStatus("WebSocket open");
    log("WebSocket opened");
    reconnectAttempts = 0;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user" // Mobil uchun old kamera
        }
      });
      uiStatus("🎙️📹 mic and camera ready");
      log("Microphone and camera access granted");
      $("#toggleAudioBtn").disabled = false;
      $("#toggleVideoBtn").disabled = false;
      // Re-attach tracks to existing peer connections
      Object.keys(pcs).forEach(peer => attachTracks(pcs[peer]));
    } catch (err) {
      uiStatus("Mic or camera denied");
      log("Media access denied:", err);
      alert("Microphone and camera access required");
    }
  };

  ws.onmessage = async ev => {
    try {
      const msg = JSON.parse(ev.data);
      log("Received message:", msg);
      switch (msg.type) {
        case "ice_servers":
          iceServers = msg.ice_servers;
          log("ICE servers received:", iceServers);
          break;
        case "room_state":
          renderUsers(msg.users);
          break;
        case "offer":
          onOffer(msg);
          break;
        case "answer":
          onAnswer(msg);
          break;
        case "ice_candidate":
          onIce(msg);
          break;
      }
    } catch (err) {
      log("Error processing WebSocket message:", err);
      uiStatus("Error processing WebSocket message");
    }
  };

  ws.onclose = () => {
    uiStatus("WebSocket closed");
    log("WebSocket closed");
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      uiStatus(`Reconnecting... Attempt ${reconnectAttempts}/${maxReconnectAttempts}`);
      setTimeout(() => connectWebSocket(roomid, name), 1000 * reconnectAttempts);
    } else {
      uiStatus("Max reconnect attempts reached");
      $("#joinBtn").disabled = false;
    }
  };

  ws.onerror = err => {
    uiStatus("WebSocket error");
    log("WebSocket error:", err);
  };
}

// ---------- UI ---------- //
document.addEventListener("DOMContentLoaded", () => {
  $("#joinBtn").onclick = joinRoom;
  $("#toggleAudioBtn").onclick = toggleAudio;
  $("#toggleVideoBtn").onclick = toggleVideo;
});

async function joinRoom() {
  if (isJoining) {
    log("Join already in progress, ignoring");
    return;
  }
  isJoining = true;
  $("#joinBtn").disabled = true;

  const roomid = $("#roomid").value.trim();
  me = $("#name").value.trim();
  if (!roomid || !me) {
    alert("Enter room & name");
    isJoining = false;
    $("#joinBtn").disabled = false;
    return;
  }

  log(`Joining room ${roomid} as ${me}`);
  // Cleanup previous connections
  Object.keys(pcs).forEach(cleanupPeer);
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.stop();
      log(`Stopped track: ${track.kind}`);
    });
    localStream = null;
  }
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.close();
    ws = null;
  }
  connectWebSocket(roomid, me);
  isJoining = false;
}

function toggleAudio() {
  localAudioMuted = !localAudioMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(track => {
      track.enabled = !localAudioMuted;
      log(`Audio track enabled: ${track.enabled}`);
    });
    Object.keys(pcs).forEach(peer => attachTracks(pcs[peer]));
  }
  $("#toggleAudioBtn").innerHTML = localAudioMuted ? '<i class="fas fa-microphone-slash"></i> Unmute Audio' : '<i class="fas fa-microphone"></i> Mute Audio';
  $("#toggleAudioBtn").className = localAudioMuted ? "btn btn-muted" : "btn";
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mute_state", audio_muted: localAudioMuted, video_muted: localVideoMuted }));
    log(`Audio mute state updated: ${localAudioMuted}`);
  }
}

function toggleVideo() {
  localVideoMuted = !localVideoMuted;
  if (localStream) {
    localStream.getVideoTracks().forEach(track => {
      track.enabled = !localVideoMuted;
      log(`Video track enabled: ${track.enabled}`);
    });
    Object.keys(pcs).forEach(peer => attachTracks(pcs[peer]));
  }
  $("#toggleVideoBtn").innerHTML = localVideoMuted ? '<i class="fas fa-video-slash"></i> Enable Video' : '<i class="fas fa-video"></i> Disable Video';
  $("#toggleVideoBtn").className = localVideoMuted ? "btn btn-muted" : "btn";
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mute_state", audio_muted: localAudioMuted, video_muted: localVideoMuted }));
    log(`Video mute state updated: ${localVideoMuted}`);
  }
}

function renderUsers(users) {
  const ul = $("#userList");
  ul.innerHTML = "";
  const currentPeers = Object.keys(pcs);
  users.forEach(u => {
    const li = document.createElement("li");
    li.className = "user-item";
    li.innerHTML = `
      <span>${u.name}${u.name === me ? " (you)" : ""}</span>
      ${u.audio_muted ? '<span class="muted-icon"><i class="fas fa-microphone-slash"></i></span>' : '<span class="active-icon"><i class="fas fa-microphone"></i></span>'}
      ${u.video_muted ? '<span class="muted-icon"><i class="fas fa-video-slash"></i></span>' : '<span class="active-icon"><i class="fas fa-video"></i></span>'}
    `;
    ul.appendChild(li);

    // Establish connection for new peers
    if (u.name !== me && !pcs[u.name] && localStream && amInitiator(u.name)) {
      log(`Initiating connection with ${u.name}`);
      sendOffer(u.name);
    }
  });

  // Cleanup disconnected peers
  currentPeers.forEach(peer => {
    if (!users.some(u => u.name === peer)) {
      log(`Peer ${peer} disconnected, cleaning up`);
      cleanupPeer(peer);
    }
  });

  // Update mute status for peers
  users.forEach(u => {
    if (u.name !== me) {
      const audioStatus = document.getElementById(`audio-status-${u.name}`);
      const videoStatus = document.getElementById(`video-status-${u.name}`);
      if (audioStatus) audioStatus.innerHTML = u.audio_muted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
      if (videoStatus) videoStatus.innerHTML = u.video_muted ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
    }
  });

  uiStatus(`Room: ${users.length} users`);
}