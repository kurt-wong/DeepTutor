'use client'

import Markdown from '@/components/common/MarkdownRenderer'
import { practiceMarkdown } from '@/lib/practice-content'
import { randomUuid } from '@/lib/random-uuid'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'
import {
  checkPracticeAnswer,
  getPracticeQuestion,
  PracticeRequestError,
  savePracticeReview,
  type PracticeQuestion,
  type PracticeRef,
  type PracticeRating,
} from '@/lib/practice-api'
import { refKey, type PracticeSourceRef } from '@/lib/practice-source'
import {
  listQcorePracticeRefs,
  loadQcorePracticeQuestion,
  reviewQcorePractice,
  type QcPracticeQuestion,
} from '@/lib/qcore-adapter/practice-provider'
import { QCorePracticeView } from '@/components/qcore/QCorePracticeView'

const RATINGS: { value: PracticeRating; label: string; description: string }[] = [
  { value: 'again', label: 'Again', description: 'Practice again this round' },
  { value: 'hard', label: 'Hard', description: 'I needed a hint' },
  { value: 'good', label: 'Mastered', description: 'Review in a few days' },
  { value: 'easy', label: 'Easy', description: 'I knew it confidently' },
]

export function PracticeSession({
  ids,
  questions,
  sourceItems,
  onClose,
  backLabel,
}: {
  ids?: number[]
  questions?: PracticeRef[]
  /** B-2 Spike：Provider 给出的题源队列（qcore/notebook）。给定时优先于 ids/questions。 */
  sourceItems?: PracticeSourceRef[]
  onClose: () => void
  backLabel?: string
}) {
  const [queue, setQueue] = useState<PracticeSourceRef[]>(
    () =>
      sourceItems ??
      ((questions ?? (ids ?? []).map(id => ({ id }))) as PracticeRef[]).map(q => ({
        kind: 'notebook' as const,
        entryId: q.id,
        workspaceId: q.content_workspace_id,
      }))
  )
  const [total] = useState(queue.length)
  const [skipped, setSkipped] = useState(0)
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const [saved, setSaved] = useState(0)
  const [saving, setSaving] = useState(false)
  const [nextDue, setNextDue] = useState<number | null>(null)
  const dueDates = useRef(new Map<string, number>())
  const complete = index >= queue.length
  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} />
          {backLabel ?? t('Back to practice')}
        </button>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('{{count}} remaining', { count: total - saved - skipped })}
        </p>
      </div>
      <progress
        max={total || 1}
        value={saved}
        aria-label={t('Practice progress')}
        className="mb-6 h-1.5 w-full accent-primary"
      />
      {complete ? (
        <div className="rounded-2xl border border-border bg-card px-6 py-12 text-center">
          <CheckCircle2 className="mx-auto mb-4 text-emerald-600" size={32} />
          <h2 className="font-serif text-2xl font-semibold">{t('Practice complete')}</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('{{count}} reviews saved. Your next review dates have been updated.', {
              count: saved,
            })}
          </p>
          {skipped > 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('{{count}} skipped questions remain due.', { count: skipped })}
            </p>
          )}
          {nextDue && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Next review: {{date}}', { date: new Date(nextDue * 1000).toLocaleDateString() })}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-6 rounded-xl bg-primary px-5 py-2.5 text-sm text-primary-foreground"
          >
            {backLabel ?? t('Back to practice')}
          </button>
        </div>
      ) : (
        <PracticeTurn
          key={`${index}:${refKey(queue[index])}`}
          sourceRef={queue[index]}
          onBusy={setSaving}
          onSaved={(due, rating) => {
            if (rating === 'again') setQueue(current => [...current, current[index]])
            else setSaved(value => value + 1)
            if (due !== null) {
              dueDates.current.set(refKey(queue[index]), due)
              setNextDue(Math.min(...dueDates.current.values()))
            }
            setIndex(value => value + 1)
          }}
          onSkip={() => {
            setSkipped(value => value + 1)
            setIndex(value => value + 1)
          }}
        />
      )}
    </section>
  )
}

