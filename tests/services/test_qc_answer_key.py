# -*- coding: utf-8 -*-
"""QCore server-side answer-key channel tests (QCORE-DT-MIN-INTEGRATION-01)."""

from __future__ import annotations

import pytest

from deeptutor.services.practice.qc_answer_key import (
    AnswerKeyDisabled,
    AnswerKeyNotFound,
    fetch_published_bundle,
)


def test_disabled_without_token(monkeypatch):
    monkeypatch.delenv("QCORE_INTERNAL_TOKEN", raising=False)
    with pytest.raises(AnswerKeyDisabled):
        fetch_published_bundle("q1")


def test_sends_token_and_parses_bundle(monkeypatch):
    monkeypatch.setenv("QCORE_INTERNAL_TOKEN", "t" * 32)
    seen = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"question_id":"q1","answers":[{"answer_value":"A"}]}'

    def fake_urlopen(request, timeout=15):
        seen["url"] = request.full_url
        seen["headers"] = dict(request.header_items())
        return _Resp()

    import deeptutor.services.practice.qc_answer_key as mod

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
    bundle = fetch_published_bundle("q1")
    assert bundle["answers"][0]["answer_value"] == "A"
    assert seen["url"].endswith("/internal/published/q1")
    header_keys = {k.lower(): v for k, v in seen["headers"].items()}
    assert header_keys.get("x-qcore-internal-token") == "t" * 32


def test_404_maps_to_not_found(monkeypatch):
    import urllib.error

    monkeypatch.setenv("QCORE_INTERNAL_TOKEN", "t" * 32)

    def fake_urlopen(request, timeout=15):
        raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)

    import deeptutor.services.practice.qc_answer_key as mod

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(AnswerKeyNotFound):
        fetch_published_bundle("missing")


def test_503_maps_to_unavailable(monkeypatch):
    import urllib.error

    monkeypatch.setenv("QCORE_INTERNAL_TOKEN", "t" * 32)

    def fake_urlopen(request, timeout=15):
        raise urllib.error.HTTPError(request.full_url, 503, "disabled", {}, None)

    import deeptutor.services.practice.qc_answer_key as mod

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
    from deeptutor.services.practice.qc_answer_key import AnswerKeyUnavailable

    with pytest.raises(AnswerKeyUnavailable):
        fetch_published_bundle("q1")
