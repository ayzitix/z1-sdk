#!/usr/bin/env node
import { runCli } from './cli.ts'

async function main(): Promise<void> {
  // `pnpm` runs a workspace script with the package root as the process cwd;
  // `INIT_CWD` is the directory the caller typed the command in.
  const invokedFrom = process.env['INIT_CWD']
  const code = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdin.isTTY === true,
    ...(invokedFrom === undefined || invokedFrom === '' ? {} : { cwd: invokedFrom }),
  })
  process.exitCode = code
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
