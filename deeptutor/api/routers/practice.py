"""Practice workflow. Every operation resolves the current user's scoped store."""

from __future__ import annotations

import asyncio
import csv
import io
import os
import time
from typing import Literal
import zipfile

from defusedxml.ElementTree import ParseError
from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from deeptutor.services.practice.answers import check_answer
from deeptutor.services.practice.importing import MAX_BYTES, preview
from deeptutor.services.practice.scheduler import Rating, day_bounds
from deeptutor.services.practice.storage import PracticeStore, ReviewConflict
from deeptutor.services.session import get_sqlite_session_store

from .question_notebook import NotebookEntryItem

router = APIRouter()


class PracticeSummary(BaseModel):
    total: int
    mistakes: int
    due: int
    overdue: int
    reviewed_today: int
    next_due_at: float | None
    day_end: float
    timezone: str


class PracticeQuestion(BaseModel):
    entry: NotebookEntryItem
    state: dict
    content_workspace_id: str = ""
    content_workspace_name: str = ""


class PracticeCounts(BaseModel):
    questions: int
    mistakes: int
    reviews: int


class PracticeDailyCounts(PracticeCounts):
    date: str


class PracticeSourceCounts(PracticeCounts):
    source: str


class PracticeAnalytics(BaseModel):
    timezone: str
    days: int
    start_date: str
    end_date: str
    updated_at: float
    daily: list[PracticeDailyCounts]
    sources: list[PracticeSourceCounts]
    totals: PracticeCounts


class AnswerRequest(BaseModel):
    answer: str = Field(default="", max_length=20000)


