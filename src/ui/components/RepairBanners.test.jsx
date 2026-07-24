// Rendered with react-dom directly rather than @testing-library/react: adding
// a devDependency to this repo means an npm install, which risks moving the
// ABI-pinned bare-* deps. The assertions are on text, so it costs little.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RepairingBanner } from './RepairBanners.jsx'

function render (element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(element) })
  return container
}

describe('RepairingBanner', () => {
  test('shows an indeterminate spinner while a repair runs', () => {
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' />)
    expect(c.textContent).toContain('Repairing Hudgins Family…')
    expect(c.querySelector('[data-testid="repair-spinner"]')).not.toBeNull()
  })

  test('keeps the spinner in the staged case', () => {
    // Regression for the reported bug: the staged banner suppressed the
    // spinner, so the one state that most needed a progress indicator was the
    // one state without one. The rebuild now retries on every foreground, so
    // it really is still in progress.
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' needsRestart />)
    expect(c.textContent).toContain('Finishing repair of Hudgins Family')
    expect(c.textContent).toContain('Reopen the app to finish repairing.')
    expect(c.querySelector('[data-testid="repair-spinner"]')).not.toBeNull()
  })

  test('escalating offers leave-and-rejoin instead of a promise', () => {
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' escalated />)
    expect(c.textContent).toContain('Repair is taking longer than usual')
    expect(c.textContent).toContain('leave it and rejoin from a fresh invite')
    expect(c.querySelector('[data-testid="repair-spinner"]')).toBeNull()
  })

  test('escalating overrides the staged copy', () => {
    // The heart of the bug: a staged repair used to be exempt from escalation
    // because "reopen the app" was believed to be a real path. It was not --
    // the worklet outlives the UI -- so the banner became a dead end that only
    // a force-stop could clear. Once the worklet gives up, say so.
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' needsRestart escalated />)
    expect(c.textContent).toContain('Repair is taking longer than usual')
    expect(c.textContent).not.toContain('Reopen the app to finish repairing.')
  })

  test('escalated banner surfaces a way out', () => {
    const onResolve = jest.fn()
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' escalated onResolve={onResolve} />)
    const button = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Open circle settings')
    expect(button).toBeDefined()
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onResolve).toHaveBeenCalled()
  })

  test('pluralises across circles', () => {
    const c = render(<RepairingBanner count={3} />)
    expect(c.textContent).toContain('Repairing 3 circles…')
  })
})

describe('RepairingBanner dismissal', () => {
  test('the escalated banner can be dismissed', () => {
    // Reported 2026-07-24: an escalated repair left a permanent bar over the
    // map that only a force-stop cleared. Nothing is running once escalated,
    // so the advice is dismissible.
    const onDismiss = jest.fn()
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' escalated onDismiss={onDismiss} />)
    const x = c.querySelector('button[aria-label="Dismiss"]')
    expect(x).not.toBeNull()
    act(() => { x.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onDismiss).toHaveBeenCalled()
  })

  test('an in-progress repair stays undismissable', () => {
    const c = render(<RepairingBanner count={1} circleName='Hudgins Family' onDismiss={jest.fn()} />)
    expect(c.querySelector('button[aria-label="Dismiss"]')).toBeNull()
  })
})
