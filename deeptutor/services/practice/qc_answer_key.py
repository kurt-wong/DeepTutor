# -*- coding: utf-8 -*-
"""QCore published-answer channel for server-side DT consumers.

The browser student view stays ``review_only`` (Owner 2026-11-23 ruling): no
answer/explanation is exposed through the Student API or the DT proxy.  This
module is the **server-side** capability for DeepTutor's own teaching/practice
code to read the approved answer key of a *published* QCore revision:

    QCore /internal/published/<question_id>   (token-protected)
        <-- X-QCore-Internal-Token: $QCORE_INTERNAL_TOKEN

Rules:
* token is read from the environment only; never logged, never returned to a
  client, never forwarded to the browser;
* only a currently PUBLISHED revision can be read (404 otherwise);
* no caching: every call reflects the current publication state;
* identity is the QCore ``question_id`` + ``revision_id`` pair.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class AnswerKeyDisabled(RuntimeError):
    """QCORE_INTERNAL_TOKEN is not configured on this deployment."""


class AnswerKeyUnavailable(RuntimeError):
    """QCore internal channel is unreachable / returned a server error."""


class AnswerKeyNotFound(RuntimeError):
    """Question is unpublished, withdrawn, or missing."""


def _base_url() -> str:
    return (
        os.environ.get("QCORE_INTERNAL_API_BASE")
        or os.environ.get("QCORE_STUDENT_API_BASE")
        or "http://127.0.0.1:8811"
    ).rstrip("/")


def fetch_published_bundle(question_id: str, timeout: float = 15.0) -> dict[str, Any]:
    """Return the published bundle (content + answers + explanation + assets).

    Raises :class:`AnswerKeyDisabled`, :class:`AnswerKeyNotFound` or
    :class:`AnswerKeyUnavailable` — never returns a placeholder for a question
    that cannot be read.
    """
    token = os.environ.get("QCORE_INTERNAL_TOKEN", "").strip()
    if not token:
        raise AnswerKeyDisabled("QCORE_INTERNAL_TOKEN is not configured")
    url = (
        f"{_base_url()}/internal/published/"
        f"{urllib.parse.quote(question_id, safe='')}"
    )
    request = urllib.request.Request(
        url, headers={"X-QCore-Internal-Token": token}, method="GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise AnswerKeyNotFound(question_id) from exc
        raise AnswerKeyUnavailable(f"qcore internal api error: {exc.code}") from exc
    except AnswerKeyNotFound:
        raise
    except AnswerKeyUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AnswerKeyUnavailable(f"qcore internal api unreachable: {exc}") from exc
