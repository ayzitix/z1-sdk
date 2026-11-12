#!/usr/bin/env node
import { runCli } from './cli.ts'

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdin.isTTY === true,
  })
  process.exitCode = code
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
