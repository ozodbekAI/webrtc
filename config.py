class Config:
    """STUN + TURN configuration sent to clients"""
    ICE_SERVERS = [
        {
            "urls": [
                "stun:stun.l.google.com:19302",
                "turn:37.60.253.214:3478?transport=udp",
                "turn:37.60.253.214:3478?transport=tcp"
            ],
            "username": "abdujabborov",
            "credential": "abdujabborovoybek"
        }
    ]