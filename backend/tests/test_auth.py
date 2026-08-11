import io

from .conftest import auth_headers as _auth_headers
from .conftest import signup as _signup


def test_signup_creates_org_and_returns_token(client):
    token = _signup(client)
    assert token

    res = client.get("/api/auth/me", headers=_auth_headers(token))
    assert res.status_code == 200
    me = res.json()
    assert me["email"] == "owner@example.co"
    assert me["role"] == "owner"
    assert me["org_id"]


def test_signup_duplicate_email_rejected(client):
    _signup(client, email="dupe@example.co")
    res = client.post(
        "/api/auth/signup",
        json={"org_name": "Another Org", "full_name": "Someone Else", "email": "dupe@example.co", "password": "anotherpassword123"},
    )
    assert res.status_code == 409


def test_login_wrong_password_rejected(client):
    _signup(client, email="loginuser@example.co", password="correctpassword123")
    res = client.post("/api/auth/login", json={"email": "loginuser@example.co", "password": "wrongpassword"})
    assert res.status_code == 401


def test_login_success_returns_token(client):
    _signup(client, email="loginuser2@example.co", password="correctpassword123")
    res = client.post("/api/auth/login", json={"email": "loginuser2@example.co", "password": "correctpassword123"})
    assert res.status_code == 200
    assert res.json()["access_token"]


def test_endpoints_reject_missing_or_invalid_token(client):
    res = client.get("/api/invoices")
    assert res.status_code == 401

    res = client.get("/api/invoices", headers=_auth_headers("not-a-real-token"))
    assert res.status_code == 401


def test_orgs_cannot_see_each_others_invoices(client):
    token_a = _signup(client, email="alice@orga.co", org_name="Org A")
    token_b = _signup(client, email="bob@orgb.co", org_name="Org B")

    upload = client.post(
        "/api/invoices/upload",
        files={"file": ("invoice.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")},
        headers=_auth_headers(token_a),
    )
    assert upload.status_code == 201
    invoice_id = upload.json()["id"]

    # Org B's list is empty -- doesn't see org A's invoice.
    res = client.get("/api/invoices", headers=_auth_headers(token_b))
    assert res.status_code == 200
    assert res.json() == []

    # Org B can't fetch org A's invoice directly by id either.
    res = client.get(f"/api/invoices/{invoice_id}", headers=_auth_headers(token_b))
    assert res.status_code == 404

    # Org B can't approve it.
    res = client.post(f"/api/invoices/{invoice_id}/approve", headers=_auth_headers(token_b))
    assert res.status_code == 404

    # Org A can see its own invoice.
    res = client.get("/api/invoices", headers=_auth_headers(token_a))
    assert res.status_code == 200
    assert len(res.json()) == 1
