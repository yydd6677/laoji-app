from fastapi import APIRouter

from app.api import device_v1, device_v2, device_v2_realtime, device_v2_speakers, location

api_router = APIRouter()

api_router.include_router(device_v1.router, tags=["device-v1"])
api_router.include_router(device_v2.router, tags=["device-v2"])
api_router.include_router(device_v2_realtime.router, tags=["device-v2-realtime"])
api_router.include_router(device_v2_speakers.router, tags=["device-v2-speakers"])

api_router.include_router(location.router, prefix="/location", tags=["location"])
