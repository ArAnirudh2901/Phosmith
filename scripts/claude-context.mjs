#!/usr/bin/env bun
/**
 * Mirror this project's Claude memory between the repo and the machine-local
 * memory directory, so `git pull` carries the working context to another device.
 *
 * The local directory is derived from the repo path the same way Claude Code
 * derives it, so a clone at a different path on another machine still resolves.
 *
 * Commands: sync (both ways), pull (repo -> local), push [--stage] (local -> repo),
 * status. `sync` runs on `bun run dev`, so pulling the code and starting the
 * editor is all it takes for this device to hold the same context.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REPO_MEM = path.join(REPO_ROOT, '.claude', 'context', 'memory')
const CLAUDE_HOME = path.join(os.homedir(), '.claude')

/** Claude Code names a project directory after its absolute path. */
export const projectSlug = (repoRoot) => repoRoot.replace(/[^a-zA-Z0-9]/g, '-')

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// A conflict copy must NOT end in .md — every .md in the memory directory is
// loaded as a memory, so a rejected remote version would become context.
const CONFLICT_SUFFIX = '.remote'

const listMemories = (dir) => {
    let names = []
    try {
        names = fs.readdirSync(dir)
    } catch {
        return new Map()
    }
    const out = new Map()
    for (const name of names) {
        if (!name.endsWith('.md')) continue
        const full = path.join(dir, name)
        if (!fs.statSync(full).isFile()) continue
        out.set(name, sha(fs.readFileSync(full)))
    }
    return out
}

const readState = (statePath) => {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        return parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {}
    } catch {
        return {}
    }
}

const writeState = (statePath, files) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, `${JSON.stringify({ files }, null, 2)}\n`)
}

const copy = (from, to, name) => {
    fs.mkdirSync(to, { recursive: true })
    fs.copyFileSync(path.join(from, name), path.join(to, name))
}

/**
 * One direction of the mirror. `state` holds the hash each file had when both
 * sides last agreed, which is what tells an edit apart from a stale copy — the
 * difference between carrying a memory across and destroying one.
 */
export function syncMemories({ repoMem, localMem, statePath, direction }) {
    const repo = listMemories(repoMem)
    const local = listMemories(localMem)
    const state = readState(statePath)
    const [src, dst] = direction === 'pull' ? [repo, local] : [local, repo]
    const [srcDir, dstDir] = direction === 'pull' ? [repoMem, localMem] : [localMem, repoMem]

    const actions = { written: [], deleted: [], conflicts: [], kept: [] }

    for (const name of new Set([...src.keys(), ...dst.keys()])) {
        const s = src.get(name)
        const d = dst.get(name)
        const last = state[name]

        if (s && s === d) {
            state[name] = s
            continue
        }

        if (s && !d) {
            // Absent on the destination: a deletion there if the two sides had
            // already agreed on this exact content, otherwise it is new here.
            // The agreed hash is KEPT, because it is the only thing that lets the
            // opposite direction recognise the deletion instead of re-copying.
            if (last !== undefined && last === s) {
                actions.kept.push(name)
            } else {
                copy(srcDir, dstDir, name)
                actions.written.push(name)
                state[name] = s
            }
            continue
        }

        if (!s && d) {
            if (last !== undefined && last === d) {
                fs.rmSync(path.join(dstDir, name))
                actions.deleted.push(name)
                delete state[name]
            } else {
                actions.kept.push(name)
            }
            continue
        }

        // Both sides have it and they differ.
        if (last !== undefined && last === d) {
            copy(srcDir, dstDir, name)
            actions.written.push(name)
            state[name] = s
        } else if (last !== undefined && last === s) {
            actions.kept.push(name)
        } else {
            fs.mkdirSync(dstDir, { recursive: true })
            fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, `${name}${CONFLICT_SUFFIX}`))
            actions.conflicts.push(name)
        }
    }

    writeState(statePath, state)
    return actions
}

const report = (label, actions) => {
    const parts = []
    if (actions.written.length) parts.push(`${actions.written.length} updated`)
    if (actions.deleted.length) parts.push(`${actions.deleted.length} removed`)
    if (actions.conflicts.length) parts.push(`${actions.conflicts.length} conflicted`)
    console.log(parts.length ? `[claude-context] ${label}: ${parts.join(', ')}` : `[claude-context] ${label}: already in sync`)
    for (const name of actions.written) console.log(`  + ${name}`)
    for (const name of actions.deleted) console.log(`  - ${name}`)
    for (const name of actions.conflicts) {
        console.log(`  ! ${name} changed on both sides — incoming copy saved as ${name}${CONFLICT_SUFFIX}, yours left in place`)
    }
}

function main() {
    const command = process.argv[2] || 'status'
    // Someone who does not use Claude Code has no memory directory to fill.
    if (!fs.existsSync(CLAUDE_HOME)) return

    const localMem = path.join(CLAUDE_HOME, 'projects', projectSlug(REPO_ROOT), 'memory')
    const statePath = path.join(path.dirname(localMem), '.context-sync.json')

    if (command === 'pull' || command === 'sync') {
        report('pulled into this device', syncMemories({ repoMem: REPO_MEM, localMem, statePath, direction: 'pull' }))
        if (command === 'pull') return
    }

    // `sync` continues into the push so one command leaves both sides equal.
    // Pull runs first: incoming memories land before local ones are mirrored
    // back, so a file changed on both sides is reported as a conflict rather
    // than silently overwriting whichever side ran second.
    if (command === 'sync') {
        report('mirrored into the repo', syncMemories({ repoMem: REPO_MEM, localMem, statePath, direction: 'push' }))
        return
    }

    if (command === 'push') {
        const actions = syncMemories({ repoMem: REPO_MEM, localMem, statePath, direction: 'push' })
        report('staged from this device', actions)
        if (process.argv.includes('--stage') && (actions.written.length || actions.deleted.length)) {
            execFileSync('git', ['add', '-A', '--', path.relative(REPO_ROOT, REPO_MEM)], { cwd: REPO_ROOT })
        }
        return
    }

    if (command !== 'status') {
        console.log(`[claude-context] unknown command "${command}" — use sync, pull, push or status`)
        process.exitCode = 1
        return
    }

    const repo = listMemories(REPO_MEM)
    const local = listMemories(localMem)
    console.log(`[claude-context] repo ${repo.size} memories, this device ${local.size}`)
    console.log(`  repo   ${path.relative(REPO_ROOT, REPO_MEM)}`)
    console.log(`  device ${localMem}`)
    for (const name of new Set([...repo.keys(), ...local.keys()])) {
        const r = repo.get(name)
        const l = local.get(name)
        if (r === l) continue
        console.log(`  ${!l ? 'repo only ' : !r ? 'device only' : 'differs   '} ${name}`)
    }
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) {
    try {
        main()
    } catch (error) {
        // `dev` runs this before `next dev`. Mirroring notes is never a reason to
        // stop someone starting the editor, so a failure warns and gets out of the way.
        console.log(`[claude-context] skipped: ${error?.message || error}`)
    }
}
