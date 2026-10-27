// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function renderComposer(onSend: (...args: unknown[]) => Promise<void>) {
  return render(
    <Composer
      lang="en"
      hasModel
      modelLabel="test"
      live={null}
      onSend={onSend as never}
      onSteer={async () => undefined}
      onStop={() => undefined}
      onOpenSettings={() => undefined}
      draftKey="new"
    />,
  )
}

describe('composer drafts', () => {
  it('clears the persisted new-task draft before the task is created', async () => {
    window.localStorage.setItem('sa.draft:new', 'old draft')
    let finish!: () => void
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    renderComposer(onSend)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'sent question' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('sent question', [], [])
    expect(window.localStorage.getItem('sa.draft:new')).toBeNull()
    finish()
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('restores the text when sending fails', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('offline')
    })
    renderComposer(onSend)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'keep me' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(input.value).toBe('keep me'))
    expect(window.localStorage.getItem('sa.draft:new')).toBe('keep me')
  })
})
