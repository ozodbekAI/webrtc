let roomId, name, ws, localStream, pcs = {}, iceQueues = {}, audioAnalysers = {}, iceServers = [];
let localAudioMuted = false, localVideoMuted = false, isFrontCamera = true, isScreenSharing = false;

const log = (...args) => console.log('[client]', ...args);
const addStatus = (msg, isError = false) => {
    const statusMessages = document.getElementById('statusMessages');
    const div = document.createElement('div');
    div.className = `p-2 rounded-lg ${isError ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`;
    div.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
    statusMessages.appendChild(div);
    statusMessages.scrollTop = statusMessages.scrollHeight;
};

const amInitiator = peer => name < peer;

const attachTracks = (pc, peer) => {
    if (!localStream) {
        log('No local stream available to attach');
        addStatus('No local stream available', true);
        return;
    }
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
        const kind = track.kind;
        if ((kind === 'audio' && !localAudioMuted) || (kind === 'video' && !localVideoMuted)) {
            if (!senders.some(s => s.track?.kind === kind)) {
                log(`Attaching ${kind} track to ${peer}`);
                pc.addTrack(track, localStream);
            } else {
                log(`Track ${kind} already attached to ${peer}`);
            }
        }
    });
};

const createAnalyser = (stream, peer) => {
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
        addStatus(`Error setting up audio for ${peer}`, true);
    }
};

const updateVolume = (peer) => {
    const { analyser } = audioAnalysers[peer] || {};
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;
    const volume = Math.min(100, (average / 255) * 100);
    const meter = document.getElementById(`volume-${peer}`);
    if (meter) {
        meter.style.width = `${volume}%`;
        meter.className = `h-1.5 bg-green-500 transition-all duration-100 ${volume > 10 ? 'bg-green-600' : ''}`;
    }
    requestAnimationFrame(() => updateVolume(peer));
};

const cleanupPeer = (peer) => {
    log(`Cleaning up peer: ${peer}`);
    if (pcs[peer]) {
        pcs[peer].close();
        delete pcs[peer];
        delete iceQueues[peer];
        if (audioAnalysers[peer]) {
            audioAnalysers[peer].ctx.close().catch(err => log(`Error closing audio context for ${peer}:`, err));
            delete audioAnalysers[peer];
        }
        const videoDiv = document.getElementById(`video-${peer}`)?.parentElement?.parentElement;
        if (videoDiv) videoDiv.remove();
        const audioElement = document.getElementById(`audio-${peer}`);
        if (audioElement) audioElement.remove();
    }
};

const getPC = (peer) => {
    if (pcs[peer]) return pcs[peer];
    log(`Creating new RTCPeerConnection for ${peer}`);
    const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all'
    });
    pcs[peer] = pc;
    iceQueues[peer] = [];

    attachTracks(pc, peer);

    pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws && ws.readyState === WebSocket.OPEN) {
            log(`Sending ICE candidate for ${peer}:`, candidate);
            ws.send(JSON.stringify({ type: 'ice_candidate', to: peer, candidate }));
        }
    };

    pc.ontrack = ({ streams, track }) => {
        log(`Received track for ${peer}: ${track.kind}`, streams);
        if (track.kind === 'video') {
            const videoElement = document.getElementById(`video-${peer}`);
            if (videoElement) {
                videoElement.srcObject = streams[0];
                videoElement.play().catch(err => {
                    log(`Video play error for ${peer}:`, err);
                    addStatus(`Video error for ${peer}: ${err.message}`, true);
                });
            }
        } else if (track.kind === 'audio') {
            let audioElement = document.getElementById(`audio-${peer}`);
            if (!audioElement) {
                audioElement = document.createElement('audio');
                audioElement.id = `audio-${peer}`;
                audioElement.autoplay = true;
                audioElement.playsInline = true;
                document.body.appendChild(audioElement);
            }
            audioElement.srcObject = streams[0];
            audioElement.play().catch(err => {
                log(`Audio play error for ${peer}:`, err);
                addStatus(`Audio error for ${peer}: ${err.message}`, true);
            });
            if (streams[0]) createAnalyser(streams[0], peer);
        }
    };

    pc.onconnectionstatechange = () => {
        addStatus(`Connection ${peer}: ${pc.connectionState}`);
        log(`Connection state for ${peer}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            log(`Restarting ICE for ${peer}`);
            pc.restartIce();
        }
    };
    pc.oniceconnectionstatechange = () => {
        addStatus(`ICE ${peer}: ${pc.iceConnectionState}`);
        log(`ICE connection state for ${peer}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
            cleanupPeer(peer);
        }
    };
    return pc;
};