class ReviewRequest(AnswerRequest):
    self_report: bool = False
    request_id: str = Field(min_length=16, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    version: int = Field(ge=0)
    rating: Rating


class CommitRequest(BaseModel):
    token: str = Field(min_length=32, max_length=32, pattern=r"^[a-f0-9]+$")


def _validate_timezone(timezone: str) -> tuple[float, float]:
    try:
        return day_bounds(timezone, time.time())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def _entry(entry_id: int) -> dict:
    store = get_sqlite_session_store()
    if not await asyncio.to_thread(PracticeStore(store.db_path).is_visible, entry_id):
        raise HTTPException(404, "Question not found")
    entry = await store.get_notebook_entry(entry_id)
    if entry is None:
        raise HTTPException(404, "Question not found")
    return entry


@router.get("/summary", response_model=PracticeSummary)
async def summary(timezone: str = "UTC"):
    store = get_sqlite_session_store()
    try:
        return await asyncio.to_thread(PracticeStore(store.db_path).overview, timezone)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/queue", response_model=list[PracticeQuestion])
async def queue(
    timezone: str = "UTC",
    category_id: int | None = None,
    limit: int = Query(default=20, ge=1, le=100),
):
    store = get_sqlite_session_store()
    practice = PracticeStore(store.db_path)
    try:
        ids = await asyncio.to_thread(practice.queue, timezone, category_id, limit)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    from deeptutor.services.workspace.context import current_workspace_id

    questions = []
    for entry_id in ids:
        entry = await store.get_notebook_entry(entry_id)
        if entry:
            questions.append(
                {
                    "entry": entry,
                    "state": await asyncio.to_thread(practice.state, entry_id),
                    "content_workspace_id": current_workspace_id(),
                }
            )
    return questions


@router.get("/analytics", response_model=PracticeAnalytics)
async def practice_analytics(timezone: str = "UTC", days: int = 30):
    _validate_timezone(timezone)
    if days not in {7, 30, 90}:
        raise HTTPException(422, "Days must be 7, 30, or 90")
    store = get_sqlite_session_store()
    try:
        return await asyncio.to_thread(PracticeStore(store.db_path).analytics, timezone, days)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/questions/{entry_id}", response_model=PracticeQuestion)
async def practice_question(entry_id: int):
    entry = await _entry(entry_id)
    state = await asyncio.to_thread(
        PracticeStore(get_sqlite_session_store().db_path).state, entry_id
    )
    return {"entry": entry, "state": state}


@router.post("/questions/{entry_id}/check")
async def check(entry_id: int, payload: AnswerRequest):
    entry = await _entry(entry_id)
    return {"correct": check_answer(entry, payload.answer)}


@router.post("/questions/{entry_id}/review")
async def review(entry_id: int, payload: ReviewRequest):
    try:
        return await asyncio.to_thread(
            PracticeStore(get_sqlite_session_store().db_path).review,
            entry_id,
            payload.request_id,
            payload.version,
            payload.rating,
            payload.answer,
            self_report=payload.self_report,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ReviewConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class QcReviewRequest(BaseModel):
    request_id: str = Field(min_length=1)
    question_id: str = Field(min_length=1)
    revision_id: str = Field(min_length=1)
    version: int
    rating: Rating
    answer: str = ""


# ---- QCore Student API 同源透传（B-2 Spike） --------------------------------
# 浏览器直连 :8811 受 CORS 限制（部署入口白名单不含 :3782），故由后端 verbatim
# 代理：数据源仍是 8811 Student API（唯一题目读取通道），零 QC 侧改动、零内容落库。
import urllib.parse as _urlparse
import urllib.request as _urlrequest

QCORE_STUDENT_API_BASE = os.environ.get("QCORE_STUDENT_API_BASE", "http://127.0.0.1:8811")


def _qcore_proxy_get(path: str):
    url = QCORE_STUDENT_API_BASE + path
    try:
        with _urlrequest.urlopen(url, timeout=15) as resp:
            body = resp.read()
            return Response(content=body, media_type="application/json")
    except _urlrequest.HTTPError as exc:
        # 上游状态码（如 404=未发布不可读取）原样透传，不得吞成 502。
        return Response(
            content=exc.read(), status_code=exc.code, media_type="application/json"
        )
    except Exception as exc:  # noqa: BLE001 — 网络级不可达才报 502
        raise HTTPException(502, f"qcore student api unreachable: {exc}") from exc


@router.get("/qcore/proxy/student/questions")
async def proxy_qcore_questions():
    return _qcore_proxy_get("/student/questions")


@router.get("/qcore/proxy/student/questions/{question_id}")
async def proxy_qcore_question(question_id: str, submitted: bool = False):
    q = f"?submitted={'true' if submitted else 'false'}"
    return _qcore_proxy_get(
        f"/student/questions/{_urlparse.quote(question_id)}{q}"
    )


# ---- PBA 隔离验收通道（QCORE-PRE-BULK-OWNER-ACCEPTANCE-01） ----------------
# 与 qcore/proxy 同构的 verbatim 透传，指向**隔离验收库 API 实例**（:8813）。
# 用途=Owner 目视验收候选数据；不触正式 :8811 与 qcore_g4_final_01。
QCORE_ACCEPTANCE_API_BASE = os.environ.get(
    "QCORE_ACCEPTANCE_API_BASE", "http://127.0.0.1:8813"
)


def _acceptance_proxy_get(path: str):
    url = QCORE_ACCEPTANCE_API_BASE + path
    try:
        with _urlrequest.urlopen(url, timeout=15) as resp:
            return Response(content=resp.read(), media_type="application/json")
    except _urlrequest.HTTPError as exc:
        return Response(content=exc.read(), status_code=exc.code, media_type="application/json")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"acceptance api unreachable: {exc}") from exc


@router.get("/qcore-acceptance/proxy/student/questions")
async def proxy_acceptance_questions():
    return _acceptance_proxy_get("/student/questions")


@router.get("/qcore-acceptance/proxy/student/questions/{question_id}")
async def proxy_acceptance_question(question_id: str, submitted: bool = False):
    q = f"?submitted={'true' if submitted else 'false'}"
    return _acceptance_proxy_get(
        f"/student/questions/{_urlparse.quote(question_id)}{q}"
    )


# ---- PBA-R1 候选读取通道（含未发布/未完成候选，验收可见性≠学生可见性） ----
# 指向隔离验收候选读取服务（:8814，只读，绑定 qcore_prebulk_accept_01）。
# 用途=Owner 目视验收 64 道候选；不触正式 :8811/发布过滤/正式库。
QCORE_CANDIDATES_API_BASE = os.environ.get(
    "QCORE_CANDIDATES_API_BASE", "http://127.0.0.1:8814"
)


def _candidates_proxy_get(path: str):
    url = QCORE_CANDIDATES_API_BASE + path
    try:
        with _urlrequest.urlopen(url, timeout=15) as resp:
            return Response(content=resp.read(), media_type="application/json")
    except _urlrequest.HTTPError as exc:
        return Response(content=exc.read(), status_code=exc.code, media_type="application/json")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"acceptance candidates api unreachable: {exc}") from exc


@router.get("/qcore-candidates/proxy/student/questions")
async def proxy_candidates_questions():
    return _candidates_proxy_get("/student/questions")


@router.get("/qcore-candidates/proxy/student/questions/{question_id}")
async def proxy_candidates_question(question_id: str, submitted: bool = False):
    q = f"?submitted={'true' if submitted else 'false'}"
    return _candidates_proxy_get(
        f"/student/questions/{_urlparse.quote(question_id)}{q}"
    )


