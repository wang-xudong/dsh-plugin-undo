/**
 * dsh-plugin-undo — Host half.
 *
 * `/undo [n|all]` rewinds the MODEL-VISIBLE conversation surface by
 * appending one EMPTY `assistant/message` with
 * `surfaceOp: { op: 'replace', start, end }` over the surface nodes of the
 * last n completed turns. Empty assistant content is skipped by message
 * derivation, so the model sees no undo checkpoint. The raw append-only
 * session log is left untouched; the client half reads the `/undo` command
 * result to fold the undone turns.
 *
 * The command runs only while the agent is idle, through `runMaintenance()`,
 * so the surface mutation is serialized against turn admission.
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-undo'
export const inject = ['commands', 'sessions']

const USAGE = '用法：/undo [n|all] — 撤销最近 n 轮（默认 1）'

/**
 * Parse the command's free-form input.
 * @param raw - exact text after `/undo `.
 * @param completed - number of completed turns in this session.
 * @returns the requested count, or an error string.
 */
function parseRequest(raw, completed) {
  const input = raw.trim()
  if (input === '') return { count: 1 }
  if (input === 'all') return { count: completed }
  if (!/^[1-9][0-9]*$/.test(input)) return { error: USAGE }
  const count = Number(input)
  if (!Number.isSafeInteger(count)) return { error: USAGE }
  return { count }
}

/**
 * Derive the turns still present in the CURRENT model-visible surface.
 * Raw `turn/end` events survive undo, so counting them would let a second
 * `/undo` target turns that are already replaced.
 */
function visibleTurns(session) {
  const events = session.events
  const nodes = new Set(session.surface.nodes)
  const turns = []
  let openTurn = undefined
  let startSeq = -1
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      startSeq = event.seq
      continue
    }
    if (event.type !== 'turn/end' || openTurn === undefined) continue
    let visible = false
    for (let seq = startSeq; seq <= event.seq; seq += 1) {
      if (nodes.has(seq)) {
        visible = true
        break
      }
    }
    if (visible) turns.push({ turn: openTurn, endSeq: event.seq })
    openTurn = undefined
  }
  return turns
}

function planUndo(session, count, visible) {
  const events = session.events
  if (visible.length === 0) return { error: '当前对话没有可撤销的已完成轮次。' }
  if (count > visible.length) count = visible.length

  // Keep every visible turn except the last `count`; the cut sits on the kept
  // turn's `turn/end` event. Undoing every visible turn cuts before seq 0.
  const undone = visible.slice(visible.length - count)
  const undoneTurns = undone.map(entry => entry.turn)
  const boundarySeq = count === visible.length
    ? -1
    : visible[visible.length - count - 1].endSeq

  // The current surface is the model's view, not the raw log. A previous
  // compaction or undo replacement can reorder surface positions relative to
  // event seqs, so verify that everything past the cut is a suffix; otherwise
  // refuse rather than replace a non-contiguous surface range.
  const nodes = session.surface.nodes
  let cutIndex = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index]
    if (events[seq] && events[seq].seq > boundarySeq) {
      cutIndex = index
      break
    }
  }
  if (cutIndex === -1) return { error: '该边界之后没有可撤销内容。' }
  for (let index = 0; index < cutIndex; index += 1) {
    const seq = nodes[index]
    if (!events[seq] || events[seq].seq > boundarySeq) {
      return { error: '对话 surface 已被压缩/替换重排，无法安全执行 undo。' }
    }
  }
  for (let index = cutIndex; index < nodes.length; index += 1) {
    const seq = nodes[index]
    if (!events[seq] || events[seq].seq <= boundarySeq) {
      return { error: '对话 surface 已被压缩/替换重排，无法安全执行 undo。' }
    }
  }
  const shadowed = nodes.slice(cutIndex)
  if (shadowed.length === 0) return { error: '没有可撤销内容。' }
  return {
    start: shadowed[0],
    end: shadowed[shadowed.length - 1],
    shadowed,
    undoneTurns,
    count: undoneTurns.length,
    boundarySeq,
  }
}

/**
 * Append the model-visible undo checkpoint and wait for durability.
 */
async function performUndo(ctx, invocation, signal) {
  signal?.throwIfAborted()
  const session = invocation.agent.session
  const visible = visibleTurns(session)
  const parsed = parseRequest(invocation.rawInput, visible.length)
  if (parsed.error) return { kind: 'error', text: parsed.error }
  const plan = planUndo(session, parsed.count, visible)
  if (plan.error) return { kind: 'error', text: plan.error }

  const label = `${plan.count} 轮`
  const turns = plan.undoneTurns.join(', ')

  // Surface replacement requires a message-producing event. Append an EMPTY
  // assistant message outside any turn boundary: `deriveMessages()` skips
  // empty assistant content, so the model sees only the retained history and
  // no undo checkpoint. Crucially, unlike a synthetic turn, this does NOT
  // touch the agent loop's turn numbering.
  const event = session.append('assistant/message', {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [],
      source: { provider: 'undo', model: 'undo' },
    }),
  }, {
    surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
    sourceEventSeqs: [...plan.shadowed],
  })
  signal?.throwIfAborted()
  await ctx.sessions.flush(session)
  return {
    kind: 'success',
    text: `已撤销最近 ${label}：第 ${turns} 轮已从模型可见历史中移除。`,
    sourceEventSeq: event.seq,
  }
}

/**
 * Register `/undo`.
 */
export function apply(ctx) {
  ctx.commands.register({
    name: 'undo',
    description: '撤销最近 n 轮对话',
    input: { hint: '轮数，如 1、3 或 all（默认 1）' },
    handler(invocation) {
      try {
        return invocation.agent.runMaintenance(maintenanceSignal => {
          const signal = AbortSignal.any([maintenanceSignal, invocation.signal])
          return performUndo(ctx, invocation, signal)
        })
      } catch (error) {
        if (invocation.signal.aborted) {
          return { kind: 'error', text: '撤销已取消。' }
        }
        return {
          kind: 'error',
          text: '撤销操作要求会话空闲，请先停止当前运行中的轮次。',
        }
      }
    },
  })
}
