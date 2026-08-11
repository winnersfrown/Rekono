"""Generates a sample invoice PDF for local demos/testing.

Requires reportlab (not a runtime dependency of Rekono itself):
    pip install reportlab
    python sample_data/generate_sample_invoice.py
"""

from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

OUT_PATH = Path(__file__).parent / "sample_invoice.pdf"


def build_pdf(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=letter)
    width, height = letter
    y = height - 72

    def line(text, size=10, dy=16, font="Helvetica"):
        nonlocal y
        c.setFont(font, size)
        c.drawString(72, y, text)
        y -= dy

    line("Acme Supplies Inc", size=16, font="Helvetica-Bold")
    line("123 Main St, Springfield, IL 62704")
    y -= 10
    line("Invoice #: INV-2026-0007")
    line("Date: 01/15/2026")
    line("PO Number: PO-4421")
    y -= 10

    line("Description               Qty   Unit Price   Amount", font="Helvetica-Bold")
    line("Widget A                   2        10.00       20.00")
    line("Widget B                   1        30.00       30.00")
    y -= 10
    line("Subtotal: $50.00")
    line("Tax: $4.00")
    line("Total Due: $54.00", size=12, font="Helvetica-Bold")

    c.showPage()
    c.save()


if __name__ == "__main__":
    build_pdf(OUT_PATH)
    print(f"Wrote {OUT_PATH}")
