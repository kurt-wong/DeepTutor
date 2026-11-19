"""C1 阻断修复 — QCore 学习记录进原生 LearningProgress/LearningStore。

验证：身份双键、未判分纪律、幂等、Revision 错配、错题合法闸、
原生 SRS 状态（RepetitionState）、中间表历史转录。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from deeptutor.learning.models import ErrorRecord, LearningEvidence, QuizAttempt
from deeptutor.learning.storage import LearningStore
from deeptutor.services.practice.qc_learning import (
    QC_BOOK_ID,
    DEFAULT_KNOWLEDGE_TYPE,
    QcLearningStore,
    ReviewConflict,
    state_key,
)
from deeptutor.services.practice.storage_qc import QCorePracticeStore


@pytest.fixture()
def store(tmp_path):
    return QcLearningStore(LearningStore(root=tmp_path / "learning"))


def test_submission_lands_in_native_progress(store):
    out = store.record_submission("q1", "r1", "req-1", 0, "good", "u1:A")
    assert out["correct"] is None and out["graded"] is False
    att = store.attempts("q1")
    assert len(att) == 1
    qa = att[0]
    assert qa.revision_id == "r1" and qa.source_type == "qcore"
    assert qa.is_correct is None and qa.result is None
    assert qa.user_answer == "u1:A"
    ev = store.evidence("q1")
    assert len(ev) == 1
    assert ev[0].result == "ungraded" and ev[0].revision_id == "r1"
    # 原生 SRS 状态（RepetitionState）落位，非平行表
    st = store.repetition_state("q1", "r1")
    assert st is not None and st.review_count == 1
    assert st.next_review_at > 0
    # 聚合内不存题面/参考答案
    progress, _ = store._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
    dumped = progress.model_dump(mode="json")
    import json
    blob = json.dumps(dumped, ensure_ascii=False)
    assert "stem_blocks" not in blob and "correct_answer" not in blob


def test_native_srs_read_paths(store):
    """原生 SRS/Mastery 可读：replay 重算 + review_queue 构建。"""
    from deeptutor.learning.review_strategy import scheduler_for_progress

    store.record_submission("q1", "r1", "req-1", 0, "good", "A")
    progress, _ = store._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
    scheduler = scheduler_for_progress(progress)
    ordered = [e for e in progress.learning_evidence if e.question_id == "q1"]
    replayed = scheduler.replay(
        DEFAULT_KNOWLEDGE_TYPE, ordered, desired_retention=progress.desired_retention
    )
    assert replayed.review_count == 1
    queue = scheduler.build_review_queue(progress)
    assert any(t.knowledge_point_id == state_key("q1", "r1") for t in queue)


def test_identity_is_question_and_revision(store):
    store.record_submission("q1", "r1", "req-1", 0, "good", "A")
    store.record_submission("q1", "r2", "req-2", 0, "good", "B")
    assert {a.revision_id for a in store.attempts("q1")} == {"r1", "r2"}
    assert store.repetition_state("q1", "r1") is not None
    assert store.repetition_state("q1", "r2") is not None
    # 历史 Revision 状态不被新 Revision 覆盖
    assert store.state("q1", "r1")["version"] == 1
    assert store.state("q1", "r2")["version"] == 1


def test_idempotent_request_id(store):
    a = store.record_submission("q1", "r1", "req-x", 0, "good", "A")
    b = store.record_submission("q1", "r1", "req-x", 0, "good", "A")
    assert a["version"] == b["version"] == 1
    assert b.get("idempotent_replay") is True
    assert len(store.attempts("q1")) == 1
    assert len(store.evidence("q1")) == 1


def test_version_conflict(store):
    store.record_submission("q1", "r1", "req-1", 0, "good", "A")
    with pytest.raises(ReviewConflict):
        store.record_submission("q1", "r1", "req-2", 0, "good", "A")


def test_m1_request_id_binds_identity(store):
    """M1：request_id↔(qid,rid) 全局绑定；身份不符 fail-closed 且零副作用。"""
    from deeptutor.services.practice.qc_learning import RequestIdentityConflict

    # 1) 首次提交：绑定三元身份
    a = store.record_submission("q1", "r1", "req-m1", 0, "good", "A")
    assert a.get("idempotent_replay") is None
    assert a["question_id"] == "q1" and a["revision_id"] == "r1"

    # 2) 合法重复：三者一致 → 返回首次结果，不重复写入
    b = store.record_submission("q1", "r1", "req-m1", 0, "good", "A")
    assert b.get("idempotent_replay") is True
    assert b["question_id"] == "q1" and b["revision_id"] == "r1"
    assert len(store.attempts()) == 1

    att_before = len(store.attempts())
    ev_before = len(store.evidence())
    st_before = store.state("q2", "r2")

    # 3) request_id 同、question_id 不同 → 拒绝
    with pytest.raises(RequestIdentityConflict):
        store.record_submission("q2", "r2", "req-m1", 0, "good", "B")
    # 4) request_id 同、revision_id 不同 → 拒绝
    with pytest.raises(RequestIdentityConflict):
        store.record_submission("q1", "r2", "req-m1", 0, "good", "C")

    # 冲突零副作用：Attempt/Evidence/SRS 状态均不变
    assert len(store.attempts()) == att_before
    assert len(store.evidence()) == ev_before
    assert store.state("q2", "r2") == st_before
    assert store.state("q1", "r2")["version"] == 0

    # request_id 形态约束（422 语义源）
    with pytest.raises(ValueError):
        store.record_submission("q1", "r1", "", 0, "good", "A")
    with pytest.raises(ValueError):
        store.record_submission("q1", "r1", "x" * 129, 0, "good", "A")


def test_ungraded_never_creates_error_record(store):
    store.record_submission("q1", "r1", "req-1", 0, "again", "A")
    store.record_submission("q1", "r1", "req-2", 1, "good", "B")
    assert store.errors("q1") == []


def test_ungraded_not_consumed_as_formal_result(store):
    """M3：未判分自评不得被当成正式判分/掌握度证据消费。"""
    from deeptutor.learning.policy import learning_stage

    store.record_submission("q1", "r1", "req-1", 0, "again", "A")
    store.record_submission("q1", "r1", "req-2", 1, "easy", "B")
    progress, _ = store._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
    qa = store.attempts("q1")[0]
    assert qa.is_correct is None  # 非 True/False
    # learning_stage 的正确性判定不命中（is_correct None 为假值），
    # 未判分作答只能进入"练过未证明"，绝非"独立掌握"
    assert learning_stage(progress, "") == "practiced_not_demonstrated"
    assert store.errors() == []  # 零正式错题


def test_error_record_legal_gate(store):
    assert store.record_error("q1", "r1", "req-1", legal_grade=False, is_correct=False) is None
    assert store.record_error("q1", "r1", "req-1", legal_grade=True, is_correct=True) is None
    rec = store.record_error("q1", "r1", "req-1", legal_grade=True, is_correct=False)
    assert rec is not None and rec.revision_id == "r1" and rec.attempt_id == "req-1"
    assert len(store.errors("q1")) == 1
    store.record_error("q1", "r1", "req-1", legal_grade=True, is_correct=False)
    assert len(store.errors("q1")) == 1  # 幂等


def test_interim_migration_into_native_aggregate(tmp_path):
    db = str(tmp_path / "chat_history.db")
    spike = QCorePracticeStore(db)
    spike.review("q1", "r1", "spike-1", 0, "good", "A")
    spike.review("q2", "r2", "spike-2", 0, "again", "B")
    store = QcLearningStore(LearningStore(root=tmp_path / "learning"))
    res = store.migrate_interim_rows(db_path=db)
    assert res["migrated"] == 2
    assert {a.visual_context["request_id"] for a in store.attempts()} == {"spike-1", "spike-2"}
    assert all(a.revision_id for a in store.attempts())
    assert all(e.result == "ungraded" for e in store.evidence())
    # 中间表原样冻结
    assert len(spike.events()) == 2
    # 幂等
    assert store.migrate_interim_rows(db_path=db)["migrated"] == 0


def test_models_express_ungraded_and_revision():
    qa = QuizAttempt(question_id="q", revision_id="r", source_type="qcore", is_correct=None)
    assert qa.result is None
    qa2 = QuizAttempt(question_id="q", revision_id="r", is_correct=False)
    assert qa2.result == "incorrect"
    ev = LearningEvidence(question_id="q", revision_id="r", result="ungraded")
    assert ev.result == "ungraded"
    er = ErrorRecord(id="e", question_id="q", revision_id="r", attempt_id="a", error_type="deviation")
    assert er.revision_id == "r" and er.attempt_id == "a"
    with pytest.raises(ValidationError):
        QuizAttempt(question_id="q", is_correct="not-a-bool")


def test_revision_mismatch_guard(monkeypatch):
    import io
    import json as _j

    import fastapi

    from deeptutor.api.routers import practice as practice_router

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(url, timeout=15):
        return _Resp(_j.dumps({"revision_id": "r-current"}).encode())

    monkeypatch.setattr(practice_router._urlrequest, "urlopen", fake_urlopen)
    with pytest.raises(fastapi.HTTPException) as ei:
        practice_router._verify_current_revision("q1", "r-stale")
    assert ei.value.status_code == 409
    practice_router._verify_current_revision("q1", "r-current")
