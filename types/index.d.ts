export type Segment = 'cost' | 'context' | 'quota'

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  startedAt: number
  costUsd?: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: RateLimit[]
}

// One styled run of the status line command's output, ANSI SGR decoded.
export type Span = { text: string; color?: string; bold?: boolean; dim?: boolean }

// What the last main-thread model response reported, which `$.session.usage()`
// does not carry but the status line command's stdin JSON does.
export type LastStep = { outputTokens: number; model?: string; effort?: string }

// Where the dir and git segments lead on a press: the checkout's root folder,
// a worktree's own in a worktree (a press opens its Xcode workspace, project
// or package when it has one), and the repository page on its forge (the
// branch's page once it is pushed).
export type Place = { cwd: string; project?: string; branch?: string; webUrl?: string }

// What the session's model responses add up to, main thread and subagents,
// counted from `since` (the first response the mod saw).
export type ModelTally = { responses: number; output: number }
export type Tally = {
  since: number
  responses: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  byModel: Record<string, ModelTally>
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Shaped<Snapshot | null>
      selected: Segment
      isExpanded: boolean
      line: Shaped<Span[]>
      lastStep: Shaped<LastStep>
      place: Shaped<Place | null>
      tally: Shaped<Tally | null>
    }
  }
}
