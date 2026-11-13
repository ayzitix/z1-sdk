/**
 * `com.z1.tools` — a small, well-behaved tool stack for z1 workers.
 *
 * One worker-mode `tools` service. Every tool takes a JSON object and returns
 * text: numbered lines for reads, `path:line: text` for search hits, and short
 * confirmations for mutations. Failures throw an `Error` whose message says
 * what was wrong and which path it was about.
 *
 * The workspace is `ctx.workspace` (the project folder): relative paths
 * resolve there, absolute paths are used as given, and results display a
 * workspace-relative path whenever the target is inside the workspace.
 *
 * v1 asks for no approvals. The manifest's capability grant is the only
 * boundary: `fs /**`, `process ["*"]`, and optional `net`. Do not point this
 * module at a workspace you are not willing to let a model rewrite.
 *
 * @module com.z1.tools
 */

import { readArgs } from './lib/args.js'
import { editTool, mkdirTool, moveTool, readTool, statTool, writeTool } from './lib/fs.js'
import { gitDiff, gitLog, gitStatus } from './lib/git.js'
import { systemInfo, todoRead, todoWrite } from './lib/meta.js'
import { applyPatch } from './lib/patch.js'
import { globTool, grepTool, listTool, treeTool } from './lib/search.js'
import { shellTool } from './lib/shell.js'

const PATH_DESCRIPTION = 'Path inside the workspace, or an absolute path.'

/** Every tool this service exposes, in a stable order. */
const TOOL_SCHEMAS = [
  {
    name: 'read',
    description:
      'Read a UTF-8 text file as numbered lines (`1| text`). `offset` is 1-based; `limit` defaults to 2000 lines and files over 1 MiB are refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
    },
  },
  {
    name: 'write',
    description: 'Write a UTF-8 text file, creating parent directories. Replaces the whole file.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        content: { type: 'string', description: 'Full file content.' },
      },
    },
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a file. `oldText` must occur once unless `replaceAll` is true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'oldText', 'newText'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        oldText: { type: 'string', description: 'Exact text to replace; must be non-empty.' },
        newText: { type: 'string', description: 'Replacement text; may be empty.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      },
    },
  },
  {
    name: 'apply_patch',
    description:
      'Apply SEARCH/REPLACE blocks to one or more files. Each block must match exactly once; the whole patch is rejected if any block does not.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['patch'],
      properties: {
        patch: {
          type: 'string',
          description:
            '`path`, then `<<<<<<< SEARCH`, old text, `=======`, new text, `>>>>>>> REPLACE`.',
        },
      },
    },
  },
  {
    name: 'list',
    description:
      'List a directory (`dir path`, `file path (size)`). Recursion is bounded to 8 levels and 5000 entries.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        recursive: { type: 'boolean', description: 'Walk subdirectories.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 8 },
      },
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob (`*`, `**`, `?`) under a root, which defaults to the workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Glob matched against the path relative to the root.' },
        path: { type: 'string', description: 'Root directory; defaults to the workspace.' },
      },
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Results are `path:line: text`; context lines use `path-line- text`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        path: { type: 'string', description: 'Directory to search; defaults to the workspace.' },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        caseSensitive: { type: 'boolean', description: 'Defaults to false.' },
        context: { type: 'integer', minimum: 0, maximum: 20, description: 'Lines before and after a hit.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'tree',
    description: 'Render a compact directory tree. Depth is capped at 7.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Root directory; defaults to the workspace.' },
        depth: { type: 'integer', minimum: 1, maximum: 7, description: 'Defaults to 3.' },
      },
    },
  },
  {
    name: 'stat',
    description: 'Report `type size mtime path` for one path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: PATH_DESCRIPTION } },
    },
  },
  {
    name: 'mkdir',
    description: 'Create a directory and its parents.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: PATH_DESCRIPTION } },
    },
  },
  {
    name: 'move',
    description: 'Move or rename a file or directory, creating the destination parent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: PATH_DESCRIPTION },
        to: { type: 'string', description: PATH_DESCRIPTION },
      },
    },
  },
  {
    name: 'shell',
    description:
      'Run one command as argv (never a shell string). Returns `exit <code>`, then `--- stdout ---` and `--- stderr ---` sections when non-empty. Defaults to 30 s, max 300 s.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable, resolved on PATH.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
        cwd: { type: 'string', description: 'Working directory; defaults to the workspace.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
      },
    },
  },
  {
    name: 'git.status',
    description: 'Read-only `git status --porcelain` in the workspace.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'git.diff',
    description: 'Read-only unified diff (`git diff`, optionally staged or against a ref).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Limit the diff to this path.' },
        staged: { type: 'boolean', description: 'Diff the index (`--staged`).' },
        ref: { type: 'string', description: 'Commit, branch or tag to diff against.' },
      },
    },
  },
  {
    name: 'git.log',
    description: 'Read-only history as `hash date subject`, newest first. Defaults to 20 commits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Limit history to this path.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
  },
  {
    name: 'system.info',
    description: 'Report platform, architecture, Node version and the workspace path.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'todo.write',
    description: 'Replace the workspace todo list at `.z1/todos.json`. Statuses: pending, in_progress, done.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', description: 'What to do.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
          },
        },
      },
    },
  },
  {
    name: 'todo.read',
    description: 'Read the workspace todo list as pretty-printed JSON.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
]

const HANDLERS = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  apply_patch: applyPatch,
  list: listTool,
  glob: globTool,
  grep: grepTool,
  tree: treeTool,
  stat: statTool,
  mkdir: mkdirTool,
  move: moveTool,
  shell: shellTool,
  'git.status': (ctx) => gitStatus(ctx),
  'git.diff': gitDiff,
  'git.log': gitLog,
  'system.info': (ctx) => systemInfo(ctx),
  'todo.write': todoWrite,
  'todo.read': (ctx) => todoRead(ctx),
}

export const services = {
  tools: (ctx) => ({
    /** Every tool this service exposes, with its JSON Schema. */
    list() {
      return TOOL_SCHEMAS
    },

    /** Run one tool by name. Unknown names and bad arguments throw. */
    async call(name, args) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('tool name must be a non-empty string')
      }
      const handler = HANDLERS[name]
      if (handler === undefined) throw new Error(`unknown tool "${name}"`)
      return await handler(ctx, readArgs(args, name))
    },
  }),
}
