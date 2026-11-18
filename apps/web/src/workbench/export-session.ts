import type { Turn } from '@shared/remote'

/**
 * Client-side session export (spec T4 parity: "export session (JSON/Markdown/HTML)"). JSON raw
 * export is excluded in the matrix (contract drift, frozen out of v1); Markdown + HTML render
 * from the timeline the client already holds — no new RPC.
 */

function stepToMarkdown(step: Turn['steps'][number]): string {
  if (step.kind === 'thinking') {
    return `<details><summary>Thinking${step.ms ? ` (${Math.round(step.ms / 100) / 10}s)` : ''}</summary>\n\n${step.text}\n\n</details>`
  }
  if (step.kind === 'tool') {
    const title = `\`${step.toolName}\` (${step.category}) — ${step.status}${step.ms ? ` · ${Math.round(step.ms / 100) / 10}s` : ''}`
    const preview = step.node.preview ? `\n\n\`\`\`\n${step.node.preview}\n\`\`\`` : ''
    return `- ${title}${preview}`
  }
  return step.text
}

export function timelineToMarkdown(title: string, turns: Turn[]): string {
  const parts: string[] = [`# ${title}`, '']
  for (const turn of turns) {
    parts.push(`## ▸ ${turn.user.text.replace(/\n+/g, ' ').slice(0, 160)}`)
    parts.push('')
    for (const step of turn.steps) parts.push(stepToMarkdown(step))
    if (turn.answer) {
      parts.push('', turn.answer)
    }
    if (turn.files.length > 0) {
      parts.push('', '**Files:** ' + turn.files.map((f) => `\`${f.path}\` (+${f.add}/-${f.del})`).join(', '))
    }
    if (turn.error) parts.push('', `> ⚠️ ${turn.error.kind}: ${turn.error.text}`)
    parts.push('')
  }
  return parts.join('\n')
}

/** Escape minimal HTML text content (used inside the sanitized export doc). */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

export function timelineToHtmlBody(turns: Turn[]): string {
  const sections = turns.map((turn) => {
    const steps = turn.steps
      .map((step) => {
        if (step.kind === 'thinking') {
          return `<details><summary>Thinking</summary><pre class="thinking">${esc(step.text)}</pre></details>`
        }
        if (step.kind === 'tool') {
          const preview = step.node.preview ? `<pre>${esc(step.node.preview)}</pre>` : ''
          return `<p class="tool"><strong>${esc(step.toolName)}</strong> <span class="muted">(${esc(step.category)} · ${step.status})</span>${preview}</p>`
        }
        return `<p class="prose">${esc(step.text)}</p>`
      })
      .join('\n')
    const files =
      turn.files.length > 0
        ? `<p class="files">${turn.files.map((f) => `<code>${esc(f.path)}</code> <span class="muted">+${f.add}/−${f.del}</span>`).join(' · ')}</p>`
        : ''
    const error = turn.error ? `<p class="error">${esc(turn.error.kind)}: ${esc(turn.error.text)}</p>` : ''
    return `<section class="turn"><h2>${esc(turn.user.text.replace(/\n+/g, ' ').slice(0, 160))}</h2>${steps}<div class="answer">${esc(turn.answer)}</div>${files}${error}</section>`
  })
  return sections.join('\n')
}
