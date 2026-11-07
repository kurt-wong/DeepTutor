"""Read locally preprocessed exam-paper artifacts.

Several OCR pipelines split a paper into ``unit`` records and anchor each
record to line ranges in the source Markdown. DeepTutor can index the source
Markdown directly, but then a question is just an arbitrary chunk: the
printed number, the answer, the explanation, and the extracted figures are
lost. This module reads the pipeline's own manifest instead, so callers can
import a normalized paper into a knowledge base or seed the Question Bank
without re-running OCR or asking an LLM to find the questions again.

The supported layout is intentionally narrow::

    <root>/<grade>/<subject>/<paper>.md              # OCR Markdown
    <root>/<grade>/<subject>/<paper>.manifest.json   # unit anchors
    <root>/<grade>/<subject>/<paper>.annotated.md    # optional display view
    <root>/_imgs/<paper>/manifest.json               # optional page/image map

Paths and line ranges are read from the manifest. A paper with no readable
source Markdown is reported as a warning instead of failing the whole import.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import html
import json
from pathlib import Path
import re
from typing import Any, Iterable

# Pipeline question types seen in the anchors. Anything unknown degrades to a
# written answer, the same fallback the question pipeline uses.
_BANK_TYPES = {
    "single_choice": "single_choice",
    "multi_choice": "multi_choice",
    "true_false": "true_false",
    "judge": "true_false",
    "fill_in": "fill_blank",
    "fill_blank": "fill_blank",
    "fill_in_blank": "fill_blank",
    "short_answer": "short_answer",
    "written": "short_answer",
    "essay": "short_answer",
    "calculation": "short_answer",
    "concept": "short_answer",
}

# The question pipeline has its own taxonomy (``choice`` rather than
# ``single_choice``). Keeping both mappings in one place avoids the two
# import paths drifting apart.
_PIPELINE_TYPES = {
    "single_choice": "choice",
    "multi_choice": "choice",
    "true_false": "choice",
    "judge": "choice",
    "fill_in": "fill_in_blank",
    "fill_blank": "fill_in_blank",
    "fill_in_blank": "fill_in_blank",
    "short_answer": "short_answer",
    "written": "written",
    "essay": "written",
    "calculation": "written",
    "concept": "concept",
}

_TYPE_LABELS = {
    "single_choice": "单选题",
    "multi_choice": "多选题",
    "true_false": "判断题",
    "fill_blank": "填空题",
    "short_answer": "简答题",
}

_OPTION_MARKER = re.compile(
    r"(?<![A-Za-z0-9])(?:[（(]\s*)?([A-HＡ-Ｈ])\s*[)）.．、:：]\s*"
)
_IMAGE_MD = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")
_IMAGE_HTML = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)
_ANSWER_PREFIX = re.compile(
    r"^\s*(?:\d+\s*[.．、]\s*)?(?:【(?:答案|参考答案)】|(?:答案|参考答案)\s*[:：])\s*"
)
_EXPLANATION_PREFIX = re.compile(
    r"^\s*(?:\d+\s*[.．、]\s*)?(?:【(?:解析|分析|详解|点睛|解答|点评)】|"
    r"(?:解析|分析|详解|点睛|解答|点评)\s*[:：])\s*"
)
_INNER_LABEL = re.compile(r"【(?:分析|详解|点睛|解答|点评)】\s*")
_HTML_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
_HTML_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^>]+>")
_IMG_BLOCK = re.compile(
    r"<div[^>]*>\s*<img[^>]*>\s*</div>|<img[^>]*>", re.IGNORECASE | re.DOTALL
)
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_CHOICE_ANSWER_HINTS = (
    re.compile(r"故答案为\s*([A-H])"),
    re.compile(r"答案(?:是|为|选)?\s*[:：]?\s*([A-H])\b"),
    re.compile(r"应选\s*([A-H])"),
    re.compile(r"选择\s*([A-H])"),
    re.compile(r"([A-H])\s*项?正确"),
    re.compile(r"([A-H])\s*项符合题意"),
)
_COMPACT_ANSWER_RUN = re.compile(
    r"(?m)(\d+)\s*[-–—~至]\s*(\d+)\s*[:：]?\s*([A-H](?:\s*[A-H]){1,})"
)
_DEFAULT_EXCLUDED_DIRS = frozenset({"gen-test-runs", ".cache", ".pytest_tmp", ".pytest_work"})
_GRADE_NAMES = (
    "高一",
    "高二",
    "高三",
    "高考真题",
    "合格考",
    "会考",
    "学业水平考试",
    "竞赛自招",
    "其他汇编",
    "未分类",
)
_SUBJECT_NAMES = ("语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治")


@dataclass(frozen=True)
class PreprocessedUnit:
    unit_id: str
    unit_type: str
    question_type: str
    question_numbers: tuple[int, ...] = ()
    section: str = ""
    stem: str = ""
    options: dict[str, str] = field(default_factory=dict)
    answer: str = ""
    explanation: str = ""
    image_paths: tuple[str, ...] = ()
    source_ranges: dict[str, tuple[int, int]] = field(default_factory=dict)

    @property
    def pipeline_question_type(self) -> str:
        return _PIPELINE_TYPES.get(self.unit_type, "written")

    @property
    def label(self) -> str:
        kind = _TYPE_LABELS.get(self.question_type, "题目")
        numbers = ", ".join(str(number) for number in self.question_numbers)
        return f"{kind} · 第{numbers}题" if numbers else kind

    def reference_question(self) -> str:
        parts = [self.stem.strip()]
        if self.options:
            parts.append(
                "\n".join(f"{key}. {value}" for key, value in sorted(self.options.items()))
            )
        return "\n\n".join(part for part in parts if part).strip()

    def to_dict(self) -> dict[str, Any]:
        return {
            "unit_id": self.unit_id,
            "unit_type": self.unit_type,
            "question_type": self.question_type,
            "pipeline_question_type": self.pipeline_question_type,
            "question_numbers": list(self.question_numbers),
            "section": self.section,
            "stem": self.stem,
            "options": dict(self.options),
            "answer": self.answer,
            "explanation": self.explanation,
            "image_paths": list(self.image_paths),
            "source_ranges": {
                key: list(value) for key, value in self.source_ranges.items()
            },
        }


@dataclass(frozen=True)
class PreprocessedPaper:
    paper_id: str
    manifest_path: Path
    source_md: Path | None
    annotated_md: Path | None
    title: str
    grade: str
    subject: str
    source_pdf: Path | None
    page_count: int
    units: tuple[PreprocessedUnit, ...]
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "paper_id": self.paper_id,
            "manifest_path": str(self.manifest_path),
            "source_md": str(self.source_md) if self.source_md else "",
            "annotated_md": str(self.annotated_md) if self.annotated_md else "",
            "title": self.title,
            "grade": self.grade,
            "subject": self.subject,
            "source_pdf": str(self.source_pdf) if self.source_pdf else "",
            "page_count": self.page_count,
            "unit_count": len(self.units),
            "warnings": list(self.warnings),
            "units": [unit.to_dict() for unit in self.units],
        }


def _safe_id(value: str, *, limit: int = 160) -> str:
    text = re.sub(r"[\s/\\]+", "-", value.strip())
    text = re.sub(r"[^\w\u4e00-\u9fff.()（）-]+", "", text)
    if len(text) <= limit:
        return text
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    return f"{text[: limit - 9]}-{digest}"


def _manifest_payload(path: Path) -> dict[str, Any] | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(loaded, dict) or not isinstance(loaded.get("units"), list):
        return None
    return loaded


def is_paper_manifest(path: str | Path) -> bool:
    """Return whether ``path`` is a paper anchor manifest, not an image map."""
    candidate = Path(path)
    return candidate.is_file() and candidate.name.endswith(".manifest.json") and bool(
        _manifest_payload(candidate)
    )


def resolve_manifest(path: str | Path) -> Path | None:
    """Resolve a manifest file, or the single paper manifest in a directory."""
    candidate = Path(path).expanduser()
    if is_paper_manifest(candidate):
        return candidate.resolve()
    if candidate.is_dir():
        manifests = sorted(
            child
            for child in candidate.glob("*.manifest.json")
            if is_paper_manifest(child)
        )
        if len(manifests) == 1:
            return manifests[0].resolve()
        if len(manifests) > 1:
            raise ValueError(
                f"{candidate} holds {len(manifests)} paper manifests; "
                "pass one manifest file instead."
            )
    return None


def discover_papers(
    root: str | Path,
    *,
    grade: str | None = None,
    subject: str | None = None,
    exclude_dirs: Iterable[str] = _DEFAULT_EXCLUDED_DIRS,
) -> list[Path]:
    """Find paper manifests under ``root``, filtering by path parts."""
    base = Path(root).expanduser().resolve()
    if not base.is_dir():
        raise ValueError(f"Not a directory: {base}")
    excluded = {name.lower() for name in exclude_dirs}
    wanted_grade = (grade or "").strip().lower()
    wanted_subject = (subject or "").strip().lower()
    found: list[Path] = []
    for manifest in sorted(base.rglob("*.manifest.json")):
        if any(part.lower() in excluded for part in manifest.parts):
            continue
        if not is_paper_manifest(manifest):
            continue
        relative_parts = [part.lower() for part in manifest.relative_to(base).parts]
        if wanted_grade and wanted_grade not in relative_parts:
            continue
        if wanted_subject and wanted_subject not in relative_parts:
            continue
        found.append(manifest)
    return found


def _read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def _slice(lines: list[str], value: Any) -> tuple[str, tuple[int, int] | None]:
    """Return a 1-based inclusive line range as text."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return "", None
    try:
        start, end = int(value[0]), int(value[1])
    except (TypeError, ValueError):
        return "", None
    if start <= 0 or end < start or start > len(lines):
        return "", None
    end = min(end, len(lines))
    text = "\n".join(line.rstrip() for line in lines[start - 1 : end]).strip()
    return text, (start, end)


