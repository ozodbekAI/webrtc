from fastapi import WebSocket
from webrtc import WebRTCConnection
from models import JoinRoomRequest
from websockets.exceptions import ConnectionClosed
from config import Config
import logging
import asyncio

logger = logging.getLogger("room")
logger.setLevel(logging.DEBUG)

class RoomManager:
    def __init__(self):
        self.rooms: dict[str, list[dict]] = {}
        self._lock = asyncio.Lock()

    async def add_user(self, ws: WebSocket, join: JoinRoomRequest):
        async with self._lock:
            logger.debug("Adding user %s to room %s", join.name, join.roomid)
            if join.roomid in self.rooms:
                for user in self.rooms[join.roomid][:]:
                    if user["name"] == join.name:
                        logger.info("User %s already in room %s, removing old connection", join.name, join.roomid)
                        await user["webrtc"].close()
                        if user["websocket"].client_state != 2:
                            try:
                                await user["websocket"].close(code=1000)
                            except Exception as e:
                                logger.debug("Failed to close old WebSocket for %s: %s", join.name, str(e))
                        self.rooms[join.roomid].remove(user)
            self.rooms.setdefault(join.roomid, []).append({
                "websocket": ws,
                "name": join.name,
                "webrtc": WebRTCConnection(join.roomid, join.name, self),
                "audio_muted": False,
                "video_muted": False
            })
        try:
            await self._broadcast_state(join.roomid)
            await ws.send_json({"type": "ice_servers", "ice_servers": Config.ICE_SERVERS})
            logger.debug("Sent ICE servers to %s", join.name)
        except ConnectionClosed:
            logger.info("WebSocket closed during add_user for %s in %s", join.name, join.roomid)
            await self.remove_user(join)
        except Exception as e:
            logger.debug("Error sending ICE servers to %s: %s", join.name, str(e))
            await self.remove_user(join)

    async def remove_user(self, join: JoinRoomRequest):
        async with self._lock:
            logger.debug("Removing user %s from room %s", join.name, join.roomid)
            users = self.rooms.get(join.roomid, [])
            for user in users[:]:
                if user["name"] == join.name:
                    await user["webrtc"].close()
                    if user["websocket"].client_state != 2:
                        try:
                            await user["websocket"].close(code=1000)
                        except Exception as e:
                            logger.debug("Failed to close WebSocket for %s: %s", join.name, str(e))
                    users.remove(user)
                    break
            self.rooms[join.roomid] = users
            if not self.rooms[join.roomid]:
                self.rooms.pop(join.roomid, None)
                logger.debug("Room %s is empty, removed", join.roomid)
            else:
                await self._broadcast_state(join.roomid)

    async def _broadcast_state(self, roomid: str):
        if roomid not in self.rooms:
            logger.debug("No users in room %s, skipping broadcast", roomid)
            return
        payload = {
            "type": "room_state",
            "users": [
                {
                    "name": u["name"],
                    "audio_muted": u["audio_muted"],
                    "video_muted": u["video_muted"]
                } for u in self.rooms[roomid]
            ]
        }
        logger.debug("Broadcasting room state for %s: %s", roomid, payload)
        for u in self.rooms[roomid][:]:
            if u["websocket"].client_state != 2:
                try:
                    await u["websocket"].send_json(payload)
                except ConnectionClosed:
                    logger.info("WebSocket closed for %s during broadcast", u["name"])
                    await self.remove_user(JoinRoomRequest(roomid=roomid, name=u["name"]))
                except Exception as e:
                    logger.debug("Failed to broadcast to %s: %s", u["name"], str(e))

    async def handle(self, join: JoinRoomRequest, msg: dict):
        roomid, sender = join.roomid, join.name
        if roomid not in self.rooms:
            logger.warning("Room %s not found for message from %s", roomid, sender)
            return
        if msg.get("type") not in {"offer", "answer", "ice_candidate", "mute_state", "chat"}:
            logger.warning("Invalid message type from %s: %s", sender, msg.get("type"))
            return

        logger.debug("Handling message from %s: %s", sender, msg)
        if msg["type"] == "mute_state":
            async with self._lock:
                for u in self.rooms[roomid]:
                    if u["name"] == sender:
                        u["audio_muted"] = msg.get("audio_muted", u["audio_muted"])
                        u["video_muted"] = msg.get("video_muted", u["video_muted"])
                        logger.info("Updated mute state for %s: audio=%s, video=%s", sender, u["audio_muted"], u["video_muted"])
                        break
                await self._broadcast_state(roomid)
            return
        elif msg["type"] == "chat":
            for u in self.rooms[roomid][:]:
                if u["websocket"].client_state != 2:
                    try:
                        await u["websocket"].send_json({
                            "type": "chat",
                            "from": sender,
                            "text": msg.get("text")
                        })
                    except ConnectionClosed:
                        logger.info("WebSocket closed for %s during chat broadcast", u["name"])
                        await self.remove_user(JoinRoomRequest(roomid=roomid, name=u["name"]))
                    except Exception as e:
                        logger.debug("Failed to send chat to %s: %s", u["name"], str(e))
            return

        target = msg.get("to")
        for u in self.rooms[roomid][:]:
            if (msg["type"] == "offer" and u["name"] != sender) or (msg["type"] != "offer" and u["name"] == target):
                if u["websocket"].client_state != 2:
                    try:
                        await u["websocket"].send_json({
                            "type": msg["type"],
                            "sdp": msg.get("sdp"),
                            "candidate": msg.get("candidate"),
                            "from": sender,
                        })
                    except ConnectionClosed:
                        logger.info("WebSocket closed for %s during message handling", u["name"])
                        await self.remove_user(JoinRoomRequest(roomid=roomid, name=u["name"]))
                    except Exception as e:
                        logger.debug("Failed to send message to %s: %s", u["name"], str(e))