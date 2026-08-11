"""OCR extraction: turns a stored PDF/image into raw text.

Uses Tesseract (via pytesseract) since it's free and self-hosted, matching
the MVP's cost profile. Swapping in a cloud OCR API (AWS Textract / Google
Document AI) for higher accuracy on messy scans is a drop-in replacement at
this module's boundary — callers only depend on `extract_text`.
"""

from pathlib import Path

from PIL import Image


class OcrError(RuntimeError):
    pass


def extract_text(storage_path: str, content_type: str) -> str:
    path = Path(storage_path)
    if not path.exists():
        raise OcrError(f"File not found: {storage_path}")

    if content_type == "application/pdf" or path.suffix.lower() == ".pdf":
        return _extract_from_pdf(path)
    return _extract_from_image(path)


def _extract_from_image(path: Path) -> str:
    import pytesseract

    with Image.open(path) as img:
        return pytesseract.image_to_string(img)


def _extract_from_pdf(path: Path) -> str:
    import pytesseract
    from pdf2image import convert_from_path

    try:
        pages = convert_from_path(str(path))
    except Exception as exc:  # poppler not installed, encrypted pdf, etc.
        raise OcrError(f"Failed to rasterize PDF for OCR: {exc}") from exc

    text_parts = []
    for page_image in pages:
        text_parts.append(pytesseract.image_to_string(page_image))
    return "\n".join(text_parts)
