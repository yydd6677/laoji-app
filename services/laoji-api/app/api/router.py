from fastapi import APIRouter

from app.api import app_attachment_v1, app_marker_v1, app_meeting_v2, app_meetings, app_recording_v2, app_speakers, app_summary_v1, device_v1, device_v2, location
from app.laoji.auth_router import router as auth_router
from app.laoji.router import router as laoji_router

api_router = APIRouter()

api_router.include_router(device_v1.router, tags=["device-v1"])
api_router.include_router(device_v2.router, tags=["device-v2"])

api_router.include_router(auth_router, prefix="/auth", tags=["auth"])
api_router.include_router(location.router, prefix="/location", tags=["location"])
api_router.include_router(laoji_router, prefix="/laoji", tags=["laoji"])
api_router.include_router(app_meetings.router, prefix="/laoji/meetings", tags=["laoji-meetings"])
api_router.include_router(app_speakers.router, prefix="/laoji/speakers", tags=["laoji-speakers"])
api_router.include_router(app_meeting_v2.router, prefix="/laoji", tags=["laoji-v2"])
api_router.include_router(app_recording_v2.router, prefix="/laoji", tags=["laoji-recording-v2"])
api_router.include_router(app_attachment_v1.router, prefix="/laoji", tags=["laoji-attachment-v1"])
api_router.include_router(app_marker_v1.router, prefix="/laoji", tags=["laoji-marker-v1"])
api_router.include_router(app_summary_v1.router, prefix="/laoji", tags=["laoji-summary-v1"])