def _clean_answer(text: str) -> str:
    cleaned = _ANSWER_PREFIX.sub("", text.strip(), count=1)
    return cleaned.strip()


def _clean_explanation(text: str) -> str:
    cleaned = _EXPLANATION_PREFIX.sub("", text.strip(), count=1)
    cleaned = _INNER_LABEL.sub("", cleaned)
    return cleaned.strip()


def _plain_cell(value: str) -> str:
    return " ".join(html.unescape(_TAG.sub("", value)).split())


def _without_images(text: str) -> str:
    """Drop figure markup from the question text; paths live in ``image_paths``."""
    cleaned = _MD_IMAGE.sub("", _IMG_BLOCK.sub("", text))
    return re.sub(r"[ \t]+\n", "\n", cleaned).strip()


def _table_answer_map(rows: list[list[str]]) -> dict[int, str]:
    """Map printed question numbers to answers from 题目/答案 table rows."""
    mapping: dict[int, str] = {}
    pending: list[int] = []
    for row in rows:
        if not row:
            continue
        label = row[0].strip()
        if label in {"题目", "题号", "题 目"}:
            pending = []
            for cell in row[1:]:
                try:
                    pending.append(int(cell))
                except ValueError:
                    continue
        elif label in {"答案", "正确答案", "答 案"} and pending:
            for number, answer in zip(pending, row[1:]):
                value = answer.strip()
                if value:
                    mapping[number] = value
            pending = []
    if mapping:
        return mapping

    # Many OCR tables omit the labels entirely and alternate a row of
    # question numbers with a row of answer letters.
    for index in range(len(rows) - 1):
        numbers: list[tuple[int, int]] = []
        for position, cell in enumerate(rows[index]):
            if not cell.strip():
                continue
            try:
                numbers.append((int(cell), position))
            except ValueError:
                numbers = []
                break
        if len(numbers) < 2:
            continue
        answers = rows[index + 1]
        if not answers or all(cell.isdigit() for cell in answers if cell):
            continue
        for number, position in numbers:
            if position < len(answers):
                value = answers[position].strip()
                if value:
                    mapping[number] = value
    return mapping


