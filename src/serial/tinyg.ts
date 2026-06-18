// TinyG / g2core JSON protocol adapter.
//
// TinyG (Synthetos) does NOT speak GRBL's `<...>` status / `ok` line protocol.
// It uses a JSON protocol (https://github.com/synthetos/TinyG/wiki):
//
//  - COMMANDS: plain G-code lines are accepted as-is. Each line produces exactly
//    one RESPONSE object: `{"r":{...},"f":[revision, statusCode, rxBytes, csum]}`.
//    The footer's 2nd element (`f[1]`) is the status code — 0 means OK, anything
//    else is an error. So the existing line-streamer's "one ack per line" model
//    maps cleanly onto TinyG once an `{"r":…}` line is translated to ok/error.
//  - STATUS: pushed automatically as `{"sr":{posx,…,stat,…}}` objects (and on
//    demand via `{"sr":null}`). The numeric `stat` field is the machine state.
//  - REALTIME: `!` feedhold, `~` cycle-start/resume, `%` queue-flush, `0x18`
//    (Ctrl-X) reset — single bytes, same channel idea as GRBL, so the existing
//    realtime helpers work unchanged.
//
// This module is PURE (no React/DOM/zustand/I/O) — it only parses lines and
// builds command strings. The controller performs the actual writes, exactly as
// it does for the GRBL and Marlin dialects.

import type { GrblState, StatusReport, Vec3 } from './status'

/**
 * TinyG `stat` (machine-state) field → our GRBL-shaped {@link GrblState}, so the
 * whole UI (state badge, jog gate, alarm affordances) reacts without knowing it's
 * talking to a TinyG. Values per the TinyG "Status Reports" wiki:
 *   0 init · 1 ready · 2 alarm/shutdown · 3 program-stop · 4 program-end ·
 *   5 running · 6 holding · 7 probe-cycle · 8 cycling · 9 homing
 */
const STAT_TO_STATE: Record<number, GrblState> = {
  0: 'Unknown',
  1: 'Idle',
  2: 'Alarm',
  3: 'Idle', // program stop / no more blocks → idle & ready for more
  4: 'Idle', // program end (M2/M30/M60)
  5: 'Run',
  6: 'Hold',
  7: 'Run', // probing cycle in progress
  8: 'Run', // machine cycling
  9: 'Home',
}

/** Map a numeric TinyG `stat` to a GrblState (Unknown for anything unexpected). */
export function tinygStateFromStat(stat: number | undefined): GrblState {
  if (stat == null || Number.isNaN(stat)) return 'Unknown'
  return STAT_TO_STATE[stat] ?? 'Unknown'
}

/** A parsed TinyG line. `other` covers banners, queue reports and text we ignore. */
export type TinyGLine =
  | { kind: 'status'; report: StatusReport }
  | { kind: 'response'; statusCode: number; report?: StatusReport }
  | { kind: 'other' }

/** True if a line looks like a JSON object (TinyG's JSON-mode output). */
export function isTinyGJson(line: string): boolean {
  const t = line.trim()
  return t.startsWith('{') && t.endsWith('}')
}

/**
 * Build a {@link StatusReport} from a TinyG `sr` object. Work position comes from
 * `posx/posy/posz`, machine position from `mpox/mpoy/mpoz`; a vector is only set
 * when ALL THREE of its components are present, so a sparse report never zeroes a
 * missing axis (we configure verbose reports — see {@link tinygInitCommands} —
 * but this stays safe if a firmware sends filtered ones). `vel` (actual velocity)
 * is surfaced as the live feed. `unit:0` (inch) is converted to mm.
 */
