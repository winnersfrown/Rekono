"""A minimal in-process async job queue.

The architecture doc calls for "even just a simple job queue... so
processing is async and doesn't block." For the MVP that's a background
worker thread pulling off a stdlib queue.Queue -- no Redis/broker required to
run the demo. Swapping this module for Celery/RQ (self-hosted) or SQS
(cloud) later is a drop-in replacement: callers only touch `enqueue`.
"""

import logging
import queue
import threading

from .pipeline import process_invoice

logger = logging.getLogger("rekono.jobs")

_queue: "queue.Queue[str]" = queue.Queue()
_worker_thread: threading.Thread | None = None
_lock = threading.Lock()


def enqueue(invoice_id: str) -> None:
    _queue.put(invoice_id)


def _worker_loop() -> None:
    while True:
        invoice_id = _queue.get()
        try:
            process_invoice(invoice_id)
        except Exception:  # noqa: BLE001 - the worker thread must survive any single job failing
            logger.exception("Unhandled error processing invoice %s", invoice_id)
        finally:
            _queue.task_done()


def start_worker() -> None:
    global _worker_thread
    with _lock:
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _worker_thread = threading.Thread(target=_worker_loop, name="rekono-worker", daemon=True)
        _worker_thread.start()


def queue_depth() -> int:
    return _queue.qsize()
