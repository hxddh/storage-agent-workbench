"""Tasks: the one submit path, the snapshot, and the live stream.

A Task is a tree of Turns; the page reads one branch (the chain from the
task's head to the root). Every mutation goes through the runtime — there is
no second submit path. The stream is resumable by the global item seq.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .. import config
from ..agent import tracing
from ..agent.runtime import RUNTIME
from ..core import hub, store
from ..db import connect, get_conn
from ..engines import datasets
from ..reports import report

router = APIRouter(prefix="/tasks", tags=["tasks"])
events_router = APIRouter(tags=["events"])

MAX_DIRECTION_CHARS = 16_000
_RESYNC_SECONDS = 10.0
_HIDDEN_FIELDS = ("model_output",)  # what the model read; the UI reads `detail`


def public_item(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("payload")
    if isinstance(payload, dict) and any(k in payload for k in _HIDDEN_FIELDS):
        item = {**item, "payload": {k: v for k, v in payload.items() if k not in _HIDDEN_FIELDS}}
    return item


class TaskIn(BaseModel):
    direction: str | None = Field(default=None, max_length=MAX_DIRECTION_CHARS)
    title: str | None = Field(default=None, max_length=120)
    origin: str = Field(default="user", pattern="^(user|quick_ask)$")


class TaskPatch(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class TurnIn(BaseModel):
    direction: str = Field(min_length=1, max_length=MAX_DIRECTION_CHARS)
    # Omitted: continue from the head. A turn id: a new version after that turn
    # (a fork). "" : a new first Direction (a fork at the root).
    parent_turn_id: str | None = None
    attachments: list[str] = Field(default_factory=list, max_length=20)


class SteerIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_DIRECTION_CHARS)


class HeadIn(BaseModel):
    turn_id: str


def _task_or_404(conn: Any, task_id: str) -> dict[str, Any]:
    task = store.get_task(conn, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


def _seed_title(direction: str) -> str:
    line = " ".join((direction or "").split())
    return (line[:60] + "…") if len(line) > 60 else (line or "New task")


def _attachments(conn: Any, task_id: str, ids: list[str]) -> list[dict[str, Any]]:
    out = []
    for did in ids:
        ds = datasets.get(conn, did)
        if ds is None or ds["task_id"] != task_id:
            raise HTTPException(status_code=422, detail="unknown attachment for this task")
        out.append({"dataset_id": ds["id"], "filename": ds["filename"], "type": ds["dataset_type"]})
    return out


def snapshot(conn: Any, task_id: str) -> dict[str, Any]:
    task = _task_or_404(conn, task_id)
    chain = store.branch(conn, task_id)
    items = [public_item(i) for i in store.items_for_turns(conn, [t["id"] for t in chain])]
    forks = {parent: kids for parent, kids in store.siblings(conn, task_id).items() if len(kids) > 1}
    active = store.active_turns(conn, task_id)
    last = store.head_status(conn, task_id)
    running = next((t["id"] for t in active if t["status"] == "running"), None)
    queued = [t for t in active if t["status"] == "queued"]
    return {
        "task": task,
        "state": store.task_state("running" if running else ("queued" if queued else None),
                                  last),
        "running_turn_id": running,
        "queued": [{"turn_id": t["id"], "direction": t["direction"], "created_at": t["created_at"]} for t in queued],
        "turns": [store.turn_public(t) for t in chain],
        "head_turn_id": task["head_turn_id"],
        "items": items,
        "forks": forks,
        "live": hub.live_snapshot(task_id),
        "files": [_file_out(d) for d in datasets.list_for_task(conn, task_id)],
        "artifacts": [{k: a[k] for k in ("id", "kind", "title", "turn_id", "provider_id", "created_at")}
                      for a in store.list_artifacts(conn, task_id)],
        "last_seq": store.last_seq(conn, task_id),
    }


def _file_out(d: dict[str, Any]) -> dict[str, Any]:
    return {"id": d["id"], "origin": d["origin"], "type": d["dataset_type"], "filename": d["filename"],
            "size_bytes": d["size_bytes"], "rows": d.get("row_count"), "status": d["status"],
            "bucket": d.get("bucket"), "created_at": d["created_at"]}


# --- collection -----------------------------------------------------------------------

@router.get("")
def list_tasks(q: str | None = Query(default=None, max_length=200), conn: Any = Depends(get_conn)) -> dict[str, Any]:
    return {"tasks": [{k: t[k] for k in ("id", "title", "title_source", "origin", "state", "created_at",
                                         "updated_at")} for t in store.list_tasks(conn, query=q)]}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_task(body: TaskIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    """A new task; with a Direction it starts working at once."""
    direction = (body.direction or "").strip()
    task = store.create_task(conn, body.title or _seed_title(direction), origin=body.origin)
    hub.publish_global("task", {"task_id": task["id"], "state": "ready", "title": task["title"], "created": True})
    if direction:
        RUNTIME.submit(conn, task["id"], direction)
    return snapshot(conn, task["id"])


@router.get("/{task_id}")
def get_task(task_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    return snapshot(conn, task_id)


@router.patch("/{task_id}")
def rename_task(task_id: str, body: TaskPatch, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    store.rename_task(conn, task_id, body.title, source="user")
    store.audit(conn, actor="user", action="task.rename", task_id=task_id)
    task = store.get_task(conn, task_id)
    hub.publish_global("task", {"task_id": task_id, "title": task["title"]})
    return task  # type: ignore[return-value]


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: str, conn: Any = Depends(get_conn)) -> Response:
    _task_or_404(conn, task_id)
    RUNTIME.stop(task_id)
    store.delete_task(conn, task_id)
    store.audit(conn, actor="user", action="task.delete", task_id=task_id)
    shutil.rmtree(config.data_dir() / "tasks" / task_id, ignore_errors=True)
    hub.publish_global("task", {"task_id": task_id, "deleted": True})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- work -----------------------------------------------------------------------------

@router.post("/{task_id}/turns", status_code=status.HTTP_202_ACCEPTED)
def submit(task_id: str, body: TurnIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    """Delegate a Direction. Queued behind running work; with parent_turn_id, a fork."""
    _task_or_404(conn, task_id)
    if body.parent_turn_id:
        parent = store.get_turn(conn, body.parent_turn_id)
        if parent is None or parent["task_id"] != task_id:
            raise HTTPException(status_code=422, detail="unknown parent turn")
    attachments = _attachments(conn, task_id, body.attachments)
    turn = RUNTIME.submit(conn, task_id, body.direction.strip(), parent_turn_id=body.parent_turn_id,
                          attachments=attachments or None)
    return {"turn_id": turn["id"], "status": turn["status"]}


@router.post("/{task_id}/steer")
def steer(task_id: str, body: SteerIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    out = RUNTIME.steer(conn, task_id, body.text.strip())
    return {"steered": out["steered"], "turn_id": out.get("turn_id") or out["turn"]["id"]}


@router.post("/{task_id}/stop")
def stop(task_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return {"stopping": RUNTIME.stop(task_id)}


@router.delete("/{task_id}/turns/{turn_id}")
def cancel_queued(task_id: str, turn_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    if not RUNTIME.cancel_queued(conn, task_id, turn_id):
        raise HTTPException(status_code=409, detail="only a queued Direction can be withdrawn")
    return {"cancelled": True}


@router.post("/{task_id}/turns/{turn_id}/resume", status_code=status.HTTP_202_ACCEPTED)
def resume(task_id: str, turn_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    if RUNTIME.is_running(task_id):
        raise HTTPException(status_code=409, detail="the task is working")
    turn = RUNTIME.resume(conn, task_id, turn_id)
    if turn is None:
        raise HTTPException(status_code=409, detail="nothing to resume")
    return {"turn_id": turn["id"], "status": turn["status"]}


@router.put("/{task_id}/head")
def switch_branch(task_id: str, body: HeadIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    """Read another version of a Direction: the head moves to the tip of that branch."""
    _task_or_404(conn, task_id)
    turn = store.get_turn(conn, body.turn_id)
    if turn is None or turn["task_id"] != task_id:
        raise HTTPException(status_code=404, detail="turn not found")
    store.set_head(conn, task_id, store.leaf_of(conn, task_id, body.turn_id))
    return snapshot(conn, task_id)


# --- files, outputs -------------------------------------------------------------------

@router.post("/{task_id}/files", status_code=status.HTTP_201_CREATED)
async def upload(task_id: str, file: UploadFile = File(...), dataset_type: str = Form("auto"),
                 conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    if dataset_type not in ("auto", *datasets.TYPES):
        raise HTTPException(status_code=422, detail="dataset_type must be auto, access_log or inventory")

    def save() -> dict[str, Any]:
        fh = file.file
        head = fh.read(64 * 1024)
        fh.seek(0)
        kind = dataset_type if dataset_type != "auto" else datasets.sniff_type(file.filename or "", head)
        return datasets.save_upload(conn, task_id, file.filename or "upload", kind,
                                    iter(lambda: fh.read(1024 * 1024), b""))

    try:
        ds = await asyncio.to_thread(save)
    except ValueError as exc:
        raise HTTPException(status_code=413 if "2 GiB" in str(exc) else 422, detail=str(exc)) from exc
    kind = ds["dataset_type"]
    store.audit(conn, actor="user", action="file.upload", task_id=task_id, target=ds["filename"],
                detail={"type": kind, "bytes": ds["size_bytes"]})
    return _file_out(ds)


@router.get("/{task_id}/files")
def list_files(task_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return {"files": [_file_out(d) for d in datasets.list_for_task(conn, task_id)]}


@router.get("/{task_id}/artifacts/{artifact_id}")
def get_artifact(task_id: str, artifact_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM artifacts WHERE id = ? AND task_id = ?", (artifact_id, task_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="artifact not found")
    return {k: row[k] for k in ("id", "kind", "title", "turn_id", "provider_id", "created_at")} | {
        "payload": store.loads(row["payload"])}


@router.get("/{task_id}/report", response_class=PlainTextResponse)
def get_report(task_id: str, lang: str = Query(default="en", pattern="^(en|zh)$"),
               conn: Any = Depends(get_conn)) -> str:
    _task_or_404(conn, task_id)
    return report.render(conn, task_id, lang=lang)


@router.get("/{task_id}/trace")
def get_trace(task_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    _task_or_404(conn, task_id)
    return tracing.otel_export(conn, task_id)


# --- live -----------------------------------------------------------------------------

def _sse(kind: str, data: Any, seq: int | None = None) -> dict[str, Any]:
    out = {"event": kind, "data": json.dumps(data, ensure_ascii=False, default=str)}
    if seq is not None:
        out["id"] = str(seq)
    return out


@router.get("/{task_id}/events")
async def follow(task_id: str, request: Request, after: int = Query(default=0, ge=0)) -> EventSourceResponse:
    """Durable items after ``after``, then everything live: items, deltas, state.

    Subscribe first, then replay, so nothing lands in the gap; items are
    de-duplicated by seq. A follower that fell behind re-syncs from the table.
    """
    conn = connect()
    try:
        _task_or_404(conn, task_id)
    finally:
        conn.close()
    loop = asyncio.get_running_loop()
    # Subscribe and read the live segment in one step: a delta is either in the
    # snapshot or in the queue, never both.
    sub, live = hub.subscribe_with_live(task_id, loop)

    def replay(since: int) -> list[dict[str, Any]]:
        """Every durable item after ``since``, however many (read in pages)."""
        c = connect()
        out: list[dict[str, Any]] = []
        try:
            while True:
                page = store.items_after(c, task_id, since)
                out.extend(page)
                if len(page) < 2000:
                    return out
                since = page[-1]["seq"]
        finally:
            c.close()

    async def stream() -> AsyncIterator[dict[str, Any]]:
        last = after
        try:
            for it in await asyncio.to_thread(replay, last):
                last = it["seq"]
                yield _sse("item", public_item(it), it["seq"])
            yield _sse("live", live)
            # State is not durable: a follower (re)connecting reads it now, so a
            # turn that settled while it was away never stays "working".
            c = connect()
            try:
                yield _sse("state", store.state_payload(c, task_id))
            finally:
                c.close()
            while True:
                if await request.is_disconnected():
                    return
                try:
                    kind, data = await asyncio.wait_for(sub.queue.get(), timeout=_RESYNC_SECONDS)
                except TimeoutError:
                    for it in await asyncio.to_thread(replay, last):
                        last = it["seq"]
                        yield _sse("item", public_item(it), it["seq"])
                    continue
                if kind == "item":
                    if data["seq"] <= last:
                        continue
                    if sub.queue.qsize() == 0 and data["seq"] > last:
                        # Fill any gap a full queue may have dropped.
                        for it in await asyncio.to_thread(replay, last):
                            if it["seq"] < data["seq"]:
                                last = it["seq"]
                                yield _sse("item", public_item(it), it["seq"])
                    last = data["seq"]
                    yield _sse("item", public_item(data), data["seq"])
                else:
                    yield _sse(kind, data)
        finally:
            hub.unsubscribe(task_id, sub)

    return EventSourceResponse(stream(), ping=15)


@events_router.get("/events")
async def follow_all(request: Request) -> EventSourceResponse:
    """Every task's state, title and lifecycle — the sidebar and the tray."""
    loop = asyncio.get_running_loop()
    sub = hub.subscribe(None, loop)

    async def stream() -> AsyncIterator[dict[str, Any]]:
        try:
            yield _sse("hello", {"ok": True})
            while True:
                if await request.is_disconnected():
                    return
                try:
                    kind, data = await asyncio.wait_for(sub.queue.get(), timeout=_RESYNC_SECONDS)
                except TimeoutError:
                    continue
                yield _sse(kind, data)
        finally:
            hub.unsubscribe(None, sub)

    return EventSourceResponse(stream(), ping=15)
