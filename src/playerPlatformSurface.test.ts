/**
 * **WHAT THE PLAYER NEEDS FROM THE PLATFORM, MEASURED** (2026-09-06).
 *
 * The import graph says the two products are separable — `productBoundary.test.ts` proves it, and
 * `App.tsx` was split so that no file belongs to both. **That measurement cannot see the thing that
 * decides whether the player can be framed**, because the thing is not an import.
 *
 * **A page's capabilities are a property of how it is embedded, not of what it does**
 * (`project-context.md`, *Framing a page changes its platform identity*). Origin, top-level site
 * and permissions policy all change when a page is framed, and **everything keyed to them changes
 * silently — no error, no warning, and every unit test still green, because a test frames
 * nothing.**
 *
 * So this counts the two surfaces that would have to cross a frame, and pins them:
 *
 * - **The main process.** A cross-origin frame gets no preload, by design and by this app's own
 *   rule for hosted tools — `electronAPI` is simply absent. Every call below would have to become
 *   a message.
 * - **The cross-window storage channels.** Chromium partitions storage by top-level site, so a
 *   framed control page and a top-level projection window do not share `localStorage`. Every
 *   channel below is how the wall learns what to paint.
 *
 * **This test asserts numbers, not behaviour, and that is deliberate.** It is the cost of framing,
 * kept honest: it goes red when the player asks the platform for something new, which is the day
 * that cost changes.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { PLAYER } from './productBoundary'

const SRC = resolve(__dirname)
const SKIP_DIRS = new Set(['vendor', 'fixtures', 'testSupport'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    if (/\.d\.ts$/.test(entry.name)) continue
    out.push(relative(SRC, full))
  }
  return out
}

function importsOf(moduleRelPath: string): string[] {
  const src = readFileSync(join(SRC, moduleRelPath), 'utf8')
  const found = new Set<string>()
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const base = resolve(dirname(join(SRC, moduleRelPath)), m[1]!)
    for (const ext of ['', '.ts', '.tsx']) {
      try {
        if (statSync(base + ext).isFile()) {
          found.add(relative(SRC, base + ext))
          break
        }
      } catch {
        /* not this extension */
      }
    }
  }
  return [...found]
}

const KNOWN = new Set(sourceFiles(SRC))

/** Everything the player reaches, its own modules and the shared ones below them. */
function playerClosure(): string[] {
  const seen = new Set<string>()
  const stack = [...PLAYER]
  while (stack.length > 0) {
    const m = stack.pop()!
    if (seen.has(m) || !KNOWN.has(m)) continue
    seen.add(m)
    for (const dep of importsOf(m)) if (!seen.has(dep)) stack.push(dep)
  }
  return [...seen].sort()
}

/**
 * **Every main-process call the player's closure makes**, whether through `platform.ts` or straight
 * off `window.electronAPI`.
 */
function mainProcessCalls(): string[] {
  const platformSrc = readFileSync(join(SRC, 'platform.ts'), 'utf8')

  /** The `electronAPI` methods one exported `platform.ts` function reaches. */
  function callsInsidePlatformFunction(name: string): string[] {
    const start = platformSrc.search(
      new RegExp(`export (?:async )?function ${name}\\b`)
    )
    if (start < 0) return []
    // The next top-level `export` after it is where this function's body ends. Crude and exact
    // enough: everything in this file is a top-level export at column zero.
    const rest = platformSrc.slice(start + 1)
    const next = rest.search(/\nexport /)
    const body = next < 0 ? rest : rest.slice(0, next)
    return [...body.matchAll(/\ba\.([a-zA-Z]+)\(/g)].map((m) => m[1]!)
  }

  const used = new Set<string>()
  for (const module of playerClosure()) {
    if (module === 'platform.ts') continue
    const src = readFileSync(join(SRC, module), 'utf8')
    // Straight off the bridge, in a view that has one.
    for (const m of src.matchAll(/electronAPI[?.]*\.([a-zA-Z]+)\(/g)) used.add(m[1]!)
    for (const m of src.matchAll(/\bapi\.([a-zA-Z]+)\(/g)) if (m[1] !== 'then') used.add(m[1]!)
    // Through `platform.ts`, named or as a namespace — only the functions this module calls.
    const wanted = new Set<string>()
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/platform'/gs)) {
      for (const raw of m[1]!.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '')
        if (name) wanted.add(name)
      }
    }
    if (/import \* as platform from '\.\/platform'/.test(src)) {
      for (const m of src.matchAll(/platform\.([a-zA-Z]+)\(/g)) wanted.add(m[1]!)
    }
    for (const name of wanted) for (const call of callsInsidePlatformFunction(name)) used.add(call)
  }
  return [...used].sort()
}

/** Every module in the player's closure that talks over a `storage` event. */
function crossWindowChannels(): string[] {
  return playerClosure().filter((m) =>
    /addEventListener\('storage'/.test(readFileSync(join(SRC, m), 'utf8'))
  )
}

describe('what framing the player would have to carry', () => {
  it('names every main-process call the player makes, because a frame can make none of them', () => {
    // **A cross-origin frame has no preload.** The main window's is attached to its own
    // `webContents` and `nodeIntegrationInSubFrames` is off, so `window.electronAPI` is `undefined`
    // in a framed page — which is also the rule this app already applies to Bombista's and
    // Muralista's pages on purpose. **Every name here is a message that does not exist.**
    //
    // Two of them are writes and one launches a subprocess, so this is not a read-only bridge.
    expect(mainProcessCalls()).toEqual([
      'closeProjection',
      'createGigFolder',
      'describeDisplays',
      'getFileStats',
      'isProjectionOpen',
      'listGigsFolder',
      'listSongsFolder',
      'onProjectionClosed',
      'onProjectionOpened',
      'openFileDialog',
      'openProjection',
      'projectionPlacement',
      'readGigFolder',
      'readSongFile',
      'validateSongForPerformance',
      'writeGigFile',
    ])
  })

  it('names every cross-window channel, because a framed page cannot share one', () => {
    // **Chromium partitions storage by top-level site.** Framed, the control page's top-level site
    // is the host's document; the projection window it opens is its own top-level `127.0.0.1`.
    // They do not share `localStorage`, and **this is how the wall learns what to paint**: the
    // lyric and its index, the room, the contact boolean, the blackout, the video transport, the
    // display mode, the armed flag.
    expect(crossWindowChannels()).toEqual([
      'LanguagesView.tsx',
      'ProjectionView.tsx',
      'ShapeVideo.tsx',
      'gigContactState.ts',
      'performanceState.ts',
      'useSongNavigation.ts',
      'visualsBroadcast.ts',
    ])
  })
})