const sendOffer = async (peer) => {
    const pc = getPC(peer);
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'offer', to: peer, sdp: offer }));
            addStatus(`offer → ${peer}`);
            log(`Sent offer to ${peer}:`, offer);
        }
    } catch (err) {
        log(`Error sending offer to ${peer}:`, err);
        addStatus(`Error sending offer to ${peer}`, true);
    }
};

const onOffer = async ({ from, sdp }) => {
    const pc = getPC(from);
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        attachTracks(pc, from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'answer', to: from, sdp: answer }));
            addStatus(`answer → ${from}`);
            log(`Sent answer to ${from}:`, answer);
        }
        flushIce(from);
    } catch (err) {
        log(`Error handling offer from ${from}:`, err);
        addStatus(`Error handling offer from ${from}`, true);
    }
};

const onAnswer = async ({ from, sdp }) => {
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
        addStatus(`Error handling answer from ${from}`, true);
    }
};

const onIce = ({ from, candidate }) => {
    const pc = pcs[from];
    if (pc && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
            log(`Error adding ICE candidate from ${from}:`, err);
            addStatus(`Error adding ICE candidate from ${from}`, true);
        });
    } else {
        iceQueues[from] = iceQueues[from] || [];
        iceQueues[from].push(candidate);
        log(`Queued ICE candidate from ${from}`);
    }
};

const flushIce = (peer) => {
    if (iceQueues[peer]) {
        iceQueues[peer].forEach(c => {
            pcs[peer].addIceCandidate(new RTCIceCandidate(c)).catch(err => {
                log(`Error flushing ICE candidate for ${peer}:`, err);
                addStatus(`Error flushing ICE candidate for ${peer}`, true);
            });
        });
        iceQueues[peer] = [];
    }
};

