#!/usr/bin/env bun
/**
 * Checks the memory mirror's three-way rules. Every case here is a way a real
 * memory could be lost by working on two devices, so they are asserted rather
 * than reasoned about: an edit on one side must win, an edit on both sides must
 * conflict instead of overwriting, and a deletion must not resurrect.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncMemories, projectSlug } from './claude-context.mjs'

let passed = 0
let failed = 0

const check = (label, condition) => {
    if (condition) {
        passed += 1
    } else {
        failed += 1
        console.log(`\x1b[31m✗\x1b[0m ${label}`)
    }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phosmith-context-'))
let caseId = 0

/** A fresh pair of directories plus the state file, so cases cannot bleed. */
const world = () => {
    caseId += 1
    const base = path.join(scratch, `case-${caseId}`)
    const repoMem = path.join(base, 'repo')
    const localMem = path.join(base, 'local')
    fs.mkdirSync(repoMem, { recursive: true })
    fs.mkdirSync(localMem, { recursive: true })
    return { repoMem, localMem, statePath: path.join(base, '.context-sync.json') }
}

const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body)
const read = (dir, name) => {
    try {
        return fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
        return null
    }
}
const exists = (dir, name) => fs.existsSync(path.join(dir, name))

// --- the slug, which is what makes a different path on another device work ---
check('slug matches the observed Claude Code project directory',
    projectSlug('/Users/anirudharavalli/Web_Dev/NextJS/phosmith') === '-Users-anirudharavalli-Web-Dev-NextJS-phosmith')
check('slug survives a different user and path',
    projectSlug('/home/ana/code/phosmith') === '-home-ana-code-phosmith')
check('slug has no separator left that a filename would reject',
    /^[A-Za-z0-9-]+$/.test(projectSlug('/Users/x/My Work/phos.mith_2')))

// --- a first pull onto a device that has never seen the project ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    write(w.repoMem, 'MEMORY.md', 'index')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('first pull writes every memory', read(w.localMem, 'a.md') === 'one' && read(w.localMem, 'MEMORY.md') === 'index')
    check('first pull reports what it wrote', actions.written.length === 2)
    check('first pull creates no conflicts', actions.conflicts.length === 0)
}

// --- a pull that changes nothing is silent and idempotent ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    const second = syncMemories({ ...w, direction: 'pull' })
    check('a second identical pull does nothing', second.written.length === 0 && second.deleted.length === 0)
}

// --- an incoming edit lands on an untouched device ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    write(w.repoMem, 'a.md', 'two')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('an upstream edit overwrites an untouched local copy', read(w.localMem, 'a.md') === 'two')
    check('the overwrite is reported', actions.written.includes('a.md'))
}

// --- a local edit is not destroyed by a pull that carries the old version ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    write(w.localMem, 'a.md', 'mine')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('a pull leaves a locally edited memory alone', read(w.localMem, 'a.md') === 'mine')
    check('the untouched upstream side is not a conflict', actions.conflicts.length === 0)
    const pushed = syncMemories({ ...w, direction: 'push' })
    check('the local edit then reaches the repo', read(w.repoMem, 'a.md') === 'mine' && pushed.written.includes('a.md'))
}

// --- both sides edited: keep mine, keep theirs beside it, say so ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    write(w.repoMem, 'a.md', 'theirs')
    write(w.localMem, 'a.md', 'mine')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('a two-sided edit keeps the local version', read(w.localMem, 'a.md') === 'mine')
    check('a two-sided edit keeps the incoming version beside it', read(w.localMem, 'a.md.remote') === 'theirs')
    check('a two-sided edit is reported as a conflict', actions.conflicts.includes('a.md'))
    check('the conflict copy is not a .md, so it is never loaded as a memory',
        fs.readdirSync(w.localMem).filter((f) => f.endsWith('.md')).length === 1)
    const pushed = syncMemories({ ...w, direction: 'push' })
    check('a conflicted file is not pushed over the repo either', read(w.repoMem, 'a.md') === 'theirs' && pushed.conflicts.includes('a.md'))
}

// --- a memory written on this device is new, not a deletion upstream ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    write(w.localMem, 'fresh.md', 'new thought')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('a pull never deletes a memory the repo has not seen', exists(w.localMem, 'fresh.md'))
    check('an unseen local memory is not reported as removed', actions.deleted.length === 0)
    syncMemories({ ...w, direction: 'push' })
    check('the new memory reaches the repo', read(w.repoMem, 'fresh.md') === 'new thought')
}

