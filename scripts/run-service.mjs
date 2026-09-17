#!/usr/bin/env bun
// Start a Python service with an interpreter that has its dependencies: the
// service's own .venv, else the sibling's (masking's requirements are a subset
// of segment's), else $PYTHON / python3. A bare `python` resolves to whatever
// pyenv/global shim is active and usually lacks fastapi.
//
// Usage: bun scripts/run-service.mjs <segment|masking> [--check]

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const SERVICES = ['segment', 'masking']
const name = process.argv[2]
const checkOnly = process.argv.includes('--check')

if (!SERVICES.includes(name)) {
    console.error(`usage: bun scripts/run-service.mjs <${SERVICES.join('|')}> [--check]`)
    process.exit(2)
}

const venvPython = (service) => [
    path.join('services', service, '.venv', 'bin', 'python'),
    path.join('services', service, '.venv', 'Scripts', 'python.exe'),
].find(existsSync)

const candidates = [name, ...SERVICES.filter((s) => s !== name)]
    .map(venvPython)
    .filter(Boolean)
    .concat(process.env.PYTHON || [], 'python3', 'python')

const hasDeps = (py) =>
    spawnSync(py, ['-c', 'import fastapi, uvicorn'], { stdio: 'ignore' }).status === 0

const python = candidates.find(hasDeps)

if (!python) {
    console.error(`[${name}] No Python interpreter with the service dependencies (fastapi, uvicorn) was found.
Tried: ${candidates.join(', ')}

Set up a virtualenv once (Python 3.11):
  python3.11 -m venv services/${name}/.venv
  services/${name}/.venv/bin/pip install -r services/${name}/requirements.txt`)
    process.exit(1)
}

if (checkOnly) {
    console.log(`[${name}] would run: ${python} services/${name}/main.py`)
    process.exit(0)
}

console.log(`[${name}] ${python} services/${name}/main.py`)
const child = spawn(python, [path.join('services', name, 'main.py')], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