const connectWebSocket = async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        log('WebSocket already open, closing previous connection');
        ws.close();
    }
    const wsUrl = `wss://webrtc.bazarchi.software/ws/${roomId}/${name}`;
    log(`Connecting to WebSocket: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
        addStatus('WebSocket open');
        log('WebSocket opened');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: isFrontCamera ? 'user' : 'environment' }
            });
            localStream = stream;
            const localVideo = document.getElementById('localVideo');
            localVideo.srcObject = stream;
            localVideo.play().catch(err => {
                log('Local video play error:', err);
                addStatus(`Local video error: ${err.message}`, true);
            });
            addStatus('🎙️📹 mic and camera ready');
            log('Microphone and camera access granted');
            Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
        } catch (err) {
            addStatus('Mic or camera access denied', true);
            log('Media access denied:', err);
            alert('Microphone and camera access required');
        }
    };

    ws.onmessage = async ev => {
        try {
            const msg = JSON.parse(ev.data);
            log('Received message:', msg);
            switch (msg.type) {
                case 'ice_servers':
                    iceServers = msg.ice_servers;
                    log('ICE servers received:', msg.ice_servers);
                    break;
                case 'room_state':
                    updateUserList(msg.users);
                    addStatus(`Room: ${msg.users.length} users`);
                    break;
                case 'offer':
                    onOffer(msg);
                    break;
                case 'answer':
                    onAnswer(msg);
                    break;
                case 'ice_candidate':
                    onIce(msg);
                    break;
                case 'chat':
                    addChatMessage(msg.from, msg.text);
                    break;
                case 'mute_state':
                    updateUserList(msg.users);
                    break;
                case 'screen_share':
                    addStatus(`${msg.from} ${msg.sharing ? 'started' : 'stopped'} screen sharing`);
                    break;
            }
        } catch (err) {
            log('Error processing WebSocket message:', err);
            addStatus('Error processing WebSocket message', true);
        }
    };

    ws.onclose = () => {
        addStatus('WebSocket closed', true);
        log('WebSocket closed');
        setTimeout(connectWebSocket, 2000); // 2 soniya kutib qayta ulanish
    };

    ws.onerror = err => {
        addStatus(`WebSocket error: ${err.message || 'Unknown error'}`, true);
        log('WebSocket error:', err);
    };
};

const updateUserList = (users) => {
    const userList = document.getElementById('userList');
    userList.innerHTML = '';
    users.forEach(u => {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2 p-2 bg-white rounded-lg shadow-sm';
        li.innerHTML = `
            <span class="font-medium">${u.name}${u.name === name ? ' (you)' : ''}</span>
            <i class="${u.audio_muted ? 'fas fa-microphone-slash text-red-500' : 'fas fa-microphone text-green-500'}"></i>
            <i class="${u.video_muted ? 'fas fa-video-slash text-red-500' : 'fas fa-video text-green-500'}"></i>
        `;
        userList.appendChild(li);

        if (u.name !== name && !document.getElementById(`video-${u.name}`)) {
            const videoDiv = document.createElement('div');
            videoDiv.className = 'bg-gray-50 p-4 rounded-lg shadow';
            videoDiv.innerHTML = `
                <div class="flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-blue-900">${u.name}</h3>
                    <div class="flex gap-2">
                        <i class="${u.audio_muted ? 'fas fa-microphone-slash text-red-500' : 'fas fa-microphone text-green-500'}"></i>
                        <i class="${u.video_muted ? 'fas fa-video-slash text-red-500' : 'fas fa-video text-green-500'}"></i>
                    </div>
                </div>
                <div class="relative">
                    <video id="video-${u.name}" autoplay playsinline class="w-full h-48 rounded-lg object-cover"></video>
                    <div id="volume-${u.name}" class="absolute bottom-0 left-0 h-1.5 bg-green-500"></div>
                </div>
            `;
            document.getElementById('remoteVideos').appendChild(videoDiv);
        }
    });

    Object.keys(pcs).forEach(peer => {
        if (!users.some(u => u.name === peer)) {
            log(`Peer ${peer} disconnected, cleaning up`);
            cleanupPeer(peer);
        }
    });

    users.forEach(u => {
        if (u.name !== name && !pcs[u.name] && localStream && amInitiator(u.name)) {
            log(`Initiating connection with ${u.name}`);
            sendOffer(u.name);
        }
    });
};

const addChatMessage = (sender, text) => {
    const chatMessages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `mb-2 ${sender === name ? 'text-right' : 'text-left'}`;
    div.innerHTML = `
        <span class="text-xs text-gray-500">${new Date().toLocaleTimeString()}</span>
        <p class="font-medium">${sender}: ${text}</p>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
};

const toggleAudio = () => {
    localAudioMuted = !localAudioMuted;
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !localAudioMuted;
            log(`Audio track enabled: ${track.enabled}`);
        });
        Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute_state', audio_muted: localAudioMuted, video_muted: localVideoMuted }));
        log(`Audio mute state updated: ${!localAudioMuted}`);
    }
    const toggleAudioBtn = document.getElementById('toggleAudio');
    toggleAudioBtn.className = `flex-1 p-3 rounded-lg flex items-center justify-center gap-2 transition transform hover:-translate-y-1 ${localAudioMuted ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'} text-white`;
    toggleAudioBtn.innerHTML = `<i class="${localAudioMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone'}"></i> ${localAudioMuted ? 'Unmute Audio' : 'Mute Audio'}`;
};

const toggleVideo = () => {
    localVideoMuted = !localVideoMuted;
    if (localStream) {
        localStream.getVideoTracks().forEach(track => {
            track.enabled = !localVideoMuted;
            log(`Video track enabled: ${track.enabled}`);
        });
        Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute_state', audio_muted: localAudioMuted, video_muted: localVideoMuted }));
        log(`Video mute state updated: ${!localVideoMuted}`);
    }
    const toggleVideoBtn = document.getElementById('toggleVideo');
    toggleVideoBtn.className = `flex-1 p-3 rounded-lg flex items-center justify-center gap-2 transition transform hover:-translate-y-1 ${localVideoMuted ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'} text-white`;
    toggleVideoBtn.innerHTML = `<i class="${localVideoMuted ? 'fas fa-video-slash' : 'fas fa-video'}"></i> ${localVideoMuted ? 'Enable Video' : 'Disable Video'}`;
};

