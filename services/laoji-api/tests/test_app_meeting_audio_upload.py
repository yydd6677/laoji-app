from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api import app_meetings


class ChunkedUpload:
    def __init__(self, content: bytes, filename: str = 'meeting.wav') -> None:
        self.content = content
        self.filename = filename
        self.content_type = 'audio/wav'
        self.offset = 0
        self.requested_sizes: list[int] = []

    async def read(self, size: int) -> bytes:
        self.requested_sizes.append(size)
        chunk = self.content[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk


class FakeDb:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.flushed = False

    async def flush(self) -> None:
        self.flushed = True
        if self.error:
            raise self.error


def meeting(audio_path: str | None = None):
    return SimpleNamespace(
        id='meeting-1',
        audio_path=audio_path,
        audio_file_name=None,
        audio_mime_type=None,
        audio_duration_sec=None,
        updated_at=None,
    )


@pytest.fixture
def upload_storage(tmp_path, monkeypatch):
    async def ignore_note_root(_db, _meeting):
        return None

    monkeypatch.setattr(app_meetings, '_storage_dir', lambda _user_id: tmp_path)
    monkeypatch.setattr(app_meetings, '_probe_duration_sec', lambda _path: 12.5)
    monkeypatch.setattr(app_meetings, 'touch_legacy_meeting_root', ignore_note_root)
    monkeypatch.setattr(app_meetings.settings, 'MEETING_AUDIO_CHUNK_BYTES', 4)
    monkeypatch.setattr(app_meetings.settings, 'MEETING_AUDIO_MAX_BYTES', 12)
    return tmp_path


@pytest.mark.asyncio
async def test_audio_upload_streams_in_bounded_chunks_and_sets_metadata(upload_storage):
    upload = ChunkedUpload(b'abcdefghij')
    record = meeting()
    db = FakeDb()

    target = await app_meetings._save_audio_file(record, 7, upload, db)

    assert target.read_bytes() == b'abcdefghij'
    assert upload.requested_sizes == [4, 4, 4, 4]
    assert record.audio_path == str(target)
    assert record.audio_file_name == 'meeting.wav'
    assert record.audio_duration_sec == 12.5
    assert db.flushed is True
    assert list(upload_storage.glob('*.part')) == []


@pytest.mark.asyncio
async def test_audio_upload_rejects_empty_file_without_persisting(upload_storage):
    with pytest.raises(HTTPException) as caught:
        await app_meetings._save_audio_file(meeting(), 7, ChunkedUpload(b''), FakeDb())

    assert caught.value.status_code == 400
    assert list(upload_storage.iterdir()) == []


@pytest.mark.asyncio
async def test_audio_upload_enforces_limit_and_keeps_existing_audio(upload_storage):
    old_path = upload_storage / 'old.wav'
    old_path.write_bytes(b'old')
    record = meeting(str(old_path))

    with pytest.raises(HTTPException) as caught:
        await app_meetings._save_audio_file(record, 7, ChunkedUpload(b'0123456789abc'), FakeDb())

    assert caught.value.status_code == 413
    assert old_path.read_bytes() == b'old'
    assert record.audio_path == str(old_path)
    assert list(upload_storage.glob('*.part')) == []


@pytest.mark.asyncio
async def test_audio_upload_removes_new_file_if_database_flush_fails(upload_storage):
    old_path = upload_storage / 'old.wav'
    old_path.write_bytes(b'old')
    record = meeting(str(old_path))

    with pytest.raises(RuntimeError, match='flush failed'):
        await app_meetings._save_audio_file(
            record,
            7,
            ChunkedUpload(b'new audio'),
            FakeDb(RuntimeError('flush failed')),
        )

    assert old_path.read_bytes() == b'old'
    assert not Path(record.audio_path).exists()
    assert sorted(path.name for path in upload_storage.iterdir()) == ['old.wav']