def _answer_for_unit(text: str, numbers: tuple[int, ...], question_type: str) -> str:
    """Extract this unit's answer from a shared table or a labelled line.

    OCR output commonly stores all objective answers in one HTML table at the
    end of the paper, and every unit's ``answer_lines`` points at that single
    line. Keeping the whole table as each question's answer would be wrong.
    """
    if not text.strip():
        return ""
    if numbers:
        for match in _COMPACT_ANSWER_RUN.finditer(text):
            start, end = int(match.group(1)), int(match.group(2))
            letters = re.sub(r"\s+", "", match.group(3))
            if end < start or len(letters) < end - start + 1:
                continue
            mapping = {
                start + offset: letters[offset] for offset in range(end - start + 1)
            }
            for number in numbers:
                if number in mapping:
                    return mapping[number]
        rows: list[list[str]] = []
        for row_html in _HTML_ROW.findall(text):
            cells = [_plain_cell(cell) for cell in _HTML_CELL.findall(row_html)]
            if cells:
                rows.append(cells)
        if not rows and "|" in text:
            for line in text.splitlines():
                stripped = line.strip().strip("|")
                if stripped and set(stripped) - set("-: "):
                    rows.append([cell.strip() for cell in stripped.split("|")])
        mapping = _table_answer_map(rows)
        for number in numbers:
            if number in mapping:
                return mapping[number]
        for number in numbers:
            labelled = re.search(
                rf"(?m)^\s*{number}\s*[.．、]?\s*(?:【答案】|答案\s*[:：])\s*(.+)$",
                text,
            )
            if labelled:
                return _clean_answer(labelled.group(1))
    cleaned = _clean_answer(text)
    if question_type in {"single_choice", "multi_choice"} and not re.fullmatch(
        r"[A-H](?:\s*[,，]\s*[A-H])*", cleaned.strip()
    ):
        for pattern in _CHOICE_ANSWER_HINTS:
            match = pattern.search(cleaned)
            if match:
                return match.group(1)
    return cleaned


