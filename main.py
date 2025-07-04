from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from room_manager import RoomManager
import json
import logging

logging.basicConfig(level=logging.DEBUG)  # DEBUG darajasiga o‘zgartirildi
logger = logging.getLogger("server")

app = FastAPI(title="Voice & Video Conference Backend")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="static")

room_manager = RoomManager()

class JoinRoomRequest(BaseModel):
    roomid: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    try:
        logger.debug("Rendering index.html for request: %s", request)
        return templates.TemplateResponse("index.html", {"request": request})
    except Exception as e:
        logger.exception("Template render error: %s", str(e))
        raise HTTPException(500, "Template render error")

@app.websocket("/ws/{roomid}/{name}")
async def ws_endpoint(ws: WebSocket, roomid: str, name: str):
    await ws.accept()
    join = JoinRoomRequest(roomid=roomid, name=name)
    logger.debug("WebSocket accepted for %s in room %s", name, roomid)
    try:
        await room_manager.add_user(ws, join)
        logger.info("New connection: %s in room %s", name, roomid)
        while True:
            try:
                msg = json.loads(await ws.receive_text())
                logger.debug("Received message from %s: %s", name, msg)
                await room_manager.handle(join, msg)
            except WebSocketDisconnect:
                logger.info("%s disconnected from %s", name, roomid)
                await room_manager.remove_user(join)
                break
    except Exception as e:
        logger.exception("WebSocket error for %s in %s: %s", name, roomid, str(e))
    finally:
        logger.debug("Cleaning up WebSocket for %s in %s", name, roomid)
        await room_manager.remove_user(join)