function PracticeTurn({
  sourceRef,
  onSaved,
  onSkip,
  onBusy,
}: {
  sourceRef: PracticeSourceRef
  onSaved: (due: number | null, rating: PracticeRating) => void
  onSkip: () => void
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const id = sourceRef.kind === 'notebook' ? sourceRef.entryId : -1
  const isQc = sourceRef.kind === 'qcore'
  const [question, setQuestion] = useState<PracticeQuestion | null>(null)
  const [qc, setQc] = useState<QcPracticeQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [correct, setCorrect] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  const pending = useRef(false)
  const submission = useRef<{
    request_id: string
    version: number
    rating: PracticeRating
    answer: string
    self_report?: boolean
  } | null>(null)
  useEffect(() => {
    let active = true
    if (sourceRef.kind === 'qcore') {
      void loadQcorePracticeQuestion(sourceRef.questionId, sourceRef.revisionId)
        .then(result => {
          if (active) setQc(result)
        })
        .catch(err => {
          if (active) setError(String(err.message || err))
        })
    } else {
      void getPracticeQuestion(sourceRef.entryId, sourceRef.workspaceId)
        .then(result => {
          if (active) setQuestion(result)
        })
        .catch(err => {
          if (active) setError(String(err.message || err))
        })
    }
    return () => {
      active = false
    }
  }, [sourceRef, reload])
  async function reveal() {
    if (pending.current || (isQc ? !qc : !question)) return
    pending.current = true
    setBusy(true)
    onBusy(true)
    setError('')
    try {
      if (isQc) {
        // review_only 自检路径：无参考答案可校验，不调用判分、不伪造 correct。
        setCorrect(null)
        setRevealed(true)
      } else {
        const verdict = await checkPracticeAnswer(
          sourceRef.kind === 'notebook' ? sourceRef.entryId : id,
          answer,
          sourceRef.kind === 'notebook' ? sourceRef.workspaceId : undefined,
        )
        setCorrect(verdict.correct)
        setRevealed(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
      setBusy(false)
      onBusy(false)
    }
  }
  async function rate(rating: PracticeRating, selfReport = false) {
    if (pending.current || (isQc ? !qc : !question) || conflict) return
    pending.current = true
    setBusy(true)
    onBusy(true)
    setError('')
    // Retrying a lost response must reuse its ID and exact payload.
    submission.current ??= {
      request_id: randomUuid(),
      version: isQc ? (qc?.state.version ?? 0) : (question?.state.version ?? 0),
      rating,
      answer,
      self_report: selfReport,
    }
    try {
      if (isQc && sourceRef.kind === 'qcore') {
        // QCore 车道：身份=(question_id, revision_id)，correct 恒 null（已作答/未判分）。
        const result = await reviewQcorePractice(
          { questionId: sourceRef.questionId, revisionId: sourceRef.revisionId },
          {
            request_id: submission.current.request_id,
            version: submission.current.version,
            rating: submission.current.rating,
            answer: submission.current.answer,
          },
        )
        onSaved(result.due_at, result.rating)
      } else {
        const result = await savePracticeReview(
          sourceRef.kind === 'notebook' ? sourceRef.entryId : id,
          submission.current,
          sourceRef.kind === 'notebook' ? sourceRef.workspaceId : undefined,
        )
        onSaved(result.due_at, result.rating)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const status =
        err instanceof PracticeRequestError
          ? err.status
          : (err as { status?: number }).status
      if (status === 409) setConflict(true)
    } finally {
      pending.current = false
      setBusy(false)
      onBusy(false)
    }
  }
  function reset() {
    setQuestion(null)
    setAnswer('')
    setRevealed(false)
    setCorrect(null)
    setError('')
    setConflict(false)
    submission.current = null
    setReload(value => value + 1)
  }
  const entry = question?.entry
  const qcReady = isQc && qc !== null
  const multi =
    entry?.question_type === 'multi_choice' || entry?.question_type === 'multiple_select'
  const choices = Object.entries(entry?.options || {})
  return (
    <div className="rounded-2xl border border-border bg-card p-5 sm:p-8">
      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
          <p>{error}</p>
          {(conflict || !entry) && (
            <button type="button" onClick={reset} className="mt-2 underline">
              {t('Reload question')}
            </button>
          )}
        </div>
      )}
      {isQc ? (
        qcReady && qc ? (
          <>
            <QCorePracticeView
              question={qc.question}
              identity={qc.identity}
              revealed={revealed}
              answer={answer}
              onAnswer={setAnswer}
            />
            {!revealed ? (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reveal()}
                  className="rounded-xl bg-primary px-4 py-2.5 text-sm text-primary-foreground disabled:opacity-50"
                >
                  {busy ? t('Checking…') : t('Check and reveal answer')}
                </button>
                <button
                  type="button"
                  disabled={busy || conflict}
                  onClick={() => void rate('good', true)}
                  className="rounded-xl border border-border px-4 py-2.5 text-sm hover:bg-muted"
                >
                  {t('I have mastered this')}
                </button>
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={busy}
                  className="text-sm text-muted-foreground hover:underline"
                >
                  {t('Skip for now')}
                </button>
              </div>
            ) : (
              <div className="mt-6 space-y-5">
                <div>
                  <h3 className="text-sm font-medium">{t('How well did you remember?')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      'Mastered questions leave this round and return when your next review is due.',
                    )}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {RATINGS.map(rating => (
                      <button
                        key={rating.value}
                        aria-label={`${t(rating.label)} ${t(rating.description)}`}
                        type="button"
                        disabled={
                          busy ||
                          conflict ||
                          (!!submission.current && submission.current.rating !== rating.value)
                        }
                        onClick={() => void rate(rating.value, true)}
                        className="rounded-xl border border-border p-3 text-left transition hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <span className="block text-sm font-semibold">{t(rating.label)}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t(rating.description)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                {busy && (
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <Loader2 size={15} className="animate-spin" />
                    {t('Saving review…')}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <p role="status" className="py-8 text-sm text-muted-foreground">
            {t('Loading…')}
          </p>
        )
      ) : !entry ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          {t('Loading…')}
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{entry.material_title || t('Practice')}</span>
            {entry.categories?.map(tag => (
              <span key={tag.id} className="rounded-full bg-muted px-2 py-1">
                {tag.name}
              </span>
            ))}
          </div>
          <div className="text-base leading-relaxed">
            <Markdown
              learningTextSize={16}
              content={practiceMarkdown(entry.question)}
              allowHtml={false}
              className="[overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto"
            />
          </div>
          {multi && (
            <p className="mt-3 text-xs text-muted-foreground">{t('Select all correct answers')}</p>
          )}
          {choices.length > 0 ? (
            <fieldset disabled={revealed || busy} className="mt-6 grid gap-2">
              <legend className="sr-only">{t('Your answer')}</legend>
              {choices.map(([key, text]) => {
                const selected = multi ? answer.split(',').includes(key) : answer === key
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
                  >
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={`practice-${id}`}
                      checked={selected}
                      value={key}
                      onChange={() =>
                        setAnswer(
                          multi
                            ? (selected
                                ? answer.split(',').filter(value => value !== key)
                                : [...answer.split(',').filter(Boolean), key]
                              )
                                .sort()
                                .join(',')
                            : key
                        )
                      }
                      className="mt-1 accent-primary"
                    />
                    <span className="font-semibold">{key}</span>
                    <div className="min-w-0">
                      <Markdown learningTextSize={16} content={practiceMarkdown(text)} allowHtml={false} />
                    </div>
                  </label>
                )
              })}
            </fieldset>
          ) : (
            <label className="mt-6 block text-sm font-medium">
              {t('Your answer')}
              <textarea
                value={answer}
                onChange={event => setAnswer(event.target.value)}
                disabled={revealed || busy}
                maxLength={20000}
                rows={5}
                placeholder={t('Try recalling the answer before revealing it.')}
                className="mt-2 block w-full resize-y rounded-xl border border-border bg-background p-3 font-normal outline-none focus:border-primary"
              />
            </label>
          )}
          {!revealed ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void reveal()}
                className="rounded-xl bg-primary px-4 py-2.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                {busy ? t('Checking…') : t('Check and reveal answer')}
              </button>
              <button
                type="button"
                disabled={busy || conflict}
                onClick={() => void rate('good', true)}
                className="rounded-xl border border-border px-4 py-2.5 text-sm hover:bg-muted"
              >
                {t('I have mastered this')}
              </button>
              <button
                type="button"
                onClick={onSkip}
                disabled={busy}
                className="text-sm text-muted-foreground hover:underline"
              >
                {t('Skip for now')}
              </button>
            </div>
          ) : (
            <div className="mt-6 space-y-5">
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="mb-3 text-sm font-semibold">
                  {correct === null
                    ? t('Compare your answer with the reference')
                    : correct
                      ? t('Correct')
                      : t('Needs another try')}
                </p>
                <div className="text-sm">
                  <Markdown
                    learningTextSize={16}
                    content={
                      entry.correct_answer ||
                      t(
                        'No reference answer was saved. Use the original source to check your work.'
                      )
                    }
                  />
                  {entry.explanation && (
                    <div className="mt-3 border-t border-border pt-3">
                      <Markdown learningTextSize={16} content={entry.explanation} />
                    </div>
                  )}
                </div>
              </div>
              {correct !== null ? (
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-xs text-muted-foreground">
                    {correct
                      ? t(
                          'Mastered questions leave this round and return when your next review is due.'
                        )
                      : t('Practice again this round')}
                  </p>
                  <button
                    type="button"
                    disabled={busy || conflict}
                    onClick={() => void rate(correct ? 'good' : 'again')}
                    className="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
                  >
                    {correct ? t('Mastered · Next question') : t('Practice again')}
                  </button>
                </div>
              ) : (
                <div>
                  <h3 className="text-sm font-medium">{t('How well did you remember?')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      'Mastered questions leave this round and return when your next review is due.'
                    )}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {RATINGS.map(rating => (
                      <button
                        key={rating.value}
                        aria-label={`${t(rating.label)} ${t(rating.description)}`}
                        type="button"
                        disabled={
                          busy ||
                          conflict ||
                          (!!submission.current && submission.current.rating !== rating.value)
                        }
                        onClick={() => void rate(rating.value)}
                        className="rounded-xl border border-border p-3 text-left transition hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <span className="block text-sm font-semibold">{t(rating.label)}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t(rating.description)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {busy && (
                <p role="status" className="flex items-center gap-2 text-sm">
                  <Loader2 size={15} className="animate-spin" />
                  {t('Saving review…')}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
