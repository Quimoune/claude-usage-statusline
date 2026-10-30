import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const ESC = '\x1b'
const SEP = `${ESC}[2m | ${ESC}[0m`
// What the status line script prints: dim " | " separators between segments.
const STATUS_LINE =
  `${ESC}[32m→ my-app${ESC}[0m${SEP}` +
  `${ESC}[33mgit:(${ESC}[0m${ESC}[31mfeature/x${ESC}[0m${ESC}[33m)${ESC}[0m${SEP}` +
  `${ESC}[36m$0.5000 (52.0K token)${ESC}[0m${SEP}` +
  `${ESC}[33mctx 25%${ESC}[0m${SEP}` +
  `${ESC}[38;5;208m12% ↻  23:20${ESC}[0m${SEP}` +
  `${ESC}[35mOpus 5.5 (high)${ESC}[0m${SEP}` +
  `${ESC}[35m23:41:02${ESC}[0m\n`

const WORKTREE = '/repo/.worktrees/feature-x'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('the band replicates the status line and each press does its job', async ($, on) => {
  const clock = mock.clock(on)
  const launched: string[] = []
  const toasts: string[] = []
  const stdins: string[] = []
  on('command.register', () => ({ value: { command: 'usage-details' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-29T22:20:00Z' }],
      cost: { usd: 0.5 },
    },
  }))
  // A read of one key is the read of the whole object, projected.
  on('settings.read', () => ({ value: { statusLine: { type: 'command', command: 'statusline' } } }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: '/home' }))
  on('fs.stat', () => {
    throw new Error('missing')
  })
  // A workspace beside its project: the workspace is what the folder opens.
  const entry = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', (_, e) => ({
    value: e.path === WORKTREE ? [entry('App'), entry('App.xcodeproj'), entry('App.xcworkspace')] : [],
  }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('remote get-url')) return ok('git@github.com:owner/repo.git\n')
    if (argv.includes('branch --show-current')) return ok('feature/x\n')
    // The session sits in a linked worktree, whose own root is the folder.
    if (argv.includes('--show-toplevel')) return ok(`${WORKTREE}\n`)
    if (argv.includes('rev-parse')) return ok('abc123\n')
    if (e.argv[0] === 'open') {
      launched.push(e.argv[1] ?? '')
      return ok('')
    }
    stdins.push(e.init?.stdin ?? '')
    return ok(STATUS_LINE)
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(300)

  const input = JSON.parse(stdins[0] ?? '{}')
  expect(input.model.display_name).toBe('Opus 5.5')
  expect(input.context_window.remaining_percentage).toBe(75)
  expect(input.rate_limits.five_hour.resets_at).toBe(Date.parse('2026-10-29T22:20:00Z') / 1000)

  const ui = await $.ui.mount(BAND)
  const ctx = await ui.find({ type: 'Text', text: /ctx 25%/ })
  expect(ctx?.text).toBe('ctx 25%')
  expect((await ui.find({ type: 'Text', text: /↻/ }))?.text).toBe('12% ↻  23:20')
  // Token count and effort leave the band for the hover cards.
  expect((await ui.find({ type: 'Text', text: /^\$0\.5000/ }))?.text).toBe('$0.5000')
  expect((await ui.find({ type: 'Text', text: /^Opus/ }))?.text).toBe('Opus 5.5')
  expect(await ui.find({ type: 'Text', text: /· 50K tokens since / })).toBeDefined()

  // A press on a segment unfolds the details under the band, on that tab.
  expect(await ui.find({ type: 'Text', text: /Tokens/ })).toBeUndefined()
  await ui.press({ key: 'segment-context' })
  expect(await ui.find({ type: 'Text', text: /Tokens/ })).toBeDefined()
  await ui.press({ key: 'tab-quota' })
  expect(await ui.find({ type: 'Text', text: /5h window/ })).toBeDefined()
  await ui.press({ key: 'tab-cost' })
  expect((await ui.find({ type: 'Text', text: /\$0\.5000$/ }))?.text).toBe('$0.5000')
  // Pressing the open tab's segment folds it again, as does the collapse key.
  await ui.press({ key: 'segment-cost' })
  expect(await ui.find({ type: 'Text', text: /Total cost/ })).toBeUndefined()
  await ui.press({ key: 'segment-quota' })
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ type: 'Text', text: /5h window/ })).toBeUndefined()

  // The card names the worktree's folder; the press opens its workspace.
  expect((await ui.find({ type: 'Text', text: /! open / }))?.text.trim()).toBe(`! open ${WORKTREE}`)
  await ui.press({ key: 'segment-dir' })
  await ui.press({ key: 'segment-git' })
  expect(launched).toEqual([`${WORKTREE}/App.xcworkspace`, 'https://github.com/owner/repo/tree/feature/x'])

  await ui.press({ key: 'segment-model' })
  expect(toasts[0]).toContain('effort: model default')
  await ui.unmount()
})

test('without a statusLine setting or a ~/.claude copy, the band runs the script the mod ships', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[] = []
  on('command.register', () => ({ value: { command: 'usage-details' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: '/home' }))
  on('fs.stat', () => {
    throw new Error('missing')
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') commands.push(e.argv[2] ?? '')
    return ok('')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(300)

  expect(commands[0]).toMatch(/^bash "\/.+\/statusline-command\.sh"$/)
  expect(commands[0]).not.toContain('/home/.claude/')
})
