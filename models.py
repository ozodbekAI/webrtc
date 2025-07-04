from pydantic import BaseModel, Field
from uuid import uuid4

class JoinRoomRequest(BaseModel):
    roomid: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)