def parse_options(text: str) -> dict[str, str]:
    """Split ``A. x B. y`` / ``(A) x (B) y`` option lines into a mapping."""
    markers = list(_OPTION_MARKER.finditer(text))
    if len(markers) < 2:
        return {}
    # Only accept a sequence that starts at A; a stray "B." in prose should
    # not turn the stem into options.
    first_key = markers[0].group(1)
    if first_key not in {"A", "Ａ"}:
        markers = [marker for marker in markers if marker.group(1) in {"A", "Ａ"}]
        if not markers:
            return {}
    options: dict[str, str] = {}
    for index, marker in enumerate(markers):
        key = marker.group(1).replace("Ａ", "A").replace("Ｂ", "B").replace("Ｃ", "C")
        key = key.replace("Ｄ", "D").replace("Ｅ", "E").replace("Ｆ", "F")
        key = key.replace("Ｇ", "G").replace("Ｈ", "H")
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        value = " ".join(text[marker.end() : end].split())
        if value and key not in options:
            options[key] = value
    return options if len(options) >= 2 else {}


def _image_paths(text: str, base_dir: Path) -> tuple[str, ...]:
    refs = [match.group(1) for match in _IMAGE_MD.finditer(text)]
    refs.extend(match.group(1) for match in _IMAGE_HTML.finditer(text))
    resolved: list[str] = []
    for ref in refs:
        if ref.startswith(("http://", "https://", "data:")):
            continue
        candidate = (base_dir / ref).expanduser()
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        if candidate.is_file() and str(candidate) not in resolved:
            resolved.append(str(candidate))
    return tuple(resolved)


def _find_image_manifest(source_md: Path, paper_stem: str) -> dict[str, Any] | None:
    for parent in (source_md.parent, *source_md.parents):
        candidate = parent / "_imgs" / paper_stem / "manifest.json"
        if candidate.is_file():
            try:
                loaded = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                return None
            return loaded if isinstance(loaded, dict) else None
    return None


