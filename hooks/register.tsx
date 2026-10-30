import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { LastStep, Place, RateLimit, Segment, Snapshot, Span, Tally } from '../types'

// Band segments: the details panel's three, plus the ones a press acts on directly.
type Kind = Segment | 'dir' | 'git' | 'model'

const SEGMENTS: Segment[] = ['cost', 'context', 'quota']
const SECTION_TITLES: Record<Segment, string> = {
  cost: 'Cost',
  context: 'Context',
  quota: 'Quotas',
}
// Same debounce as Claude Code applies to the status line command.
const DEBOUNCE_MS = 300

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const selected = atom({ plugin: 'usage-band', key: 'selected' } as const, 'cost')
// The details panel unfolds inside the band, under the status line: a docked
// Pane would sit beside the transcript in fullscreen, not at the bottom.
const isExpanded = atom({ plugin: 'usage-band', key: 'isExpanded' } as const, false)
const line = atom({ plugin: 'usage-band', key: 'line' } as const, [], { shape: 'line-1' })
const lastStep = atom({ plugin: 'usage-band', key: 'lastStep' } as const, { outputTokens: 0 }, {
  shape: 'last-step-1',
})
const place = atom({ plugin: 'usage-band', key: 'place' } as const, null, { shape: 'place-1' })
const tally = atom({ plugin: 'usage-band', key: 'tally' } as const, null, { shape: 'tally-1' })

// --- Formatting helpers (no Intl assumed in the mod runtime) ---

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad2 = (n: number) => String(n).padStart(2, '0')

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const resetLabel = (iso?: string) => {
  if (!iso) return '?'
  const d = new Date(iso)
  const isToday = d.toDateString() === new Date().toDateString()
  return isToday ? clock(d.getTime()) : `${WEEKDAYS[d.getDay()]} ${clock(d.getTime())}`
}

const thousands = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

// 92,840 -> 92K, 1,250,000 -> 1.2M.
const compact = (n: number) =>
  n >= 1_000_000 ? `${(Math.floor(n / 100_000) / 10).toFixed(1)}M` : n >= 1000 ? `${Math.floor(n / 1000)}K` : String(Math.round(n))

const usd = (v?: number, digits = 2) => (v === undefined ? '$—' : `$${v.toFixed(digits)}`)

const duration = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad2(minutes % 60)}`
}

// Share of the input the prompt cache served.
const cacheHit = (t: Tally) => {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? 0 : Math.round((t.cacheRead / total) * 100)
}

// A cost total: 4 decimals under $1, 2 from $1 up, as the status line script.
const cost = (v?: number) => usd(v, v !== undefined && v < 1 ? 4 : 2)

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const windowName = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'budget' : kind

const contextColor = (p?: number) =>
  p === undefined ? 'inactive' : p > 75 ? 'error' : p >= 20 ? 'warning' : 'suggestion'

const quotaColor = (p: number) => (p >= 95 ? 'error' : p > 60 ? 'warning' : 'success')

const toSnapshot = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, startedAt: number): Snapshot => ({
  startedAt,
  costUsd: u.cost?.usd,
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  rateLimits: u.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
})

// --- Status line replica: run the configured command, decode its ANSI ---

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const ANSI_BRIGHT = ['gray', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright']
// xterm 256-color cube and grey ramp, for `38;5;n` past the 16 named colors.
const xterm256 = (n: number) => {
  if (n < 8) return ANSI_NAMES[n]
  if (n < 16) return ANSI_BRIGHT[n - 8]
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  if (n >= 232) {
    const g = 8 + (n - 232) * 10
    return `#${hex(g)}${hex(g)}${hex(g)}`
  }
  const i = n - 16
  const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)
  return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`
}

// The status line script's model color, `38;5;139`.
const MODEL_COLOR = xterm256(139)

const parseAnsi = (input: string): Span[] => {
  const spans: Span[] = []
  let style: Omit<Span, 'text'> = {}
  let last = 0
  const sgr = /\x1b\[([0-9;]*)m/g
  for (let m = sgr.exec(input); m !== null; m = sgr.exec(input)) {
    if (m.index > last) spans.push({ text: input.slice(last, m.index), ...style })
    last = sgr.lastIndex
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0
      if (c === 0) style = {}
      else if (c === 1) style = { ...style, bold: true }
      else if (c === 2) style = { ...style, dim: true }
      else if (c === 22) style = { ...style, bold: undefined, dim: undefined }
      else if (c === 39) style = { ...style, color: undefined }
      else if (c >= 30 && c <= 37) style = { ...style, color: ANSI_NAMES[c - 30] }
      else if (c >= 90 && c <= 97) style = { ...style, color: ANSI_BRIGHT[c - 90] }
      else if (c === 38 && codes[i + 1] === 5) {
        style = { ...style, color: xterm256(codes[i + 2] ?? 0) }
        i += 2
      } else if (c === 38 && codes[i + 1] === 2) {
        const hex = (v?: number) => (v ?? 0).toString(16).padStart(2, '0')
        style = { ...style, color: `#${hex(codes[i + 2])}${hex(codes[i + 3])}${hex(codes[i + 4])}` }
        i += 4
      }
    }
  }
  if (last < input.length) spans.push({ text: input.slice(last), ...style })
  return spans
}