@router.get("/qcore/state/{question_id}")
async def qcore_state(question_id: str, revision_id: str):
    """Review state for a QCore identity (question_id + revision_id)."""
    from deeptutor.services.practice.qc_learning import QcLearningStore

    return await asyncio.to_thread(
        QcLearningStore().state,
        question_id,
        revision_id,
    )


def _verify_current_revision(question_id: str, revision_id: str) -> None:
    """Revision 错配守卫：以 Student API 当前发布版本为准（唯一题目事实源）。

    提交的 revision_id 必须等于当前可读 Question 的 revision_id，否则拒绝，
    防止把作答误记到错误/过期 Revision。
    """
    import json as _j

    try:
        with _urlrequest.urlopen(
            f"{QCORE_STUDENT_API_BASE}/student/questions/{_urlparse.quote(question_id)}",
            timeout=15,
        ) as resp:
            data = _j.loads(resp.read())
    except _urlrequest.HTTPError as exc:
        if exc.code == 404:
            raise HTTPException(409, "question revision not readable (unpublished or missing)")
        raise HTTPException(502, f"qcore student api error: {exc.code}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"qcore student api unreachable: {exc}") from exc
    current = str(data.get("revision_id") or "")
    if current and current != revision_id:
        raise HTTPException(
            409,
            f"revision mismatch: submitted {revision_id[:8]}… but current is {current[:8]}…",
        )


@router.post("/qcore/review")
async def qcore_review(payload: QcReviewRequest):
    """Record a QCore practice submission as NATIVE learning records (C1 阶段2).

    一次有效提交 → QuizAttempt(is_correct=None 未判分) + LearningEvidence
    (result='ungraded') + 原生 SM-2 状态更新；身份=(question_id, revision_id)。
    review_only：不产生官方判分、不创建 ErrorRecord。幂等键=request_id。
    """
    from deeptutor.services.practice.qc_learning import (
        QcLearningStore,
        RequestIdentityConflict,
        ReviewConflict,
    )

    _verify_current_revision(payload.question_id, payload.revision_id)
    try:
        return await asyncio.to_thread(
            QcLearningStore().record_submission,
            payload.question_id,
            payload.revision_id,
            payload.request_id,
            payload.version,
            payload.rating,
            payload.answer,
        )
    except RequestIdentityConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ReviewConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/import/template")
async def import_template(format: Literal["csv", "xlsx"] = "csv"):
    rows = [
        [
            "question",
            "question_type",
            "A",
            "B",
            "C",
            "D",
            "correct_answer",
            "explanation",
            "tags",
            "user_answer",
        ],
        ["2 + 2 = ?", "single_choice", "3", "4", "5", "6", "B", "2 + 2 = 4", "Math,Addition", ""],
        [
            "Select the prime numbers",
            "multi_choice",
            "2",
            "3",
            "4",
            "6",
            "A,B",
            "2 and 3 are prime",
            "Math",
            "",
        ],
        ["The Earth orbits the Sun", "true_false", "", "", "", "", "true", "", "Science", ""],
        [
            "Explain photosynthesis",
            "short_answer",
            "",
            "",
            "",
            "",
            "Plants convert light into chemical energy.",
            "",
            "Biology",
            "",
        ],
    ]
    if format == "xlsx":
        from openpyxl import Workbook

        book = Workbook()
        for row in rows:
            book.active.append(row)
        output = io.BytesIO()
        book.save(output)
        book.close()
        data = output.getvalue()
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        output = io.StringIO(newline="")
        csv.writer(output).writerows(rows)
        data, media = output.getvalue().encode("utf-8-sig"), "text/csv"
    return Response(
        data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="practice-template.{format}"'},
    )


@router.post("/import/preview")
async def import_preview(
    file: UploadFile = File(...),
    target: Literal["bank", "mistakes"] = Form("bank"),
):
    try:
        data = await file.read(MAX_BYTES + 1)
        parsed = await asyncio.to_thread(preview, data, file.filename or "")
    except (ValueError, UnicodeError, OSError, zipfile.BadZipFile, KeyError, ParseError) as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        await file.close()
    token = None
    if not parsed["errors"]:
        token = await asyncio.to_thread(
            PracticeStore(get_sqlite_session_store().db_path).stage_import,
            file.filename or "",
            target,
            parsed["questions"],
        )
    return {
        "token": token,
        "total": len(parsed["questions"]) + len(parsed["errors"]),
        "valid": len(parsed["questions"]),
        "errors": parsed["errors"],
        "samples": parsed["questions"][:5],
    }


@router.post("/import/commit")
async def import_commit(payload: CommitRequest):
    try:
        return await asyncio.to_thread(
            PracticeStore(get_sqlite_session_store().db_path).commit_import, payload.token
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
