from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaStreamTrack
from models import JoinRoomRequest
import logging

logger = logging.getLogger("webrtc")
logger.setLevel(logging.DEBUG)  # DEBUG darajasiga o‘zgartirildi

class AudioStreamTrack(MediaStreamTrack):
    kind = "audio"
    def __init__(self, track):
        super().__init__()
        self.track = track
    async def recv(self):
        return await self.track.recv()

class VideoStreamTrack(MediaStreamTrack):
    kind = "video"
    def __init__(self, track):
        super().__init__()
        self.track = track
    async def recv(self):
        return await self.track.recv()

class WebRTCConnection:
    def __init__(self, roomid: str, name: str, room_manager=None):
        self.pc = RTCPeerConnection()
        self.name = name
        self.roomid = roomid
        self.room_manager = room_manager
        self.pc.on("track", self._on_track)
        self.pc.on("iceconnectionstatechange", self._on_ice_state_change)

    def _on_track(self, track):
        logger.debug("[%s] Received track: %s", self.name, track.kind)
        if track.kind == "audio":
            logger.info("[%s] audio track received", self.name)
            self.pc.addTrack(AudioStreamTrack(track))
        elif track.kind == "video":
            logger.info("[%s] video track received", self.name)
            self.pc.addTrack(VideoStreamTrack(track))
        else:
            logger.warning("Unknown track kind received: %s", track.kind)

    async def _on_ice_state_change(self):
        state = self.pc.iceConnectionState
        logger.info("[%s] ICE state: %s", self.name, state)
        if state in ["failed", "closed"] and self.room_manager:
            try:
                await self.room_manager.remove_user(JoinRoomRequest(roomid=self.roomid, name=self.name))
            except Exception as e:
                logger.debug("Failed to remove user %s on ICE state %s: %s", self.name, state, str(e))

    async def close(self):
        try:
            await self.pc.close()
            logger.debug("RTCPeerConnection closed for %s", self.name)
        except Exception as e:
            logger.debug("Failed to close RTCPeerConnection for %s: %s", self.name, str(e))