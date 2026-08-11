from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .database import init_db
from .jobs import start_worker
from .routers import auth, export, ingestion, invoices, matching

app = FastAPI(title="Rekono", description="AI-powered invoice ingestion, extraction, and reconciliation.")

# The marketing site (GitHub Pages) and the app (wherever it's deployed) are
# different origins, so the browser needs CORS to let the marketing site's
# login/signup calls reach this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
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
