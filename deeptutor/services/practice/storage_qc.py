"""QCore-sourced practice review lane (B-2 Spike) — **FROZEN ARCHIVE (C1 阶段2)**.

自 C1 阶段2 起，新 QCore 学习事件的事实源= ``qc_learning.py``（原生
QuizAttempt/LearningEvidence/ErrorRecord）；本模块表 ``practice_review_*_qc``
**停止接收新写入**，仅保留 B-2 历史数据（2 条）供审计追溯。禁止双写。

Parallel to :mod:`deeptutor.services.practice.storage`, keyed by
``(question_id, revision_id)`` instead of ``entry_id``.

Hard boundaries (QCORE-STUDENT-PHASE-B2-SPIKE):
- Question content is NEVER stored here — content flows from the Student API
  per request. Tables carry identity + review state + the learner's own answer;
  never question text, reference answers, or explanations.
- Attempts are recorded as *answered but ungraded*: ``correct`` is always NULL
  for this lane (no reference answers exist under ``review_only``). Correctness
  is never fabricated and ``submitted=true`` is never treated as answer
  authorisation.
- No fallback to ``notebook_entries``: this lane never reads or writes the old
  question bank.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from .scheduler import Rating, schedule

_DDL = """
CREATE TABLE IF NOT EXISTS practice_review_state_qc (
    question_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    is_mistake INTEGER NOT NULL DEFAULT 0,
    first_wrong_at REAL,
    due_at REAL,
    interval_days REAL NOT NULL DEFAULT 1,
    ease REAL NOT NULL DEFAULT 2.5,
    streak INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    last_review_at REAL,
    version INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (question_id, revision_id)
);
CREATE TABLE IF NOT EXISTS practice_review_events_qc (
    request_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    reviewed_at REAL NOT NULL,
    correct INTEGER,
    outcome_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_events_qc_identity
    ON practice_review_events_qc (question_id, revision_id, reviewed_at);
"""


class ReviewConflict(Exception):
    """Optimistic-lock failure on ``version``."""


class QCorePracticeStore:
    def __init__(self, db_path: str):
        self.db_path = db_path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(_DDL)
        return conn

    def state(self, question_id: str, revision_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM practice_review_state_qc WHERE question_id=? AND revision_id=?",
                (question_id, revision_id),
            ).fetchone()
        return dict(row) if row else {"version": 0, "review_count": 0}

    def review(
        self,
        question_id: str,
        revision_id: str,
        request_id: str,
        version: int,
        rating: Rating,
        answer: str,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        now = time.time() if now is None else now
        with self.connect() as conn:
            prior = conn.execute(
                "SELECT outcome_json FROM practice_review_events_qc WHERE request_id=?",
                (request_id,),
            ).fetchone()
            if prior is not None:
                return json.loads(prior["outcome_json"])
            row = conn.execute(
                "SELECT * FROM practice_review_state_qc WHERE question_id=? AND revision_id=?",
                (question_id, revision_id),
            ).fetchone()
            state = dict(row) if row else {"version": 0}
            if state["version"] != version:
                raise ReviewConflict(
                    "This question changed in another tab. Reload it before reviewing again."
                )
            # Hard boundary: never fabricate correctness. Under review_only no
            # reference answer is available to the student lane, so the attempt
            # is recorded as answered-but-ungraded.
            correct = None
            next_state = schedule(state, rating, now)
            mistake = bool(state.get("is_mistake")) or rating == "again"
            conn.execute(
                """
                INSERT INTO practice_review_state_qc(question_id, revision_id, is_mistake,
                    first_wrong_at, due_at, interval_days, ease, streak, lapses,
                    review_count, last_review_at, version)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(question_id, revision_id) DO UPDATE SET
                    is_mistake=excluded.is_mistake,
                    due_at=excluded.due_at,
                    first_wrong_at=CASE
                        WHEN practice_review_state_qc.is_mistake=0 AND excluded.is_mistake=1
                        THEN excluded.first_wrong_at
                        ELSE practice_review_state_qc.first_wrong_at END,
                    interval_days=excluded.interval_days, ease=excluded.ease,
                    streak=excluded.streak, lapses=excluded.lapses,
                    review_count=excluded.review_count, last_review_at=excluded.last_review_at,
                    version=excluded.version
                """,
                (
                    question_id,
                    revision_id,
                    int(mistake),
                    now,
                    next_state["due_at"],
                    next_state["interval_days"],
                    next_state["ease"],
                    next_state["streak"],
                    next_state["lapses"],
                    next_state["review_count"],
                    next_state["last_review_at"],
                    next_state["version"],
                ),
            )
            outcome = {
                **next_state,
                "question_id": question_id,
                "revision_id": revision_id,
                "is_mistake": mistake,
                "correct": correct,
                "graded": False,
                "grade_reason": "review_only_no_reference",
                "rating": rating,
                "self_report": True,
                "mastered": rating in {"good", "easy"},
            }
            conn.execute(
                "INSERT INTO practice_review_events_qc"
                " (request_id, question_id, revision_id, rating, answer, reviewed_at, correct,"
                "  outcome_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    request_id or uuid.uuid4().hex,
                    question_id,
                    revision_id,
                    rating,
                    answer,
                    now,
                    correct,
                    json.dumps(outcome, ensure_ascii=False),
                ),
            )
        return outcome

    def events(self, question_id: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if question_id is None:
                rows = conn.execute(
                    "SELECT * FROM practice_review_events_qc ORDER BY reviewed_at"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM practice_review_events_qc WHERE question_id=?"
                    " ORDER BY reviewed_at",
                    (question_id,),
                ).fetchall()
        return [dict(row) for row in rows]