def _relative_context(path: Path, root: Path) -> tuple[str, str]:
    parts = path.relative_to(root).parts if path.is_relative_to(root) else path.parts
    if len(parts) >= 3:
        return parts[0], parts[1]
    if len(parts) == 2:
        return parts[0], ""
    return "", ""


def _infer_grade_subject(source_md: Path, manifest: Path, root: Path | None) -> tuple[str, str]:
    """Prefer the artifact tree; fall back to any recognizable path segment.

    A manifest's ``source_file`` often points outside the artifact tree (the
    raw OCR file lives elsewhere), so the manifest's own location is the more
    reliable grade/subject source when a root is supplied.
    """
    candidates = [manifest, source_md]
    if root is not None:
        for candidate in candidates:
            if candidate.is_relative_to(root):
                parts = list(candidate.relative_to(root).parts)
                while parts and (
                    parts[0].lower().startswith(("reslice", "auto-annotated"))
                    or parts[0] in {"Ocr-markdown", "gen-test-runs"}
                ):
                    parts.pop(0)
                if len(parts) >= 3:
                    return parts[0], parts[1]
    parts = [part for candidate in candidates for part in candidate.parts]
    grade = next((name for name in _GRADE_NAMES if name in parts), "")
    subject = next((name for name in _SUBJECT_NAMES if name in parts), "")
    return grade, subject


