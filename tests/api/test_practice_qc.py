"""B-2 Spike — QCore practice lane tests (identity keys, ungraded attempts, no content)."""

from __future__ import annotations

import sqlite3

import pytest

from deeptutor.services.practice.storage_qc import QCorePracticeStore, ReviewConflict


@pytest.fixture()
def store(tmp_path):
    return QCorePracticeStore(str(tmp_path / "practice_qc.db"))


def test_review_keys_on_question_and_revision(store):
    out = store.review("q1", "r1", "req-1", 0, "good", "B")
    assert out["question_id"] == "q1"
    assert out["revision_id"] == "r1"
    assert out["version"] == 1
    state = store.state("q1", "r1")
    assert state["version"] == 1
    # 同 question 不同 revision 是独立身份
    store.review("q1", "r2", "req-2", 0, "good", "B")
    assert store.state("q1", "r2")["version"] == 1
    assert store.state("q1", "r1")["version"] == 1


def test_attempts_are_ungraded_and_never_fabricated(store):
    out = store.review("q1", "r1", "req-1", 0, "good", "A")
    assert out["correct"] is None
    assert out["graded"] is False
    assert out["grade_reason"] == "review_only_no_reference"
    events = store.events("q1")
    assert len(events) == 1
    assert events[0]["correct"] is None
    assert events[0]["revision_id"] == "r1"


def test_review_is_idempotent_by_request_id(store):
    a = store.review("q1", "r1", "req-x", 0, "good", "A")
    b = store.review("q1", "r1", "req-x", 0, "good", "A")
    assert a == b
    assert store.state("q1", "r1")["version"] == 1
    assert len(store.events("q1")) == 1


def test_version_conflict_raises(store):
    store.review("q1", "r1", "req-1", 0, "good", "A")
    with pytest.raises(ReviewConflict):
        store.review("q1", "r1", "req-2", 0, "good", "A")  # stale version 0


def test_sm2_schedule_reused(store):
    out = store.review("q1", "r1", "req-1", 0, "good", "A")
    assert out["due_at"] > 0
    assert out["interval_days"] >= 1.0
    assert out["review_count"] == 1
    out2 = store.review("q1", "r1", "req-2", out["version"], "easy", "A")
    assert out2["review_count"] == 2


def test_no_question_content_or_reference_answer_stored(store):
    """硬边界（表述口径）：作答记录**不保存题目正文、参考答案和解析**；
    **允许保存学员提交的答案**与必要作答状态（学习记录所需）；
    判分保持未判分（correct=NULL）。"""
    store.review("q1", "r1", "req-1", 0, "good", "my-answer-text")
    with store.connect() as conn:
        for table in ("practice_review_state_qc", "practice_review_events_qc"):
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
            joined = " ".join(cols).lower()
            assert "question" not in joined.replace("question_id", "")
            assert "stem" not in joined and "options" not in joined and "explanation" not in joined
            assert "correct_answer" not in joined
        blob = conn.execute(
            "SELECT outcome_json FROM practice_review_events_qc"
        ).fetchone()[0]
        answer_col = conn.execute(
            "SELECT answer FROM practice_review_events_qc"
        ).fetchone()[0]
    # answer 列=学员自己的作答（允许保存，学习记录所需）；
    # 表结构与 outcome_json 均无题目正文/参考答案/解析
    assert answer_col == "my-answer-text"
    assert "my-answer-text" not in blob
    # 题面/参考答案绝不出现（本 lane 无来源）
    assert "stem_blocks" not in blob and "correct_answer" not in blob


def test_notebook_tables_untouched(store):
    """QCore 车道不读写 notebook_entries（无旧题库回退）。"""
    with store.connect() as conn:
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert "notebook_entries" not in tables
