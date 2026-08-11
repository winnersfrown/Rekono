import io

from app.models import Invoice, InvoiceStatus

from .conftest import auth_headers, signup


def _make_invoice(db, org_id, **overrides):
    defaults = dict(
        org_id=org_id,
        original_filename="test.pdf",
        storage_path="/tmp/does-not-matter.pdf",
        content_type="application/pdf",
        status=InvoiceStatus.EXTRACTED,
        vendor_name="Acme Supplies Inc",
        invoice_number="INV-1",
        total=1000.00,
        overall_confidence=0.95,
    )
    defaults.update(overrides)
    invoice = Invoice(**defaults)
    db.add(invoice)
    db.commit()
    db.refresh(invoice)
    return invoice


def _org_id(client, token):
    return client.get("/api/auth/me", headers=auth_headers(token)).json()["org_id"]


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_upload_rejects_unsupported_file_type(client):
    token = signup(client)
    res = client.post(
        "/api/invoices/upload",
        files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")},
        headers=auth_headers(token),
    )
    assert res.status_code == 422


def test_matching_upload_and_run(client):
    token = signup(client)
    org_id = _org_id(client, token)
    headers = auth_headers(token)

    db = client.db_sessionmaker()
    invoice = _make_invoice(db, org_id)
    db.close()

    csv_bytes = b"vendor,amount,date,reference\nAcme Supplies Inc,1000.00,2026-01-05,PO-1\n"
    res = client.post(
        "/api/matching/sources?source_type=po",
        files={"file": ("po.csv", io.BytesIO(csv_bytes), "text/csv")},
        headers=headers,
    )
    assert res.status_code == 201
    assert res.json()["entry_count"] == 1

    res = client.post("/api/matching/run", headers=headers)
    assert res.status_code == 200
    summary = res.json()
    assert summary["invoices_evaluated"] == 1
    assert summary["matched"] == 1

    res = client.get("/api/matching/results", headers=headers)
    assert res.status_code == 200
    results = res.json()
    assert results[0]["invoice_id"] == invoice.id
    assert results[0]["status"] == "matched"


def test_matching_source_requires_vendor_and_amount_columns(client):
    token = signup(client)
    csv_bytes = b"foo,bar\n1,2\n"
    res = client.post(
        "/api/matching/sources?source_type=bank",
        files={"file": ("bad.csv", io.BytesIO(csv_bytes), "text/csv")},
        headers=auth_headers(token),
    )
    assert res.status_code == 422


def test_export_csv(client):
    token = signup(client)
    org_id = _org_id(client, token)

    db = client.db_sessionmaker()
    _make_invoice(db, org_id)
    db.close()

    res = client.get("/api/export/csv", headers=auth_headers(token))
    assert res.status_code == 200
    assert "Acme Supplies Inc" in res.text


def test_invoice_correction_writes_audit_log(client):
    token = signup(client)
    org_id = _org_id(client, token)
    headers = auth_headers(token)

    db = client.db_sessionmaker()
    invoice = _make_invoice(db, org_id)
    db.close()

    res = client.patch(f"/api/invoices/{invoice.id}", json={"vendor_name": "Acme Corrected"}, headers=headers)
    assert res.status_code == 200
    assert res.json()["vendor_name"] == "Acme Corrected"

    res = client.get(f"/api/invoices/{invoice.id}/audit-log", headers=headers)
    actions = [entry["action"] for entry in res.json()]
    assert "human_correction" in actions


def test_approve_invoice(client):
    token = signup(client)
    org_id = _org_id(client, token)
    headers = auth_headers(token)

    db = client.db_sessionmaker()
    invoice = _make_invoice(db, org_id)
    db.close()

    res = client.post(f"/api/invoices/{invoice.id}/approve", headers=headers)
    assert res.status_code == 200
    assert res.json()["status"] == "approved"