// "claude-opus-5-5" -> "Opus 5.5", as the status line's model.display_name.
const displayName = (modelId: string) => {
  const parts = modelId.replace(/\[.*\]$/, '').replace(/^claude-/, '').split('-')
  const family = parts[0] ?? modelId
  const version = parts.slice(1).filter(p => /^\d{1,2}$/.test(p))
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join('.')}` : ''}`
}

// git@host:owner/repo.git, ssh://git@host/owner/repo.git or
// https://host/owner/repo.git -> https://host/owner/repo
const webUrlOf = (remote: string) => {
  const url = remote
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, 'https://$1/')
    .replace(/^https?:\/\/[^@/]+@/, 'https://')
    .replace(/\.git$/, '')
  return /^https?:\/\//.test(url) ? url : undefined
}

const treeUrl = (repoUrl: string, branch: string) => {
  const path = branch.split('/').map(encodeURIComponent).join('/')
  return repoUrl.includes('gitlab') ? `${repoUrl}/-/tree/${path}` : `${repoUrl}/tree/${path}`
}

const git = async ($: EngineInterface, cwd: string, args: string[]) => {
  try {
    const r = await $.process.run(['git', '-C', cwd, '--no-optional-locks', ...args], { timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// What Xcode opens for the folder: a workspace first, then a project, then a
// Swift package; none, and the folder itself opens.
const projectOf = async ($: EngineInterface, cwd: string) => {
  try {
    const names = (await $.fs.list(cwd)).map(entry => entry.name).sort()
    const found =
      names.find(n => n.endsWith('.xcworkspace')) ??
      names.find(n => n.endsWith('.xcodeproj')) ??
      names.find(n => n === 'Package.swift')
    return found ? `${cwd}/${found}` : undefined
  } catch {
    return undefined
  }
}

// The folder is the checkout's own root, a linked worktree's rather than the
// main repository's; the branch's page once origin has it, else the
// repository's home page.
const placeOf = async ($: EngineInterface, sessionCwd: string): Promise<Place> => {
  const cwd = (await git($, sessionCwd, ['rev-parse', '--show-toplevel'])) || sessionCwd
  const [remote, branch, project] = await Promise.all([
    git($, cwd, ['remote', 'get-url', 'origin']),
    git($, cwd, ['branch', '--show-current']),
    projectOf($, cwd),
  ])
  const repoUrl = remote ? webUrlOf(remote) : undefined
  if (!repoUrl || !branch) return { cwd, project, branch, webUrl: repoUrl }
  const isPushed = (await git($, cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) !== undefined
  return { cwd, project, branch, webUrl: isPushed ? treeUrl(repoUrl, branch) : repoUrl }
}

const exists = async ($: EngineInterface, path: string) => {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

// Rebuilds the stdin JSON Claude Code hands the status line command, from
// what a mod can read, then runs the configured command on it.
const renderStatusLine = async ($: EngineInterface): Promise<Span[] | null> => {
  const statusLine = (await $.settings.read({ key: 'statusLine' })) as
    | { type?: string; command?: string }
    | undefined
  const [usage, step, sessionId, cwd, root, home] = await Promise.all([
    $.session.usage(),
    read($, lastStep),
    $.session.id(),
    $.session.cwd(),
    $.session.root(),
    $.env.get('HOME'),
  ])

  // Falls back to the script itself, so the band keeps working once the
  // classic status line is removed from the settings: the copy in ~/.claude
  // first, else the one this mod ships.
  let command = statusLine?.type === 'command' && statusLine.command ? statusLine.command : undefined
  if (!command) {
    const ownCopy = `${home ?? ''}/.claude/statusline-command.sh`
    const script = (await exists($, ownCopy)) ? ownCopy : `${$.plugin.root}/statusline-command.sh`
    command = `bash "${script}"`
  }
  const projects = `${home ?? ''}/.claude/projects`
  const candidates = [root, cwd].map(dir => `${projects}/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`)
  let transcriptPath: string | undefined
  for (const path of candidates) {
    if (await exists($, path)) {
      transcriptPath = path
      break
    }
  }

  const modelId = step.model ?? (await $.session.model())
  const rateLimits: Record<string, { used_percentage: number; resets_at?: number }> = {}
  for (const r of usage.rateLimits) {
    rateLimits[r.kind] = {
      used_percentage: r.percentUsed,
      resets_at: r.resetsAt ? Math.floor(Date.parse(r.resetsAt) / 1000) : undefined,
    }
  }
  const percent = usage.context.percent
  const input = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    workspace: { current_dir: cwd, project_dir: root },
    model: { id: modelId, display_name: displayName(modelId) },
    effort: step.effort ? { level: step.effort } : undefined,
    cost: { total_cost_usd: usage.cost?.usd ?? 0 },
    context_window: {
      total_input_tokens: usage.context.tokens ?? 0,
      total_output_tokens: step.outputTokens,
      context_window_size: usage.context.window,
      used_percentage: percent,
      remaining_percentage: percent === undefined ? undefined : 100 - percent,
    },
    rate_limits: rateLimits,
  }

  const result = await $.process.run(['/bin/sh', '-c', command], {
    cwd,
    stdin: JSON.stringify(input),
    timeoutMs: 5000,
  })
  if (result.exitCode !== 0) return null
  return parseAnsi(result.stdout.split('\n')[0] ?? '')
}

// Splits the decoded line on the script's dim " | " separator, so each
// segment can carry its own hover card and press.
const segmentsOf = (spans: Span[]) => {
  const groups: Span[][] = [[]]
  for (const span of spans) {
    if (span.dim && span.text === ' | ') groups.push([])
    else groups[groups.length - 1]?.push(span)
  }
  return groups.filter(g => g.length > 0)
}

const kindOf = (group: Span[]): Kind | undefined => {
  const text = group.map(s => s.text).join('')
  if (text.startsWith('→')) return 'dir'
  if (text.startsWith('git:(')) return 'git'
  if (text.startsWith('$')) return 'cost'
  if (text.startsWith('ctx')) return 'context'
  if (text.includes('↻')) return 'quota'
  // The model closes the line in greyed plum (magenta before), the last
  // response time after it in magenta.
  const color = group[0]?.color
  if ((color === MODEL_COLOR || color === 'magenta') && !/^\d{2}:\d{2}:\d{2}$/.test(text)) return 'model'
  return undefined
}

// The band keeps each segment short: the cost's token count and the model's
// effort move to the hover card.
const TRIMS: Partial<Record<Kind, RegExp>> = {
  cost: /\s*\([\d.]+[KM]? tokens?\)/,
  model: /\s*\([^)]*\)\s*$/,
}

const trimmed = (kind: Kind | undefined, group: Span[]) => {
  const pattern = kind ? TRIMS[kind] : undefined
  if (!pattern) return group
  return group.map(span => ({ ...span, text: span.text.replace(pattern, '') })).filter(span => span.text !== '')
}

// --- Hover card texts ---

const effortCard = (step: LastStep) => {
  const model = step.model ? `${displayName(step.model)} (${step.model})` : 'session model'
  if (!step.effort) return `Model: ${model} · effort: model default`
  return `Model: ${model} · effort: ${step.effort}`
}

const hoverCard = (s: Kind, snap: Snapshot, where: Place | null, step: LastStep) => {
  switch (s) {
    case 'dir':
      return where ? `! open ${where.cwd}` : 'Open the folder'
    case 'git':
      return where?.webUrl ? `Launch ${where.webUrl}` : 'No origin remote to launch'
    case 'model':
      return effortCard(step)
    case 'cost': {
      const hours = Math.max((Date.now() - snap.startedAt) / 3_600_000, 1 / 60)
      const rate = snap.costUsd === undefined ? '' : ` · ≈ ${usd(snap.costUsd / hours)}/h`
      // Same total as the status line script: context input plus last output.
      const tokens = (snap.contextTokens ?? 0) + step.outputTokens
      return `Session cost: ${cost(snap.costUsd)} · ${compact(tokens)} tokens since ${clock(snap.startedAt)}${rate}`
    }
    case 'context': {
      if (snap.contextTokens === undefined) return 'Context: no response in this window yet'
      const left = snap.contextWindow - snap.contextTokens
      return `Context: ${thousands(snap.contextTokens)} / ${thousands(snap.contextWindow)} tokens · ${thousands(left)} left`
    }
    case 'quota':
      return snap.rateLimits.length === 0
        ? 'Quotas: no reading yet'
        : 'Quotas: ' +
            snap.rateLimits
              .map(r => `${windowName(r.kind)} ${r.percentUsed}% (reset ${resetLabel(r.resetsAt)})`)
              .join(' · ')
  }
}

// Debounced, single-flight refresh of the status line replica: a trigger
// during a run schedules one more run after it.
let pending: { cancel: () => void } | undefined
let isRunning = false
let isDirty = false

async function refreshNow($: EngineInterface) {
  if (isRunning) {
    isDirty = true
    return
  }
  isRunning = true
  try {
    const [spans, where] = await Promise.all([
      renderStatusLine($),
      $.session.cwd().then(cwd => placeOf($, cwd)),
    ])
    await update($, place, () => where)
    if (spans) await update($, line, () => spans)
  } finally {
    isRunning = false
    if (isDirty) {
      isDirty = false
      schedule($)
    }
  }
}

function schedule($: EngineInterface) {
  pending?.cancel()
  pending = $.clock.after(DEBOUNCE_MS, () => void refreshNow($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-details',
      description: 'Show or hide the cost / context / quota details under the band',
    })
    const usage = await $.session.usage()
    await update($, snapshot, () => toSnapshot(usage, usage.startedAt))
    const result = await next(e)
    schedule($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    const startedAt = (await read($, snapshot))?.startedAt ?? (await $.session.usage()).startedAt
    await update($, snapshot, () => toSnapshot(e, startedAt))
    schedule($)

    return next(e)
  })

  // A main-thread model response is the status line's "new assistant message".
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) {
      const u = result.usage
      await update($, tally, t => {
        const base: Tally = t ?? { since: Date.now(), responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} }
        const m = base.byModel[u.model] ?? { responses: 0, output: 0 }
        return {
          ...base,
          responses: base.responses + 1,
          input: base.input + u.input_tokens,
          output: base.output + u.output_tokens,
          cacheRead: base.cacheRead + u.cache_read_input_tokens,
          cacheWrite: base.cacheWrite + u.cache_creation_input_tokens,
          byModel: { ...base.byModel, [u.model]: { responses: m.responses + 1, output: m.output + u.output_tokens } },
        }
      })
    }
    if (!e.agentId && result.usage) {
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      const step: LastStep = { outputTokens: result.usage.output_tokens, model: result.usage.model, effort }
      await update($, lastStep, () => step)
      schedule($)
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    schedule($)

    return result
  })

  on('command.run', { command: 'usage-details' }, async $ => {
    await update($, isExpanded, v => !v)

    return { text: (await read($, isExpanded)) ? 'Usage details shown.' : 'Usage details hidden.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const spans = await read($, line)
    const where = await read($, place)
    const step = await read($, lastStep)
    const current = await read($, selected)
    const expanded = await read($, isExpanded)
    const counts = await read($, tally)
    if (e.props.hasSurvey || snap === null || spans.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    // A press on the open tab's segment folds the panel; any other unfolds
    // it on that tab.
    const toggleDetails = (s: Segment) => {
      if (expanded && current === s) {
        void update($, isExpanded, () => false)
        return
      }
      void update($, selected, () => s)
      void update($, isExpanded, () => true)
    }
    const press = (kind: Kind) => {
      if (kind === 'dir') {
        if (where) void $.process.run(['open', where.project ?? where.cwd])
      } else if (kind === 'git') {
        if (where?.webUrl) void $.process.run(['open', where.webUrl])
      } else if (kind === 'model') {
        void $.ui.toast(effortCard(step))
      } else {
        toggleDetails(kind)
      }
    }
    const kinds = segmentsOf(spans)
      .map(kindOf)
      .filter((k): k is Kind => k !== undefined)
    // Padding the card to the full width makes it paint over the idle hint.
    const card = (text: string) => text.slice(0, cols).padEnd(cols, ' ')
    const styled = (span: Span) => (
      <Text color={span.color} bold={span.bold} dimColor={span.dim}>
        {span.text}
      </Text>
    )

    const statusRow = (
      <Box flexDirection="row">
        {segmentsOf(spans).map((group, i) => {
          const kind = kindOf(group)
          const separator = i > 0 ? <Text dimColor> | </Text> : null
          if (!kind) {
            return (
              <Box flexDirection="row">
                {separator}
                {trimmed(kind, group).map(styled)}
              </Box>
            )
          }
          return (
            <Box flexDirection="row">
              {separator}
              <Button key={`segment-${kind}`} plain hover={{ scope: `usage-${kind}` }} onPress={() => press(kind)}>
                {trimmed(kind, group).map(styled)}
              </Button>
            </Box>
          )
        })}
      </Box>
    )
    const hoverRow = (
      <Box height={1} width={cols}>
        <Text dimColor>{card('hover: details · click: open')}</Text>
        {kinds.map(s => (
          <Box position="absolute" top={0} left={0} display="none" hover={{ scope: `usage-${s}`, display: 'flex' }}>
            <Text>{card(hoverCard(s, snap, where, step))}</Text>
          </Box>
        ))}
      </Box>
    )

    if (!expanded) {
      return (
        <Box flexDirection="column" width={cols} marginTop={1}>
          {statusRow}
          {hoverRow}
        </Box>
      )
    }

    const barWidth = Math.max(10, Math.min(30, cols - 40))
    // Label column, then the value dimmed, as the artifacts browser lays its rows.
    const labelWidth = Math.max(16, Math.min(36, Math.floor(cols / 2) - 4))

    const heading = (text: string) => (
      <Box marginTop={1} paddingLeft={2}>
        <Text bold>{text}</Text>
      </Box>
    )
    const row = (label: string, value: string, color?: string) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Text>{label.slice(0, labelWidth - 1).padEnd(labelWidth, ' ')}</Text>
        {color ? <Text color={color}>{value}</Text> : <Text dimColor>{value}</Text>}
      </Box>
    )

    let body
    if (current === 'cost') {
      const hours = Math.max((Date.now() - snap.startedAt) / 3_600_000, 1 / 60)
      body = (
        <Box flexDirection="column">
          {heading('Session')}
          {row('Total cost', cost(snap.costUsd), 'text')}
          {row('Started at', clock(snap.startedAt))}
          {row('Duration', duration(Date.now() - snap.startedAt))}
          {snap.costUsd !== undefined && row('Rate', `≈ ${usd(snap.costUsd / hours)} per hour`)}
          {counts && counts.responses > 0 && snap.costUsd !== undefined &&
            row('Per response', `≈ ${cost(snap.costUsd / counts.responses)}`)}
          <Box paddingLeft={2}>
            <Text dimColor italic>
              Total of the session's billed API responses, as /cost reports.
            </Text>
          </Box>
          {counts && (
            <Box flexDirection="column">
              {heading('Tokens')}
              {row('Responses', thousands(counts.responses))}
              {row('Input', thousands(counts.input))}
              {row('Output', thousands(counts.output))}
              {row('Cache read', thousands(counts.cacheRead))}
              {row('Cache write', thousands(counts.cacheWrite))}
              {row('Cache hit', `${cacheHit(counts)}%`)}
              {heading('By model')}
              {Object.entries(counts.byModel).map(([model, m]) =>
                row(displayName(model), `${thousands(m.responses)} responses · ${thousands(m.output)} output tokens`),
              )}
              {counts.since - snap.startedAt > 60_000 && (
                <Box paddingLeft={2}>
                  <Text dimColor italic>
                    Counted since {clock(counts.since)}, when the mod saw its first response; subagents included.
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    } else if (current === 'context') {
      const usage = await $.session.usage({ breakdown: 'summary', columns: cols })
      const breakdown = usage.context.breakdown
      const used = (breakdown?.categories ?? []).filter(c => !c.isDeferred)
      body = (
        <Box flexDirection="column">
          {heading('Window')}
          {row(
            'Used',
            `${bar(snap.contextPercent ?? 0, barWidth)} ${snap.contextPercent ?? '—'}%`,
            contextColor(snap.contextPercent),
          )}
          {row('Tokens', `${thousands(snap.contextTokens ?? 0)} / ${thousands(snap.contextWindow)}`)}
          {breakdown?.autoCompactThreshold !== undefined &&
            row('Auto-compact', `at ${thousands(breakdown.autoCompactThreshold)} tokens`)}
          {heading('Breakdown (local estimate)')}
          {used.map(c => (
            <Box flexDirection="row" paddingLeft={2}>
              <Text color={c.color}>■ </Text>
              <Text>{c.name.slice(0, labelWidth - 3).padEnd(labelWidth - 2, ' ')}</Text>
              <Text dimColor>{thousands(c.tokens).padStart(9, ' ')}</Text>
            </Box>
          ))}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          {snap.rateLimits.length === 0 && heading('No quota reading yet')}
          {snap.rateLimits.map((r: RateLimit) => (
            <Box flexDirection="column">
              {heading(`${windowName(r.kind)} window`)}
              {row('Used', `${bar(r.percentUsed, barWidth)} ${r.percentUsed}%`, quotaColor(r.percentUsed))}
              {row('Resets', resetLabel(r.resetsAt))}
            </Box>
          ))}
        </Box>
      )
    }

    // Separator, title and tabs, body, key hints: the artifacts browser's layout.
    return (
      <Box flexDirection="column" width={cols} marginTop={1}>
        {statusRow}
        {hoverRow}
        <Text color="suggestion">{'─'.repeat(cols)}</Text>
        <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} marginTop={1}>
          <Text bold color="suggestion">
            Usage
          </Text>
          {SEGMENTS.map(s => (
            <Button key={`tab-${s}`} plain onPress={() => void update($, selected, () => s)}>
              <Text inverse={s === current} bold={s === current}>{` ${SECTION_TITLES[s]} `}</Text>
            </Button>
          ))}
          <Box borderStyle="dashed" borderDimColor paddingX={1}>
            <Button key="collapse" plain role="dismiss" onPress={() => void update($, isExpanded, () => false)}>
              Close
            </Button>
          </Box>
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {body}
        </Box>
        <Box paddingX={1} marginTop={1}>
          <Text dimColor italic>
            click a tab to switch · Close to fold
          </Text>
        </Box>
      </Box>
    )
  })
}