export function tinygStatusFromSr(sr: Record<string, unknown>): StatusReport {
  const num = (k: string): number | undefined => {
    const v = sr[k]
    return typeof v === 'number' && !Number.isNaN(v) ? v : undefined
  }
  // unit: 0 = inch, 1 = mm. Convert inch reports to mm so the rest of the app
  // (which works in mm) sees consistent positions.
  const scale = num('unit') === 0 ? 25.4 : 1
  const vec = (px: string, py: string, pz: string): Vec3 | undefined => {
    const x = num(px)
    const y = num(py)
    const z = num(pz)
    if (x == null || y == null || z == null) return undefined
    return { x: x * scale, y: y * scale, z: z * scale }
  }
  const report: StatusReport = { state: tinygStateFromStat(num('stat')) }
  const wpos = vec('posx', 'posy', 'posz')
  const mpos = vec('mpox', 'mpoy', 'mpoz')
  if (wpos) report.wpos = wpos
  if (mpos) report.mpos = mpos
  // If only the work position is reported, mirror it so a position is always
  // shown (offsets aren't tracked here); GRBL-style WCO derivation isn't used.
  if (wpos && !mpos) report.mpos = wpos
  if (mpos && !wpos) report.wpos = mpos
  const vel = num('vel')
  if (vel != null) report.feed = vel
  const line = num('line')
  if (line != null) report.line = line
  return report
}

/**
 * Parse one line of TinyG output. Returns:
 *  - `status`   for an unsolicited `{"sr":{…}}` status report,
 *  - `response` for a `{"r":{…},"f":[…]}` command acknowledgement (carrying the
 *    footer status code, and a status report if the response embedded one),
 *  - `other`    for banners (`{"fb":…}`), queue reports (`{"qr":…}`), text-mode
 *    `$$` dump lines and anything else we don't act on.
 * Never throws — malformed JSON resolves to `other`.
 */
export function parseTinyGLine(line: string): TinyGLine {
  if (!isTinyGJson(line)) return { kind: 'other' }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { kind: 'other' }
  }
  if (!obj || typeof obj !== 'object') return { kind: 'other' }

  // A command response: `{"r":{…},"f":[rev, statusCode, rxBytes, csum]}`.
  if ('r' in obj) {
    const footer = obj.f
    const statusCode = Array.isArray(footer) && typeof footer[1] === 'number' ? footer[1] : 0
    const r = obj.r
    // A response may embed a status report (e.g. the reply to `{"sr":null}` or a
    // gcode line that completed a block): `{"r":{"sr":{…}}, …}`.
    let report: StatusReport | undefined
    if (r && typeof r === 'object' && 'sr' in (r as Record<string, unknown>)) {
      const sr = (r as Record<string, unknown>).sr
      if (sr && typeof sr === 'object') report = tinygStatusFromSr(sr as Record<string, unknown>)
    }
    return { kind: 'response', statusCode, report }
  }

  // An unsolicited status report: `{"sr":{…}}`.
  if ('sr' in obj && obj.sr && typeof obj.sr === 'object') {
    return { kind: 'status', report: tinygStatusFromSr(obj.sr as Record<string, unknown>) }
  }

  // Banner (`{"fb":…}`), queue report (`{"qr":…}`), gcode-receipt, etc.
  return { kind: 'other' }
}

/** On-demand status request (JSON). TinyG replies with a full `sr` report. */
export const TINYG_STATUS_REQUEST = '{"sr":null}'

/** Command that dumps every TinyG setting (text-mode; replies with `[tok] …` lines). */
export const TINYG_DUMP_SETTINGS = '$$'

/**
 * Initialization commands sent once on connect to put TinyG into a known,
 * machine-parseable state. Sent verbatim as lines (TinyG parses any line that
 * starts with `{` as JSON, even if it booted in text mode):
 *  - `ej:1`  JSON mode (so responses are JSON, not text prompts)
 *  - `jv:1`  JSON verbosity = footer (every line gets `{"r":…,"f":[…]}`)
 *  - `qv:0`  silence queue reports (we use response-paced line-mode flow control)
 *  - `sv:2`  verbose status reports — emits ALL configured fields each time (vs.
 *            `sv:1` filtered, which would omit unchanged axes and break parsing)
 *  - `si:250` status-report interval 250 ms during motion
 *  - `sr:{…}` select the fields we parse (position + state + velocity + units)
 */
export function tinygInitCommands(): string[] {
  return [
    '{"ej":1}',
    '{"jv":1}',
    '{"qv":0}',
    '{"sv":2}',
    '{"si":250}',
    '{"sr":{"line":true,"stat":true,"vel":true,"posx":true,"posy":true,"posz":true,"mpox":true,"mpoy":true,"mpoz":true,"unit":true}}',
  ]
}
