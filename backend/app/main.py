from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .database import init_db
from .jobs import start_worker
from .routers import export, ingestion, invoices, matching

app = FastAPI(title="Rekono", description="AI-powered invoice ingestion, extraction, and reconciliation.")

app.include_router(ingestion.router)
app.include_router(invoices.router)
app.include_router(matching.router)
app.include_router(export.router)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    start_worker()


@app.get("/api/health")
def health():
    return {"status": "ok"}


static_dir = Path(__file__).resolve().parent.parent / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
