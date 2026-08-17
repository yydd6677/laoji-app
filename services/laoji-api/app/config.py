import ast
import os
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, model_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ENV: str = "development"

    DATABASE_URL: str = ""

    # VAD 与中文 CAM++ 模型目录；相对路径统一以 backend/ 为基准解析。
    CAMPPLUS_MODEL_DIR: str = ""
    LOCAL_MODEL_DIR: str = ""
    LOCAL_DEVICE: str = "cuda"

    SPEAKER_SIMILARITY_THRESHOLD: float = 0.6
    SPEAKER_MIN_CONFIDENCE: float = 0.5
    SPEAKER_VOTE_WINDOWS: int = 3
    PERIOD_SUMMARY_INTERVAL_SECONDS: float = 60.0

    AUDIO_STORAGE_PATH: str = "./audio_files"
    VNEXT_REALTIME_SPOOL_PATH: str = "./data/vnext-realtime-spool"
    VNEXT_SPEAKER_SPOOL_PATH: str = "./data/vnext-speaker-spool"
    MEETING_AUDIO_MAX_BYTES: int = Field(default=1024 * 1024 * 1024, ge=1024 * 1024)
    MEETING_AUDIO_CHUNK_BYTES: int = Field(
        default=4 * 1024 * 1024,
        ge=64 * 1024,
        le=16 * 1024 * 1024,
    )

    # Optional direct object-storage upload path.  It is deliberately
    # fail-closed: an incomplete R2 configuration advertises the legacy
    # device upload contract instead of returning unusable presigned URLs.
    R2_ENABLED: bool = False
    R2_ACCOUNT_ID: str = ""
    R2_BUCKET: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    R2_ENDPOINT_URL: str = ""
    R2_PRESIGN_TTL_SECONDS: int = Field(default=3600, ge=60, le=604800)
    R2_PART_SIZE: int = Field(default=8 * 1024 * 1024, ge=5 * 1024 * 1024, le=128 * 1024 * 1024)
    R2_UPLOAD_SESSION_TTL_HOURS: int = Field(default=24, ge=1, le=168)

    SECRET_KEY: str = "change-me-in-production"
    CORS_ORIGINS: str = '["http://localhost","http://localhost:5179"]'

    @property
    def audio_storage_abs_path(self) -> str:
        """获取音频存储目录的绝对路径"""
        if os.path.isabs(self.AUDIO_STORAGE_PATH):
            return self.AUDIO_STORAGE_PATH
        return os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            self.AUDIO_STORAGE_PATH
        )

    @property
    def vnext_realtime_spool_abs_path(self) -> str:
        if os.path.isabs(self.VNEXT_REALTIME_SPOOL_PATH):
            return self.VNEXT_REALTIME_SPOOL_PATH
        return os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            self.VNEXT_REALTIME_SPOOL_PATH,
        )

    @property
    def vnext_speaker_spool_abs_path(self) -> str:
        if os.path.isabs(self.VNEXT_SPEAKER_SPOOL_PATH):
            return self.VNEXT_SPEAKER_SPOOL_PATH
        return os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            self.VNEXT_SPEAKER_SPOOL_PATH,
        )

    @model_validator(mode="after")
    def apply_local_defaults(self):
        environment = self.ENV.strip().lower()
        if environment == "local":
            if not self.DATABASE_URL:
                db_path = os.path.join(
                    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "local.db",
                )
                self.DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
            if not self.AUDIO_STORAGE_PATH or self.AUDIO_STORAGE_PATH == "./audio_files":
                self.AUDIO_STORAGE_PATH = "./audio_files"
        if environment == "production":
            if self.SECRET_KEY == "change-me-in-production" or len(self.SECRET_KEY) < 32:
                raise ValueError("production SECRET_KEY must be a non-default value of at least 32 characters")
            try:
                origins = ast.literal_eval(self.CORS_ORIGINS)
            except (SyntaxError, ValueError) as exc:
                raise ValueError("production CORS_ORIGINS must be a list") from exc
            if not isinstance(origins, list) or any(not isinstance(origin, str) for origin in origins):
                raise ValueError("production CORS_ORIGINS must be a list of strings")
            if "*" in origins:
                raise ValueError("production CORS_ORIGINS must not contain a wildcard")
            if any(not origin.startswith("https://") for origin in origins):
                raise ValueError("production CORS origins must use HTTPS")
        return self


settings = Settings()