// --- a real deletion propagates, in both directions ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    write(w.repoMem, 'b.md', 'two')
    syncMemories({ ...w, direction: 'pull' })
    fs.rmSync(path.join(w.repoMem, 'b.md'))
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('a memory deleted upstream is removed locally', !exists(w.localMem, 'b.md'))
    check('the deletion is reported', actions.deleted.includes('b.md'))
    check('the other memory is untouched', read(w.localMem, 'a.md') === 'one')
}
{
    const w = world()
    write(w.localMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'push' })
    fs.rmSync(path.join(w.localMem, 'a.md'))
    const actions = syncMemories({ ...w, direction: 'push' })
    check('a memory deleted on this device is removed from the repo', !exists(w.repoMem, 'a.md'))
    check('the repo deletion is reported', actions.deleted.includes('a.md'))
}

// --- a deletion must not be undone by the next pull ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    fs.rmSync(path.join(w.localMem, 'a.md'))
    const pulled = syncMemories({ ...w, direction: 'pull' })
    check('a locally deleted memory is not resurrected by a pull', !exists(w.localMem, 'a.md'))
    check('the resurrection is not reported as a write', !pulled.written.includes('a.md'))
    const pushed = syncMemories({ ...w, direction: 'push' })
    check('the deletion then propagates to the repo', !exists(w.repoMem, 'a.md') && pushed.deleted.includes('a.md'))
}

// --- upstream deleted, this device edited: the edit survives ---
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    syncMemories({ ...w, direction: 'pull' })
    fs.rmSync(path.join(w.repoMem, 'a.md'))
    write(w.localMem, 'a.md', 'mine now')
    syncMemories({ ...w, direction: 'pull' })
    check('an edited memory is not deleted by an upstream deletion', read(w.localMem, 'a.md') === 'mine now')
    syncMemories({ ...w, direction: 'push' })
    check('the edit is restored to the repo', read(w.repoMem, 'a.md') === 'mine now')
}

// --- the hostile and empty cases ---
{
    const w = world()
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('two empty sides sync without error', actions.written.length === 0 && actions.conflicts.length === 0)
}
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    write(w.repoMem, 'notes.txt', 'ignored')
    write(w.repoMem, 'a.md.remote', 'a leftover conflict copy')
    fs.mkdirSync(path.join(w.repoMem, 'nested.md'))
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('only .md files are mirrored', actions.written.length === 1 && actions.written[0] === 'a.md')
    check('a non-markdown file is left behind', !exists(w.localMem, 'notes.txt'))
    check('a stale conflict copy is not mirrored', !exists(w.localMem, 'a.md.remote'))
    check('a directory named like a memory is skipped', !exists(w.localMem, 'nested.md'))
}
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    fs.writeFileSync(w.statePath, '{ this is not json')
    const actions = syncMemories({ ...w, direction: 'pull' })
    check('a corrupt state file falls back to treating both sides as new', actions.written.includes('a.md'))
    check('the state file is rewritten valid', JSON.parse(fs.readFileSync(w.statePath, 'utf8')).files['a.md'].length === 64)
}
{
    const w = world()
    write(w.repoMem, 'a.md', 'one')
    const missing = path.join(w.localMem, 'does', 'not', 'exist')
    const actions = syncMemories({ repoMem: w.repoMem, localMem: missing, statePath: w.statePath, direction: 'pull' })
    check('a device with no memory directory yet has one created', fs.existsSync(path.join(missing, 'a.md')))
    check('that first pull reports the write', actions.written.includes('a.md'))
}

// --- what a full round trip between two devices actually does ---
{
    const repoBase = path.join(scratch, 'shared-repo')
    fs.mkdirSync(repoBase, { recursive: true })
    const deviceA = { repoMem: repoBase, localMem: path.join(scratch, 'dev-a'), statePath: path.join(scratch, 'dev-a.json') }
    const deviceB = { repoMem: repoBase, localMem: path.join(scratch, 'dev-b'), statePath: path.join(scratch, 'dev-b.json') }
    fs.mkdirSync(deviceA.localMem, { recursive: true })
    fs.mkdirSync(deviceB.localMem, { recursive: true })

    write(deviceA.localMem, 'bar.md', 'engineering bar')
    syncMemories({ ...deviceA, direction: 'push' })
    syncMemories({ ...deviceB, direction: 'pull' })
    check('device B receives what device A wrote', read(deviceB.localMem, 'bar.md') === 'engineering bar')

    write(deviceB.localMem, 'bar.md', 'engineering bar, revised on B')
    write(deviceB.localMem, 'new-on-b.md', 'from B')
    syncMemories({ ...deviceB, direction: 'push' })
    syncMemories({ ...deviceA, direction: 'pull' })
    check('device A receives B\'s revision', read(deviceA.localMem, 'bar.md') === 'engineering bar, revised on B')
    check('device A receives B\'s new memory', read(deviceA.localMem, 'new-on-b.md') === 'from B')
    check('no conflict copy was needed in a clean round trip',
        !fs.readdirSync(deviceA.localMem).some((f) => f.endsWith('.remote')))
}

fs.rmSync(scratch, { recursive: true, force: true })

console.log(`\n[verify-context] ${passed}/${passed + failed} checks passed.`)
if (failed) process.exit(1)
