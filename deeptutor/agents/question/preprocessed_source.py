"""Use a locally preprocessed paper as mimic-mode quiz templates.

The generic mimic path parses a PDF and then asks an LLM to find the
questions. A preprocessing pipeline that already produced anchored units has
done both steps, so re-running them only adds cost and drift. This adapter
reads those units directly and hands the pipeline the same
:class:`QuizTemplate` objects it would otherwise build from the extractor.
"""

from __future__ import annotations

from pathlib import Path

from deeptutor.agents.question.pipeline import QuizTemplate
from deeptutor.services.preprocessed_papers import (
    load_preprocessed_paper,
    resolve_manifest,
)

# Reference text is clipped so a long composite material block does not crowd
# the per-question prompt.
_TOPIC_CLIP_CHARS = 240


def is_preprocessed_paper(path: str | Path) -> bool:
    """Return whether ``path`` points at a supported preprocessed paper."""
    try:
        return resolve_manifest(path) is not None
    except ValueError:
        return False


def parse_preprocessed_paper_to_templates(
    paper_path: str | Path,
    *,
    max_questions: int,
) -> tuple[list[QuizTemplate], dict[str, str]]:
    """Convert anchored units into mimic templates without OCR or extraction."""
    manifest = resolve_manifest(paper_path)
    if manifest is None:
        raise ValueError(f"No preprocessed paper manifest found at {paper_path}")
    paper = load_preprocessed_paper(manifest)
    units = list(paper.units)
    if max_questions > 0:
        units = units[:max_questions]

    templates: list[QuizTemplate] = []
    for index, unit in enumerate(units, 1):
        reference = unit.reference_question()
        if not reference:
            continue
        templates.append(
            QuizTemplate(
                question_id=f"pre_{unit.unit_id or index}",
                topic=reference[:_TOPIC_CLIP_CHARS],
                question_type=unit.pipeline_question_type,
                difficulty="medium",
                source="mimic",
                reference_question=reference,
                reference_answer=unit.answer or None,
            )
        )
    trace = {
        "paper_dir": str(manifest.parent),
        "manifest": str(manifest),
        "source_md": str(paper.source_md or ""),
        "template_count": str(len(templates)),
        "preprocessed": "true",
    }
    return templates, trace


__all__ = ["is_preprocessed_paper", "parse_preprocessed_paper_to_templates"]