def load_preprocessed_paper(
    manifest_path: str | Path,
    *,
    root: str | Path | None = None,
) -> PreprocessedPaper:
    """Load one manifest and its source Markdown into normalized units."""
    manifest = Path(manifest_path).expanduser().resolve()
    payload = _manifest_payload(manifest)
    if payload is None:
        raise ValueError(f"Not a paper manifest: {manifest}")

    warnings: list[str] = []
    source_md = Path(str(payload.get("source_file") or "")).expanduser()
    if not source_md.is_file():
        sibling = manifest.with_name(manifest.name[: -len(".manifest.json")] + ".md")
        if sibling.is_file():
            source_md = sibling
        else:
            warnings.append(f"Source Markdown not found for {manifest.name}")
            source_md = None
    if source_md is None:
        return PreprocessedPaper(
            paper_id=_safe_id(manifest.stem),
            manifest_path=manifest,
            source_md=None,
            annotated_md=None,
            title=manifest.stem,
            grade="",
            subject="",
            source_pdf=None,
            page_count=0,
            units=(),
            warnings=tuple(warnings),
        )

    source_md = source_md.resolve()
    lines = _read_lines(source_md)
    annotated = manifest.with_name(manifest.name[: -len(".manifest.json")] + ".annotated.md")
    annotated_md = annotated if annotated.is_file() else None
    base_root = Path(root).expanduser().resolve() if root else source_md.parent
    grade, subject = _infer_grade_subject(source_md, manifest, base_root if root else None)
    if not grade and not subject and not root:
        grade, subject = _relative_context(source_md, source_md.parent)

    title = ""
    for line in lines[:20]:
        if line.lstrip().startswith("# "):
            title = line.lstrip()[2:].strip()
            break
    title = title or source_md.stem

    image_manifest = _find_image_manifest(source_md, source_md.stem)
    source_pdf: Path | None = None
    page_count = 0
    if image_manifest:
        raw_pdf = str(image_manifest.get("pdf") or "").strip()
        if raw_pdf:
            candidate = Path(raw_pdf).expanduser()
            if candidate.is_file():
                source_pdf = candidate.resolve()
        try:
            page_count = int(image_manifest.get("pages") or 0)
        except (TypeError, ValueError):
            page_count = 0

    units: list[PreprocessedUnit] = []
    for index, raw in enumerate(payload.get("units") or [], 1):
        if not isinstance(raw, dict):
            continue
        unit_id = str(raw.get("unit_id") or f"U{index}").strip()
        raw_type = str(raw.get("original_question_type") or "").strip().lower()
        question_type = _BANK_TYPES.get(raw_type, "short_answer")
        numbers: list[int] = []
        for value in raw.get("question_numbers") or []:
            try:
                numbers.append(int(value))
            except (TypeError, ValueError):
                continue
        number_tuple = tuple(numbers)

        ranges: dict[str, tuple[int, int]] = {}
        stem_parts: list[str] = []
        for key in ("material_lines", "questions_lines", "stem_lines"):
            text, span = _slice(lines, raw.get(key))
            if span:
                ranges[key] = span
            if text and text not in stem_parts:
                stem_parts.append(text)
        options_text, options_span = _slice(lines, raw.get("options_lines"))
        if options_span:
            ranges["options_lines"] = options_span
        answer_text, answer_span = _slice(lines, raw.get("answer_lines"))
        if answer_span:
            ranges["answer_lines"] = answer_span
        explanation_text, explanation_span = _slice(lines, raw.get("explanation_lines"))
        if explanation_span:
            ranges["explanation_lines"] = explanation_span

        stem = "\n\n".join(part for part in stem_parts if part).strip()
        if number_tuple:
            stem = re.sub(
                rf"^\s*{number_tuple[0]}\s*\\?\s*[.．、]\s*",
                "",
                stem,
                count=1,
            )
        if not stem:
            warnings.append(f"{unit_id}: no readable stem")
        image_text = "\n".join([stem, options_text, answer_text, explanation_text])
        stem = _without_images(stem)
        options_text = _without_images(options_text)
        final_answer = _answer_for_unit(answer_text, number_tuple, question_type)
        final_explanation = _clean_explanation(explanation_text)
        if (
            not final_explanation
            and question_type in {"single_choice", "multi_choice"}
            and re.fullmatch(r"[A-H](?:\s*[,，]\s*[A-H])*", final_answer.strip())
            and "<table" not in answer_text.lower()
            and not re.fullmatch(
                r"[A-H](?:\s*[,，]\s*[A-H])*", _clean_answer(answer_text).strip()
            )
        ):
            # The answer line carried the worked solution rather than a bare
            # letter; keep that reasoning as the explanation.
            final_explanation = _clean_explanation(answer_text)
        units.append(
            PreprocessedUnit(
                unit_id=unit_id,
                unit_type=raw_type or "short_answer",
                question_type=question_type,
                question_numbers=number_tuple,
                section=str(raw.get("section") or "").strip(),
                stem=stem,
                options=parse_options(options_text),
                answer=final_answer,
                explanation=final_explanation,
                image_paths=_image_paths(image_text, source_md.parent),
                source_ranges=ranges,
            )
        )

    paper_id = _safe_id(
        "/".join(part for part in (grade, subject, source_md.stem) if part)
        or source_md.stem
    )
    return PreprocessedPaper(
        paper_id=paper_id,
        manifest_path=manifest,
        source_md=source_md,
        annotated_md=annotated_md,
        title=title,
        grade=grade,
        subject=subject,
        source_pdf=source_pdf,
        page_count=page_count,
        units=tuple(units),
        warnings=tuple(warnings),
    )


def render_paper_markdown(paper: PreprocessedPaper, *, include_answers: bool = True) -> str:
    """Render a normalized, RAG-friendly Markdown view of one paper."""
    header = [
        "---",
        f"paper_id: {json.dumps(paper.paper_id, ensure_ascii=False)}",
        f"title: {json.dumps(paper.title, ensure_ascii=False)}",
        f"grade: {json.dumps(paper.grade, ensure_ascii=False)}",
        f"subject: {json.dumps(paper.subject, ensure_ascii=False)}",
        f"source_pdf: {json.dumps(str(paper.source_pdf or ''), ensure_ascii=False)}",
        f"source_md: {json.dumps(str(paper.source_md or ''), ensure_ascii=False)}",
        f"unit_count: {len(paper.units)}",
        "---",
        "",
        f"# {paper.title}",
        "",
    ]
    if paper.grade or paper.subject:
        header.append(
            f"> 年级/科目：{paper.grade or '未标注'} / {paper.subject or '未标注'}"
        )
    if paper.source_pdf:
        header.append(f"> 原始 PDF：{paper.source_pdf}")
    header.append("")

    body: list[str] = []
    for unit in paper.units:
        body.append(f"## {unit.unit_id} · {unit.label}")
        body.append("")
        if unit.section:
            body.append(f"> {unit.section}")
            body.append("")
        if unit.stem:
            body.append(unit.stem)
            body.append("")
        if unit.options:
            for key, value in sorted(unit.options.items()):
                body.append(f"- {key}. {value}")
            body.append("")
        if include_answers and unit.answer:
            body.append(f"**答案**：{unit.answer}")
            body.append("")
        if include_answers and unit.explanation:
            body.append(f"**解析**：{unit.explanation}")
            body.append("")
        body.append("---")
        body.append("")
    return "\n".join(header + body).rstrip() + "\n"


