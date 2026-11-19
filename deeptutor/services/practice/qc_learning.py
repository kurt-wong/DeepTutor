"""QCore Practice 学习记录 — **原生 LearningProgress / LearningStore 承接**
（C1 阻断修复轮：DSH FAIL 项 B1「qc_* 平行存储」的整改）。

持久化去处 = DeepTutor 原生学习聚合（learning/storage.py::LearningStore，
``mastery_paths`` 表中的 LearningProgress JSON）：
    quiz_attempts    ← QuizAttempt（revision_id/source_type，is_correct=None 未判分）
    learning_evidence← LearningEvidence（result="ungraded"，学员自评 quality）
    repetition_states← RepetitionState（原生 SpacedRepetitionScheduler；键=qcore:<qid>:<rid>）
    error_records    ← ErrorRecord（仅合法判分且答错时）
    review_queue     ← scheduler.build_review_queue（原生 SRS 读出路径）

**不是**第二套事实源：B-2 的 ``practice_review_*_qc`` 与 C1 中期 ``qc_*`` 表
均为冻结中间态（历史行经 migrate_interim_rows 一次性转录进聚合）。

未判分纪律（§3.3）：
- result 恒 "ungraded"、is_correct 恒 None —— 绝不伪造对错；
- ``_resolved_quality`` 对 result=ungraded 会按 0.0 处理，故 SRS 质量一律走
  **学员自评声明值**（quality 字段，rating 映射），不触发正确/错误推断；
- 无合法判分依据不建 ErrorRecord、不进正确率/掌握度。
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from deeptutor.learning.models import ErrorRecord, KnowledgeType, LearningEvidence, QuizAttempt
from deeptutor.learning.review_strategy import scheduler_for_progress
from deeptutor.learning.storage import LearningStore

# book_id 约束（storage._validate_id）：禁 ":"、"/"、"\\"、".."。
QC_BOOK_ID = "qcore-practice"
#: 未映射题目使用 CONCEPT 调度档位（interval/difficulty 档位参数，
#: **不是**知识点映射；knowledge_point_id 保持空串，映射待 NLP 知识层）。
DEFAULT_KNOWLEDGE_TYPE = KnowledgeType.CONCEPT
#: 学员自评（自检路径 again/hard/good/easy）→ 声明质量（非系统判分）。
QUALITY_BY_RATING: dict[str, float] = {"again": 0.15, "hard": 0.4, "good": 0.75, "easy": 1.0}


class ReviewConflict(Exception):
    """Optimistic-lock failure on submitted version (== review_count)."""


class RequestIdentityConflict(Exception):
    """M1：request_id 已绑定其他 (question_id, revision_id)，fail-closed 拒绝。"""


class RevisionMismatch(Exception):
    """Submitted revision_id is not the currently published revision."""


def state_key(question_id: str, revision_id: str) -> str:
    return f"qcore:{question_id}:{revision_id}"


class QcLearningStore:
    """QCore Practice 提交 → 原生学习记录（单一事实源）。

    ``store`` 为可注入的 LearningStore（测试用独立 root）；缺省用工作区原生店。
    """

    def __init__(self, store: LearningStore | None = None):
        if store is not None and not isinstance(store, LearningStore):
            raise TypeError("store must be a LearningStore (native aggregate), got %r" % type(store))
        self._store = store or LearningStore()

    # ---- 读：原生聚合中的复习状态 ----------------------------------------
    def state(self, question_id: str, revision_id: str) -> dict[str, Any]:
        progress, _ = self._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
        st = progress.repetition_states.get(state_key(question_id, revision_id))
        if st is None:
            return {"version": 0, "review_count": 0, "is_mistake": False, "due_at": None}
        return {
            "version": st.review_count,
            "review_count": st.review_count,
            "is_mistake": bool(st.consecutive_wrong or st.lapse_count),
            "due_at": st.next_review_at,
        }

    # ---- 写：提交 → QuizAttempt + LearningEvidence + 原生 SRS -----------
    def record_submission(
        self,
        question_id: str,
        revision_id: str,
        request_id: str,
        version: int,
        rating: str,
        answer: str,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        now = time.time() if now is None else now
        quality = QUALITY_BY_RATING.get(rating)
        if quality is None:
            raise ValueError(f"unknown rating: {rating!r}")
        # M1：request_id 是全局幂等键，首次提交即绑定 (question_id, revision_id)。
        # 三者全部一致 → 重放首次结果；request_id 相同而身份不同 → fail-closed 拒绝
        # （不产生任何 Attempt/Evidence/SRS 变化）。
        request_id = str(request_id or "").strip()
        if not request_id or len(request_id) > 128:
            raise ValueError("request_id must be 1-128 characters")

        def apply(tx) -> dict[str, Any]:
            progress = tx.progress
            for a in progress.quiz_attempts:
                if a.visual_context.get("request_id") != request_id:
                    continue
                if a.question_id != question_id or a.revision_id != revision_id:
                    raise RequestIdentityConflict(
                        f"request_id {request_id!r} is bound to "
                        f"({a.question_id}, {a.revision_id}), cannot accept "
                        f"({question_id}, {revision_id})"
                    )
                st = progress.repetition_states.get(state_key(question_id, revision_id))
                return {
                    "attempt_id": request_id,
                    "question_id": question_id,
                    "revision_id": revision_id,
                    "rating": rating,
                    "self_report": True,
                    "correct": None,
                    "graded": False,
                    "grade_reason": "review_only_no_reference",
                    "version": st.review_count if st else 0,
                    "due_at": st.next_review_at if st else None,
                    "is_mistake": bool(st.consecutive_wrong or st.lapse_count) if st else False,
                    "idempotent_replay": True,
                }
            key = state_key(question_id, revision_id)
            st = progress.repetition_states.get(key)
            if (st.review_count if st else 0) != version:
                raise ReviewConflict(
                    "This question changed in another tab. Reload it before reviewing again."
                )
            attempt = QuizAttempt(
                question_id=question_id,
                revision_id=revision_id,
                source_type="qcore",
                knowledge_point_id="",
                is_correct=None,
                result=None,
                user_answer=answer,
                timestamp=now,
                voided=False,
                visual_context={"request_id": request_id, "rating": rating, "self_report": True},
            )
            evidence = LearningEvidence(
                evidence_id=f"qcore-{request_id}",
                question_id=question_id,
                revision_id=revision_id,
                source_type="qcore",
                knowledge_point_id="",
                timestamp=now,
                source="qcore_practice",
                assessment_type="review",
                result="ungraded",
                quality=quality,
                learner_answer=answer,
                feedback=f"self_report={rating}; graded=false; review_only",
            )
            progress.quiz_attempts.append(attempt)
            progress.learning_evidence.append(evidence)
            # 原生 SRS：SpacedRepetitionScheduler（quality=学员声明值，非判分推断）
            scheduler = scheduler_for_progress(progress)
            state = st or scheduler.get_initial_state(
                DEFAULT_KNOWLEDGE_TYPE, now=now, desired_retention=progress.desired_retention
            )
            scheduler.schedule_review(state, DEFAULT_KNOWLEDGE_TYPE, evidence, now=now)
            progress.repetition_states[key] = state
            progress.review_queue = scheduler.build_review_queue(progress)
            tx.emit(
                "evidence.recorded",
                {
                    "evidence_id": evidence.evidence_id,
                    "question_id": question_id,
                    "revision_id": revision_id,
                    "result": "ungraded",
                    "source": "qcore_practice",
                },
            )
            return {
                "attempt_id": request_id,
                "question_id": question_id,
                "revision_id": revision_id,
                "rating": rating,
                "self_report": True,
                "correct": None,
                "graded": False,
                "grade_reason": "review_only_no_reference",
                "version": state.review_count,
                "due_at": state.next_review_at,
                "is_mistake": bool(state.consecutive_wrong or state.lapse_count),
            }

        _progress, outcome = self._store.mutate(QC_BOOK_ID, apply, create=True)
        return outcome

    # ---- 合法判分 → ErrorRecord（review_only 下不得调用） ----------------
    def record_error(
        self,
        question_id: str,
        revision_id: str,
        attempt_id: str,
        *,
        legal_grade: bool,
        is_correct: bool | None,
        error_type: str = "deviation",
        now: float | None = None,
    ) -> ErrorRecord | None:
        if not legal_grade or is_correct is not False:
            return None
        now = time.time() if now is None else now
        rec = ErrorRecord(
            id=f"err-{attempt_id}",
            question_id=question_id,
            revision_id=revision_id,
            source_type="qcore",
            attempt_id=attempt_id,
            knowledge_point_id="",
            module_id="",
            error_type=error_type,  # type: ignore[arg-type]
            status="active",
            created_at=now,
        )

        def apply(tx):
            progress = tx.progress
            if any(e.id == rec.id for e in progress.error_records):
                return False
            progress.error_records.append(rec)
            tx.emit(
                "error.recorded",
                {"error_id": rec.id, "question_id": question_id, "revision_id": revision_id},
            )
            return True

        self._store.mutate(QC_BOOK_ID, apply, create=True)
        return rec

    # ---- 读回（对账/测试：原生聚合） -------------------------------------
    def attempts(self, question_id: str | None = None) -> list[QuizAttempt]:
        progress, _ = self._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
        items = [a for a in progress.quiz_attempts if a.source_type == "qcore"]
        return [a for a in items if question_id is None or a.question_id == question_id]

    def evidence(self, question_id: str | None = None) -> list[LearningEvidence]:
        progress, _ = self._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
        items = [e for e in progress.learning_evidence if e.source_type == "qcore"]
        return [e for e in items if question_id is None or e.question_id == question_id]

    def errors(self, question_id: str | None = None) -> list[ErrorRecord]:
        progress, _ = self._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
        items = [e for e in progress.error_records if e.source_type == "qcore"]
        return [e for e in items if question_id is None or e.question_id == question_id]

    def repetition_state(self, question_id: str, revision_id: str):
        progress, _ = self._store.mutate(QC_BOOK_ID, lambda tx: None, create=True)
        return progress.repetition_states.get(state_key(question_id, revision_id))

    # ---- 中间态历史转录（一次性，幂等） ---------------------------------
    def migrate_interim_rows(self, db_path: str | None = None) -> dict[str, int]:
        """把 practice_review_*_qc 与 qc_* 中间表历史行转录入原生聚合。

        原表不删除不改写（冻结留证）；转录幂等（request_id/evidence_id 去重）。
        """
        # 中间表（practice_review_*_qc / qc_*）位于会话 SQLite（chat_history.db），
        # 原生聚合位于 LearningStore 的 mastery.sqlite3 —— 两者不同库。
        if db_path:
            db = str(db_path)
        else:
            from deeptutor.services.session import get_sqlite_session_store

            db = str(get_sqlite_session_store().db_path)
        rows: list[tuple] = []
        try:
            with sqlite3.connect(db) as raw:
                raw.row_factory = sqlite3.Row
                try:
                    rows += [
                        (r["request_id"], r["question_id"], r["revision_id"], r["reviewed_at"],
                         r["answer"], r["rating"])
                        for r in raw.execute(
                            "SELECT * FROM practice_review_events_qc ORDER BY reviewed_at"
                        )
                    ]
                except sqlite3.OperationalError:
                    pass
                try:
                    rows += [
                        (r["attempt_id"], r["question_id"], r["revision_id"], r["created_at"],
                         json.loads(r["payload_json"]).get("quiz_attempt", {}).get("user_answer", ""),
                         json.loads(r["payload_json"]).get("outcome", {}).get("rating", "good"))
                        for r in raw.execute(
                            "SELECT * FROM qc_quiz_attempts ORDER BY created_at"
                        )
                    ]
                except sqlite3.OperationalError:
                    pass
        except sqlite3.OperationalError:
            return {"interim_rows": 0, "migrated": 0}

        migrated = 0
        conflicts: list[str] = []

        def apply(tx):
            nonlocal migrated
            progress = tx.progress
            # 去重=全局 request_id 绑定（M1 口径）：同 id 已绑其他身份 → 跳过并计入冲突，
            # 不伪造第二条记录；同 id 同身份 → 跳过（已转录）。
            by_req = {
                a.visual_context.get("request_id"): (a.question_id, a.revision_id)
                for a in progress.quiz_attempts
            }
            for req, qid, rid, ts, ans, rating in rows:
                if req in by_req:
                    if by_req[req] == (qid, rid):
                        continue
                    conflicts.append(req)
                    continue
                quality = QUALITY_BY_RATING.get(str(rating), 0.5)
                progress.quiz_attempts.append(QuizAttempt(
                    question_id=qid, revision_id=rid, source_type="qcore",
                    knowledge_point_id="", is_correct=None, result=None,
                    user_answer=ans or "", timestamp=float(ts),
                    visual_context={"request_id": req, "rating": rating,
                                    "provenance": "interim_migration"},
                ))
                progress.learning_evidence.append(LearningEvidence(
                    evidence_id=f"qcore-{req}", question_id=qid, revision_id=rid,
                    source_type="qcore", knowledge_point_id="",
                    timestamp=float(ts), source="qcore_practice",
                    assessment_type="review", result="ungraded", quality=quality,
                    learner_answer=ans or "",
                    feedback="migrated from interim spike tables (archive retained)",
                ))
                migrated += 1
            if migrated:
                tx.emit("evidence.migrated", {"migrated": migrated})
            return migrated

        self._store.mutate(QC_BOOK_ID, apply, create=True)
        return {"interim_rows": len(rows), "migrated": migrated,
                "identity_conflicts_skipped": len(conflicts)}

    # ---- 状态/证据一致性重建（原生 replay 模式） -------------------------
    def resync_states_from_evidence(self) -> dict[str, int]:
        """用聚合内证据按序 replay 重建 repetition_states（replay ≡ state）。

        迁移历史证据与新证据统一经原生调度器重放；不引入第二套调度。
        """

        def apply(tx):
            progress = tx.progress
            scheduler = scheduler_for_progress(progress)
            by_key: dict[str, list] = {}
            for e in progress.learning_evidence:
                if e.source_type != "qcore":
                    continue
                by_key.setdefault(state_key(e.question_id, e.revision_id), []).append(e)
            for key, items in by_key.items():
                ordered = sorted(items, key=lambda item: (item.timestamp, item.evidence_id))
                progress.repetition_states[key] = scheduler.replay(
                    DEFAULT_KNOWLEDGE_TYPE, ordered,
                    desired_retention=progress.desired_retention,
                )
            progress.review_queue = scheduler.build_review_queue(progress)
            tx.emit("states.resynced", {"states": len(by_key)})
            return len(by_key)

        _p, count = self._store.mutate(QC_BOOK_ID, apply, create=True)
        return {"resynced_states": count}
