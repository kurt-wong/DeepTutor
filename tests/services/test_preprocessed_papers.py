"""Anchored preprocessing artifacts become normalized papers and bank items."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from deeptutor.agents.question.mimic_source import _parse_sync
from deeptutor.agents.question.preprocessed_source import (
    is_preprocessed_paper,
    parse_preprocessed_paper_to_templates,
)
from deeptutor.services.preprocessed_papers import (
    PreprocessedPaper,
    PreprocessedUnit,
    discover_papers,
    import_to_question_bank,
    load_preprocessed_paper,
    parse_options,
    render_paper_markdown,
    resolve_manifest,
    to_question_bank_items,
)


def _write_paper(root: Path) -> Path:
    paper_dir = root / "高一" / "数学"
    paper_dir.mkdir(parents=True)
    images_dir = root / "_imgs" / "paper"
    images_dir.mkdir(parents=True)
    (images_dir / "img1.jpg").write_bytes(b"jpeg")
    (root / "source.pdf").write_bytes(b"%PDF-1.4")
    (images_dir / "manifest.json").write_text(
        json.dumps(
            {
                "md": str(paper_dir / "paper.md"),
                "pdf": str(root / "source.pdf"),
                "pages": 3,
                "images": [{"ref": "img1.jpg", "page": 1, "status": "ok"}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    lines = [
        "# 测试卷",
        "",
        "## 一、选择题",
        "",
        "1. 下列说法正确的是 ![图](../../_imgs/paper/img1.jpg)",
        "",
        "A. 甲 B. 乙 C. 丙 D. 丁",
        "",
        "2. 计算 1+1",
        "",
        "A. 1 B. 2",
        "",
        "1.【答案】C",
        "【解析】因为甲正确。",
        "2.【答案】B",
        "【详解】1+1=2。",
    ]
    source = paper_dir / "paper.md"
    source.write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = paper_dir / "paper.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "model": "test",
                "annotation_meta": {"validation_issues": [], "warnings": []},
                "units": [
                    {
                        "unit_id": "Q1",
                        "unit_type": "standalone_question",
                        "question_numbers": [1],
                        "original_question_type": "single_choice",
                        "stem_lines": [5, 5],
                        "options_lines": [7, 7],
                        "answer_lines": [13, 13],
                        "explanation_lines": [14, 14],
                        "section": "一、选择题",
                    },
                    {
                        "unit_id": "Q2",
                        "unit_type": "standalone_question",
                        "question_numbers": [2],
                        "original_question_type": "single_choice",
                        "stem_lines": [9, 9],
                        "options_lines": [11, 11],
                        "answer_lines": [15, 15],
                        "explanation_lines": [16, 16],
                        "section": "一、选择题",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (paper_dir / "paper.annotated.md").write_text(source.read_text(encoding="utf-8"))
    return manifest


def test_parse_options_handles_inline_and_parenthesized_markers() -> None:
    assert parse_options("A. 甲 B. 乙 C. 丙") == {"A": "甲", "B": "乙", "C": "丙"}
    assert parse_options("（A） 甲 （B） 乙") == {"A": "甲", "B": "乙"}


def test_load_preprocessed_paper_reads_units_answers_and_images(tmp_path: Path) -> None:
    manifest = _write_paper(tmp_path)

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert paper.paper_id == "高一-数学-paper"
    assert paper.title == "测试卷"
    assert (paper.grade, paper.subject) == ("高一", "数学")
    assert paper.page_count == 3
    assert paper.source_pdf == (tmp_path / "source.pdf").resolve()
    assert [unit.unit_id for unit in paper.units] == ["Q1", "Q2"]

    first = paper.units[0]
    assert first.question_type == "single_choice"
    assert first.options == {"A": "甲", "B": "乙", "C": "丙", "D": "丁"}
    assert first.answer == "C"
    assert first.explanation == "因为甲正确。"
    assert first.image_paths == (str(tmp_path / "_imgs" / "paper" / "img1.jpg"),)


def test_render_paper_markdown_keeps_question_structure(tmp_path: Path) -> None:
    paper = load_preprocessed_paper(_write_paper(tmp_path), root=tmp_path)

    rendered = render_paper_markdown(paper)

    assert "## Q1 · 单选题 · 第1题" in rendered
    assert "A. 甲" in rendered
    assert "**答案**：C" in rendered
    assert "**解析**：因为甲正确。" in rendered


def test_question_bank_items_are_ungraded_imports(tmp_path: Path) -> None:
    paper = load_preprocessed_paper(_write_paper(tmp_path), root=tmp_path)

    items = to_question_bank_items(paper)

    assert len(items) == 2
    assert items[0]["origin_type"] == "external_import"
    assert items[0]["origin_ref"] == f"preprocessed:{paper.paper_id}"
    assert items[0]["source"] == "import"
    assert items[0]["result"] == "ungraded"
    assert items[0]["question_type"] == "single_choice"
    assert items[0]["options"] == {"A": "甲", "B": "乙", "C": "丙", "D": "丁"}
    assert items[0]["correct_answer"] == "C"


def test_discovery_ignores_image_manifests(tmp_path: Path) -> None:
    manifest = _write_paper(tmp_path)

    found = discover_papers(tmp_path)

    assert found == [manifest.resolve()]
    assert discover_papers(tmp_path, grade="高二") == []


def test_resolve_manifest_rejects_ambiguous_directory(tmp_path: Path) -> None:
    manifest = _write_paper(tmp_path)
    second = manifest.with_name("other.manifest.json")
    second.write_text(manifest.read_text(encoding="utf-8"), encoding="utf-8")

    with pytest.raises(ValueError, match="paper manifests"):
        resolve_manifest(manifest.parent)


def test_preprocessed_source_builds_templates_without_llm(tmp_path: Path) -> None:
    manifest = _write_paper(tmp_path)

    assert is_preprocessed_paper(manifest)
    assert is_preprocessed_paper(manifest.parent)

    templates, trace = parse_preprocessed_paper_to_templates(manifest, max_questions=10)

    assert len(templates) == 2
    assert templates[0].question_type == "choice"
    assert templates[0].source == "mimic"
    assert templates[0].reference_answer == "C"
    assert "A. 甲" in (templates[0].reference_question or "")
    assert trace["preprocessed"] == "true"

    limited, _ = parse_preprocessed_paper_to_templates(manifest, max_questions=1)
    assert len(limited) == 1


def test_mimic_parsed_mode_dispatches_to_preprocessed_units(tmp_path: Path) -> None:
    manifest = _write_paper(tmp_path)

    templates, trace = _parse_sync(
        manifest,
        max_questions=2,
        paper_mode="parsed",
        output_base=tmp_path / "out",
    )

    assert len(templates) == 2
    assert trace["manifest"] == str(manifest.resolve())


def test_shared_answer_table_is_split_per_question(tmp_path: Path) -> None:
    paper_dir = tmp_path / "高三" / "化学"
    paper_dir.mkdir(parents=True)
    lines = [
        "# 表格式答案",
        "",
        "1. 第一题",
        "",
        "A. 甲 B. 乙",
        "",
        "2. 第二题",
        "",
        "A. 丙 B. 丁",
        "",
        "<table><tr><td>题目</td><td>1</td><td>2</td></tr>"
        "<tr><td>答案</td><td>C</td><td>D</td></tr></table>",
    ]
    source = paper_dir / "table.md"
    source.write_text("\n".join(lines), encoding="utf-8")
    manifest = paper_dir / "table.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "units": [
                    {
                        "unit_id": "Q1",
                        "original_question_type": "single_choice",
                        "question_numbers": [1],
                        "stem_lines": [3, 3],
                        "options_lines": [5, 5],
                        "answer_lines": [11, 11],
                    },
                    {
                        "unit_id": "Q2",
                        "original_question_type": "single_choice",
                        "question_numbers": [2],
                        "stem_lines": [7, 7],
                        "options_lines": [9, 9],
                        "answer_lines": [11, 11],
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert [unit.answer for unit in paper.units] == ["C", "D"]
    assert paper.units[0].stem == "第一题"


def test_unlabelled_answer_table_pairs_number_and_answer_rows(tmp_path: Path) -> None:
    paper_dir = tmp_path / "高三" / "化学"
    paper_dir.mkdir(parents=True)
    lines = [
        "# 无标签答案表",
        "",
        "1. 第一题",
        "",
        "A. 甲 B. 乙",
        "",
        "2. 第二题",
        "",
        "A. 丙 B. 丁",
        "",
        "<table><tr><td>1</td><td>2</td></tr>"
        "<tr><td>B</td><td>A</td></tr></table>",
    ]
    source = paper_dir / "plain.md"
    source.write_text("\n".join(lines), encoding="utf-8")
    manifest = paper_dir / "plain.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "units": [
                    {
                        "unit_id": "Q1",
                        "original_question_type": "single_choice",
                        "question_numbers": [1],
                        "stem_lines": [3, 3],
                        "options_lines": [5, 5],
                        "answer_lines": [11, 11],
                    },
                    {
                        "unit_id": "Q2",
                        "original_question_type": "single_choice",
                        "question_numbers": [2],
                        "stem_lines": [7, 7],
                        "options_lines": [9, 9],
                        "answer_lines": [11, 11],
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert [unit.answer for unit in paper.units] == ["B", "A"]


def test_answer_table_keeps_trailing_rows_with_blank_cells(tmp_path: Path) -> None:
    paper_dir = tmp_path / "高三" / "化学"
    paper_dir.mkdir(parents=True)
    lines = [
        "# 末尾空单元格",
        "",
        "1. 第一题",
        "",
        "A. 甲 B. 乙",
        "",
        "2. 第二题",
        "",
        "A. 丙 B. 丁",
        "",
        "<table><tr><td>1</td><td>2</td><td></td></tr>"
        "<tr><td>C</td><td>D</td><td></td></tr></table>",
    ]
    source = paper_dir / "blank.md"
    source.write_text("\n".join(lines), encoding="utf-8")
    manifest = paper_dir / "blank.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "units": [
                    {
                        "unit_id": "Q1",
                        "original_question_type": "single_choice",
                        "question_numbers": [1],
                        "stem_lines": [3, 3],
                        "options_lines": [5, 5],
                        "answer_lines": [11, 11],
                    },
                    {
                        "unit_id": "Q2",
                        "original_question_type": "single_choice",
                        "question_numbers": [2],
                        "stem_lines": [7, 7],
                        "options_lines": [9, 9],
                        "answer_lines": [11, 11],
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert [unit.answer for unit in paper.units] == ["C", "D"]


def test_choice_answer_is_recovered_from_explanation_prose(tmp_path: Path) -> None:
    paper_dir = tmp_path / "高一" / "历史"
    paper_dir.mkdir(parents=True)
    lines = [
        "# 解析含答案",
        "",
        "1. 第一题",
        "",
        "A. 甲 B. 乙 C. 丙 D. 丁",
        "",
        "【详解】甲不符合题意，乙不符合题意，丙符合题意，故答案为C项。",
    ]
    source = paper_dir / "history.md"
    source.write_text("\n".join(lines), encoding="utf-8")
    manifest = paper_dir / "history.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "units": [
                    {
                        "unit_id": "Q1",
                        "original_question_type": "single_choice",
                        "question_numbers": [1],
                        "stem_lines": [3, 3],
                        "options_lines": [5, 5],
                        "answer_lines": [7, 7],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert paper.units[0].answer == "C"
    assert "故答案为C项" in paper.units[0].explanation


def test_compact_answer_runs_are_split_by_question_number(tmp_path: Path) -> None:
    paper_dir = tmp_path / "高一" / "地理"
    paper_dir.mkdir(parents=True)
    lines = [
        "# 紧凑答案",
        "",
        "1. 第一题",
        "",
        "A. 甲 B. 乙 C. 丙 D. 丁",
        "",
        "1-10: ADCDCBBABA",
    ]
    source = paper_dir / "geo.md"
    source.write_text("\n".join(lines), encoding="utf-8")
    manifest = paper_dir / "geo.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "units": [
                    {
                        "unit_id": "Q3",
                        "original_question_type": "single_choice",
                        "question_numbers": [3],
                        "stem_lines": [3, 3],
                        "options_lines": [5, 5],
                        "answer_lines": [7, 7],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    paper = load_preprocessed_paper(manifest, root=tmp_path)

    assert paper.units[0].answer == "C"


def test_bank_items_skip_unanswerable_choice_cards() -> None:
    paper = PreprocessedPaper(
        paper_id="p",
        manifest_path=Path("p.manifest.json"),
        source_md=Path("p.md"),
        annotated_md=None,
        title="p",
        grade="",
        subject="",
        source_pdf=None,
        page_count=0,
        units=(
            PreprocessedUnit(
                unit_id="Q1",
                unit_type="single_choice",
                question_type="single_choice",
                question_numbers=(1,),
                stem="没有选项的选择题",
                options={},
                answer="C",
            ),
            PreprocessedUnit(
                unit_id="Q2",
                unit_type="single_choice",
                question_type="single_choice",
                question_numbers=(2,),
                stem="答案无法识别的选择题",
                options={"A": "甲", "B": "乙"},
                answer="这是一段解析而不是选项",
            ),
        ),
    )

    assert to_question_bank_items(paper) == []


@pytest.mark.asyncio
async def test_import_to_question_bank_writes_ungraded_entries(tmp_path: Path) -> None:
    from deeptutor.services.session.sqlite_store import SQLiteSessionStore

    paper = load_preprocessed_paper(_write_paper(tmp_path), root=tmp_path)
    store = SQLiteSessionStore(tmp_path / "sessions.db")

    written, skipped = await import_to_question_bank([paper], store=store)

    assert (written, skipped) == (2, 0)
    listing = await store.list_notebook_entries()
    assert listing["total"] == 2
    assert {item["result"] for item in listing["items"]} == {"ungraded"}
    assert {item["source"] for item in listing["items"]} == {"import"}
