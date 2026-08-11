import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "storage"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    from app.config import get_settings

    get_settings.cache_clear()

    from app.database import Base, get_db
    from app import main

    test_engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False}
    )
    TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)
    Base.metadata.create_all(bind=test_engine)

    def override_get_db():
        db = TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = override_get_db

    from fastapi.testclient import TestClient

    with TestClient(main.app) as test_client:
        test_client.db_sessionmaker = TestSessionLocal
        yield test_client

    main.app.dependency_overrides.clear()
    get_settings.cache_clear()