const switchCamera = async () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(track => track.stop());
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: !isFrontCamera ? 'user' : 'environment' }
        });
        localStream = newStream;
        document.getElementById('localVideo').srcObject = newStream;
        document.getElementById('localVideo').play().catch(err => {
            log('Local video play error:', err);
            addStatus(`Local video error: ${err.message}`, true);
        });
        Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
        isFrontCamera = !isFrontCamera;
        isScreenSharing = false;
        addStatus(`Switched to ${isFrontCamera ? 'front' : 'rear'} camera`);
        updateScreenShareButton();
    } catch (err) {
        log('Error switching camera:', err);
        addStatus('Error switching camera', true);
    }
};

const toggleScreenShare = async () => {
    if (isScreenSharing) {
        localStream.getTracks().forEach(track => track.stop());
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: isFrontCamera ? 'user' : 'environment' }
            });
            localStream = newStream;
            document.getElementById('localVideo').srcObject = newStream;
            document.getElementById('localVideo').play().catch(err => {
                log('Local video play error:', err);
                addStatus(`Local video error: ${err.message}`, true);
            });
            Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
            isScreenSharing = false;
            addStatus('Screen sharing stopped');
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'screen_share', sharing: false }));
            }
        } catch (err) {
            log('Error stopping screen share:', err);
            addStatus('Error stopping screen share', true);
        }
    } else {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            localStream = screenStream;
            document.getElementById('localVideo').srcObject = screenStream;
            document.getElementById('localVideo').play().catch(err => {
                log('Local video play error:', err);
                addStatus(`Local video error: ${err.message}`, true);
            });
            Object.keys(pcs).forEach(peer => attachTracks(pcs[peer], peer));
            isScreenSharing = true;
            addStatus('Screen sharing started');
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'screen_share', sharing: true }));
            }
            screenStream.getVideoTracks()[0].onended = () => {
                toggleScreenShare();
            };
        } catch (err) {
            log('Error starting screen share:', err);
            addStatus('Error starting screen share', true);
        }
    }
    updateScreenShareButton();
};

const updateScreenShareButton = () => {
    const toggleScreenShareBtn = document.getElementById('toggleScreenShare');
    toggleScreenShareBtn.className = `flex-1 p-3 rounded-lg flex items-center justify-center gap-2 transition transform hover:-translate-y-1 ${isScreenSharing ? 'bg-red-500 hover:bg-red-600' : 'bg-teal-500 hover:bg-teal-600'} text-white`;
    toggleScreenShareBtn.innerHTML = `<i class="${isScreenSharing ? 'fas fa-stop' : 'fas fa-desktop'}"></i> ${isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}`;
};

const sendChatMessage = () => {
    const chatInput = document.getElementById('chatInput');
    const text = chatInput.value.trim();
    if (!text) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', from: name, text }));
        addChatMessage(name, text);
        chatInput.value = '';
    }
};

document.getElementById('joinButton').addEventListener('click', () => {
    roomId = document.getElementById('roomIdInput').value.trim();
    name = document.getElementById('nameInput').value.trim();
    if (!roomId || !name) {
        alert('Enter room ID and name');
        return;
    }
    document.getElementById('joinSection').classList.add('hidden');
    document.getElementById('roomSection').classList.remove('hidden');
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
    }
    connectWebSocket();
});

document.getElementById('toggleAudio').addEventListener('click', toggleAudio);
document.getElementById('toggleVideo').addEventListener('click', toggleVideo);
document.getElementById('switchCamera').addEventListener('click', switchCamera);
document.getElementById('toggleScreenShare').addEventListener('click', toggleScreenShare);
document.getElementById('sendChat').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChatMessage();
});