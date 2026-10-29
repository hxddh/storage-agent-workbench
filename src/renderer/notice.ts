import type { ThreadItem } from '@shared/conversation'
import type { Dict } from './i18n'

type NoticeFact = Extract<ThreadItem, { kind: 'notice' }>

/** App notices are codes; provider errors are shown as their own text. */
export function noticeText(notice: NoticeFact, t: Dict): string {
  const base =
    notice.code === 'stopped'
      ? t.noticeStopped
      : notice.code === 'no_answer'
        ? t.noticeNoAnswer
        : notice.code === 'failed'
          ? t.noticeFailed
          : notice.code === 'budget'
            ? t.noticeBudget
            : ''
  if (!base) return notice.text
  return notice.text && notice.code !== 'stopped' ? `${base} ${notice.text}` : base
}