def to_question_bank_items(paper: PreprocessedPaper) -> list[dict[str, Any]]:
    """Convert source units into ``notebook_entries`` upsert payloads.

    ``result=ungraded`` keeps imported questions out of the mistake set until
    the learner actually answers them.
    """
    origin_ref = f"preprocessed:{paper.paper_id}"
    items: list[dict[str, Any]] = []
    for unit in paper.units:
        question = unit.stem.strip()
        if not question or not unit.unit_id:
            continue
        choice = unit.question_type in {"single_choice", "multi_choice"}
        if choice and (
            len(unit.options) < 2
            or not re.fullmatch(r"[A-H](?:\s*[,，]\s*[A-H])*", unit.answer.strip())
        ):
            # A choice without choices or without a resolvable key cannot be
            # graded; leaving it out is better than importing a broken card.
            continue
        items.append(
            {
                "origin_type": "external_import",
                "origin_ref": origin_ref,
                "question_id": f"{paper.paper_id}:{unit.unit_id}",
                "question": question,
                "question_type": unit.question_type,
                "options": unit.options,
                "correct_answer": unit.answer,
                "explanation": unit.explanation,
                "difficulty": "",
                "user_answer": "",
                "source": "import",
                "material_id": origin_ref,
                "material_title": paper.title,
                "section_title": unit.section,
                "assessment_type": "quiz",
                "result": "ungraded",
                "is_correct": False,
            }
        )
    return items


def write_bundle(
    papers: Iterable[PreprocessedPaper],
    out_dir: str | Path,
    *,
    include_answers: bool = True,
) -> dict[str, Any]:
    """Write normalized Markdown + units JSON for later KB or bank import."""
    target = Path(out_dir).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for paper in papers:
        paper_dir = target / paper.paper_id
        paper_dir.mkdir(parents=True, exist_ok=True)
        markdown_path = paper_dir / "paper.md"
        units_path = paper_dir / "units.json"
        markdown_path.write_text(
            render_paper_markdown(paper, include_answers=include_answers),
            encoding="utf-8",
            newline="\n",
        )
        units_path.write_text(
            json.dumps(paper.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
            newline="\n",
        )
        entries.append(
            {
                "paper_id": paper.paper_id,
                "markdown": str(markdown_path),
                "units": str(units_path),
                "unit_count": len(paper.units),
            }
        )
    index = {"papers": entries, "paper_count": len(entries)}
    (target / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
        newline="\n",
    )
    return index


async def import_to_question_bank(
    papers: Iterable[PreprocessedPaper],
    *,
    store: Any = None,
) -> tuple[int, int]:
    """Upsert every unit into the Question Bank; returns ``(written, skipped)``."""
    if store is None:
        from deeptutor.services.session.sqlite_store import get_sqlite_session_store

        store = get_sqlite_session_store()
    written = 0
    skipped = 0
    for paper in papers:
        items = to_question_bank_items(paper)
        skipped += max(0, len(paper.units) - len(items))
        if items:
            written += await store.upsert_notebook_entries(None, items)
    return written, skipped


__all__ = [
    "PreprocessedPaper",
    "PreprocessedUnit",
    "discover_papers",
    "import_to_question_bank",
    "is_paper_manifest",
    "load_preprocessed_paper",
    "parse_options",
    "render_paper_markdown",
    "resolve_manifest",
    "to_question_bank_items",
    "write_bundle",
]
