"""File ingestion helpers.

MVP scope: accepts direct file uploads (PDF or image) and normalizes/stores
them on local disk. Email-inbox and watched-folder/Drive ingestion are noted
in the README roadmap as additive front-ends to the same `save_upload` +
job-queue pipeline used here — they are not wired up in this MVP.
"""

from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile

from .config import get_settings

ACCEPTED_CONTENT_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/tiff",
    "image/bmp",
    "image/webp",
}

ACCEPTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


class UnsupportedFileType(ValueError):
    pass


def is_supported(filename: str, content_type: str | None) -> bool:
    ext = Path(filename).suffix.lower()
    if ext in ACCEPTED_EXTENSIONS:
        return True
    return bool(content_type and content_type.lower() in ACCEPTED_CONTENT_TYPES)


def save_upload(file: UploadFile) -> tuple[str, str]:
    """Persist an uploaded file to the storage dir.

    Returns (storage_path, content_type). Raises UnsupportedFileType for
    anything that isn't a PDF or a common image format, since those are the
    two normalized formats the extraction layer accepts.
    """
    if not is_supported(file.filename or "", file.content_type):
        raise UnsupportedFileType(
            f"Unsupported file type: {file.filename!r} ({file.content_type!r}). "
            "Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp)."
        )

    settings = get_settings()
    storage_dir = Path(settings.storage_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(file.filename or "upload").suffix.lower() or ".bin"
    dest_name = f"{uuid4().hex}{ext}"
    dest_path = storage_dir / dest_name

    with dest_path.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            out.write(chunk)
    file.file.close()

    content_type = file.content_type or "application/octet-stream"
    return str(dest_path), content_type
