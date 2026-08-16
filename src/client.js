// dsh-plugin-undo — Client half.
//
// The host makes `/undo` model-invisible: it appends an empty assistant
// surface replacement inside a synthetic maintenance turn. This client half
// reads the successful `/undo` command nodes already present in the chat
// snapshot and folds every undone turn:
//
//   - the first row of each undone turn becomes a compact header:
//     "↩ 第 N 轮已撤销 · 点击展开"
//   - the remaining rows of that turn are hidden
//   - clicking the header expands/collapses the turn in place
//
// The fold is DOM/CSS over the chat flow, so built-in renderers (tool cards,
// command cards, turn tails) remain untouched.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-undo',
  factory: (require) => {
    const React = require('react')
    const HEADER_ATTR = 'data-dsh-undo-header'
    const HIDDEN_ATTR = 'data-dsh-undo-hidden'
    const OPEN_ATTR = 'data-dsh-undo-open'
    const TURN_ATTR = 'data-dsh-undo-turn'

    // Expansion state lives outside React; the DOM controller owns folds.
    const expandedBySession = new Map()

    let currentSessionId = undefined
    let currentSession = undefined
    let currentSessionOff = undefined
    let listOff = undefined
    let observer = undefined
    let clickHandler = undefined
    let foldFrame = 0
    let styleElement

    const expandedTurns = (sessionId) => {
      let turns = expandedBySession.get(sessionId)
      if (!turns) {
        turns = new Map()
        expandedBySession.set(sessionId, turns)
      }
      return turns
    }

    const isTurnExpanded = (sessionId, turn) =>
      expandedTurns(sessionId).get(turn) === true

    const setTurnExpanded = (sessionId, turn, expanded) => {
      expandedTurns(sessionId).set(turn, expanded)
      scheduleFold()
    }

    // --- style -----------------------------------------------------------------

    function ensureStyle() {
      if (styleElement) return
      const css = [
        '[data-dsh-undo-header] { position: relative; cursor: pointer; }',
        '[data-dsh-undo-header]:not([data-dsh-undo-open]) > * { display: none !important; }',
        '[data-dsh-undo-header]:not([data-dsh-undo-open])::before {',
        '  content: "↩ 第 " attr(data-dsh-undo-turn) " 轮已撤销 · 点击展开";',
        '  display: block;',
        '  padding: 8px 10px;',
        '  border-radius: 8px;',
        '  border: 1px dashed rgba(128, 128, 128, 0.45);',
        '  background: rgba(128, 128, 128, 0.10);',
        '  color: var(--dsw-alias-label-tertiary, #8a8a8e);',
        '  font-size: 12px;',
        '  line-height: 16px;',
        '}',
        '[data-dsh-undo-header][data-dsh-undo-open]::before {',
        '  content: "↩ 第 " attr(data-dsh-undo-turn) " 轮已撤销 · 点击折叠";',
        '  display: block;',
        '  padding: 4px 8px;',
        '  margin-bottom: 6px;',
        '  border-radius: 6px;',
        '  background: rgba(128, 128, 128, 0.10);',
        '  color: var(--dsw-alias-label-tertiary, #8a8a8e);',
        '  font-size: 11px;',
        '  line-height: 16px;',
        '}',
        '[data-dsh-undo-header][data-dsh-undo-open] {',
        '  border-left: 3px solid rgba(128, 128, 128, 0.55);',
        '  padding-left: 8px;',
        '}',
        '[data-dsh-undo-hidden]:not([data-dsh-undo-open]) { display: none !important; }',
        '[data-dsh-undo-hidden][data-dsh-undo-open] {',
        '  border-left: 3px solid rgba(128, 128, 128, 0.55);',
        '  padding-left: 8px;',
        '  opacity: 0.92;',
        '}',
      ].join('\n')
      styleElement = document.createElement('style')
      styleElement.setAttribute('data-dsh-undo-style', '')
      styleElement.textContent = css
      document.head.appendChild(styleElement)
    }

    // --- hidden command confirmation -------------------------------------------

    // The command lifecycle still renders as a chat node and its result text is
    // what the fold controller parses. Visually, however, the row is suppressed:
    // the folded turn headers already tell the user what happened.
    const UndoCommandView = () => React.createElement(
      'span',
      { style: { display: 'none' }, 'data-dsh-undo-command': '' },
      null,
    )

    // --- undo metadata ---------------------------------------------------------

    // The host's command result is stable machine-readable prose:
    //   /undo 2  ->  "已撤销最近 2 轮：第 3, 4 轮已从模型可见历史中移除。"
    const UNDO_RESULT_TURNS = /第\s*([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\s*轮/

    function undoneTurnsFromCommand(node) {
      if (!node || node.kind !== 'command') return []
      const data = node.data || {}
      if (data.name !== 'undo') return []
      const outcome = data.outcome
      if (!outcome || outcome.kind !== 'success' || typeof outcome.text !== 'string') return []
      const match = UNDO_RESULT_TURNS.exec(outcome.text)
      if (!match) return []
      return match[1]
        .split(/[,，、\s]+/u)
        .map(value => Number(value))
        .filter(Number.isInteger)
    }

    function turnOf(node) {
      const location = node && node.location
      if (!location) return undefined
      if (location.kind === 'turn' || location.kind === 'step') return location.turn.turn
      return undefined
    }

    function undoMasks(snapshot) {
      const masks = new Set()
      const nodes = snapshot && snapshot.chat && snapshot.chat.nodes
      if (!nodes || typeof nodes.values !== 'function') return masks
      try {
        for (const node of nodes.values()) {
          for (const turn of undoneTurnsFromCommand(node)) masks.add(turn)
        }
      } catch {
        // A malformed command node must never break the fold controller.
      }
      return masks
    }

    // --- fold controller -------------------------------------------------------

    function clearFold(row) {
      row.removeAttribute(HEADER_ATTR)
      row.removeAttribute(HIDDEN_ATTR)
      row.removeAttribute(OPEN_ATTR)
      row.removeAttribute(TURN_ATTR)
    }

    function applyFoldToRow(row, turn, header, expanded) {
      row.setAttribute(TURN_ATTR, String(turn))
      if (header) {
        row.setAttribute(HEADER_ATTR, '')
        row.removeAttribute(HIDDEN_ATTR)
      } else {
        row.setAttribute(HIDDEN_ATTR, '')
        row.removeAttribute(HEADER_ATTR)
      }
      if (expanded) row.setAttribute(OPEN_ATTR, '')
      else row.removeAttribute(OPEN_ATTR)
    }

    function foldRows() {
      if (!currentSessionId || !currentSession) return
      let snapshot
      try {
        snapshot = currentSession.getSnapshot()
      } catch {
        return
      }
      const masks = undoMasks(snapshot)

      const flows = document.querySelectorAll('[data-chat-flow]')
      if (masks.size === 0) {
        for (const flow of flows) {
          for (const row of Array.from(flow.children)) {
            if (row.hasAttribute && (row.hasAttribute(HEADER_ATTR) || row.hasAttribute(HIDDEN_ATTR))) clearFold(row)
          }
        }
        return
      }

      for (const flow of flows) {
        const rows = Array.from(flow.children).filter(element =>
          element.hasAttribute && element.hasAttribute('data-chat-flow-key'))
        const byTurn = new Map()
        for (const row of rows) {
          const key = row.getAttribute('data-chat-flow-key')
          const node = snapshot.chat.nodes.get(key)
          if (!node) {
            clearFold(row)
            continue
          }
          const turn = turnOf(node)
          if (turn === undefined || !masks.has(turn)) {
            clearFold(row)
            continue
          }
          let group = byTurn.get(turn)
          if (!group) {
            group = []
            byTurn.set(turn, group)
          }
          group.push(row)
        }
        for (const [turn, group] of byTurn.entries()) {
          const expanded = isTurnExpanded(currentSessionId, turn)
          group.forEach((row, index) => {
            applyFoldToRow(row, turn, index === 0, expanded)
          })
        }
      }
    }

    function scheduleFold() {
      if (foldFrame !== 0) return
      foldFrame = requestAnimationFrame(() => {
        foldFrame = 0
        foldRows()
      })
    }

    function detachCurrentSession() {
      if (currentSessionOff) {
        currentSessionOff()
        currentSessionOff = undefined
      }
      currentSession = undefined
      currentSessionId = undefined
    }

    function refreshCurrentSession(ctx) {
      let current
      try {
        current = ctx.sessions.list.getSnapshot().current
      } catch {
        return
      }
      const session = current === undefined
        ? undefined
        : ctx.sessions.binding(current) && ctx.sessions.binding(current).session
      if (currentSessionId === current && currentSession === session) return
      detachCurrentSession()
      currentSessionId = current
      currentSession = session
      if (session) {
        currentSessionOff = session.subscribe(scheduleFold)
      }
      scheduleFold()
    }

    function installFoldController(ctx) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return

      listOff = ctx.sessions.list.subscribe(() => refreshCurrentSession(ctx))
      refreshCurrentSession(ctx)

      observer = new MutationObserver(() => scheduleFold())
      observer.observe(document.body, { childList: true, subtree: true })

      clickHandler = (event) => {
        if (!event.target || typeof event.target.closest !== 'function') return
        const header = event.target.closest(`[${HEADER_ATTR}]`)
        if (!header) return
        // Collapsed pseudo-label clicks target the row itself; expanded rows
        // must not collapse when the user interacts with their content.
        if (event.target !== header && header.contains(event.target)) return
        const turn = Number(header.getAttribute(TURN_ATTR))
        if (!Number.isInteger(turn) || currentSessionId === undefined) return
        setTurnExpanded(currentSessionId, turn, !isTurnExpanded(currentSessionId, turn))
      }
      document.addEventListener('click', clickHandler, true)
    }

    function disposeFoldController() {
      if (observer) {
        observer.disconnect()
        observer = undefined
      }
      if (clickHandler) {
        document.removeEventListener('click', clickHandler, true)
        clickHandler = undefined
      }
      if (listOff) {
        listOff()
        listOff = undefined
      }
      detachCurrentSession()
      if (styleElement && styleElement.parentNode) styleElement.parentNode.removeChild(styleElement)
      styleElement = undefined
    }

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          { name: 'conversation.chat.commandview', key: 'undo' },
          UndoCommandView,
        ))
      installFoldController(ctx)
      ctx.effect(() => () => disposeFoldController())
    }

    return { apply, inject: ['sessions', 'slots'] }
  },
})
