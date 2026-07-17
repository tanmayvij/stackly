import * as esbuild from 'esbuild-wasm'
import wasmUrl from 'esbuild-wasm/esbuild.wasm?url'
import type { Manifest } from '@/lib/builder-repo'

export interface BundleOk {
  ok: true
  js: string
  css: string
  externals: string[]
  entryPath: string | null
}

export interface BundleFail {
  ok: false
  error: string
}

export type BundleOutcome = BundleOk | BundleFail

export type FetchFile = (path: string) => Promise<string>

// initialize() may only ever run once per page; a rejected init is cleared so
// a later build can retry.
let initPromise: Promise<void> | null = null

function ensureEsbuild(): Promise<void> {
  initPromise ??= esbuild.initialize({ wasmURL: wasmUrl, worker: true }).catch((err) => {
    initPromise = null
    throw err
  })
  return initPromise
}

const VIRTUAL_ENTRY = 'stackly:entry'

const ENTRY_CANDIDATES = [
  'src/main.jsx',
  'src/main.tsx',
  'src/main.js',
  'src/index.jsx',
  'src/index.tsx',
  'src/index.js',
  'main.jsx',
  'main.tsx',
  'index.jsx',
  'index.tsx',
  'main.js',
  'index.js',
]

const APP_CANDIDATES = ['src/App.jsx', 'src/App.tsx', 'App.jsx', 'App.tsx']

const CSS_CANDIDATES = ['src/index.css', 'src/App.css', 'index.css', 'App.css', 'styles.css', 'src/styles.css']

const RESOLVE_EXTENSIONS = ['.jsx', '.js', '.tsx', '.ts', '.json', '.css']

const isFile = (manifest: Manifest, path: string) => typeof manifest[path] === 'string'

async function resolveEntry(
  manifest: Manifest,
  fetchFile: FetchFile,
): Promise<{ entry: string; virtualEntry: string | null } | null> {
  if (isFile(manifest, 'index.html')) {
    const html = await fetchFile('index.html')
    const src = /<script[^>]*type\s*=\s*["']module["'][^>]*src\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]
    if (src) {
      const path = src.replace(/^\.?\//, '')
      if (isFile(manifest, path)) return { entry: path, virtualEntry: null }
    }
  }

  for (const candidate of ENTRY_CANDIDATES) {
    if (isFile(manifest, candidate)) return { entry: candidate, virtualEntry: null }
  }

  const app = APP_CANDIDATES.find((candidate) => isFile(manifest, candidate))
  if (app) {
    const cssImports = CSS_CANDIDATES.filter((candidate) => isFile(manifest, candidate))
      .map((path) => `import './${path}'`)
      .join('\n')
    const virtualEntry = `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './${app}'
${cssImports}
createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(App)),
)
`
    return { entry: VIRTUAL_ENTRY, virtualEntry }
  }

  return null
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function normalizePath(base: string, specifier: string): string {
  const parts = specifier.startsWith('/')
    ? specifier.split('/')
    : [...(base ? base.split('/') : []), ...specifier.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function resolveInManifest(manifest: Manifest, base: string, specifier: string): string | null {
  const path = normalizePath(base, specifier)
  if (isFile(manifest, path)) return path
  for (const ext of RESOLVE_EXTENSIONS) {
    if (isFile(manifest, path + ext)) return path + ext
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (isFile(manifest, `${path}/index${ext}`)) return `${path}/index${ext}`
  }
  return null
}

function loaderFor(path: string): esbuild.Loader {
  const ext = path.slice(path.lastIndexOf('.'))
  switch (ext) {
    case '.jsx':
    case '.js':
    case '.mjs':
      // Generated .js files frequently contain JSX.
      return 'jsx'
    case '.tsx':
      return 'tsx'
    case '.ts':
      return 'ts'
    case '.css':
      return 'css'
    case '.json':
      return 'json'
    case '.svg':
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return 'dataurl'
    default:
      return 'text'
  }
}

function vfsPlugin(
  manifest: Manifest,
  fetchFile: FetchFile,
  virtualEntry: string | null,
  externals: Set<string>,
): esbuild.Plugin {
  return {
    name: 'stackly-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === VIRTUAL_ENTRY) return { path: VIRTUAL_ENTRY, namespace: 'vfs' }

        if (args.kind === 'entry-point') {
          const resolved = resolveInManifest(manifest, '', args.path)
          if (resolved) return { path: resolved, namespace: 'vfs' }
          return { errors: [{ text: `Entry point '${args.path}' not found in project files` }] }
        }

        if (args.path.startsWith('./') || args.path.startsWith('../') || args.path.startsWith('/')) {
          const base = args.importer === VIRTUAL_ENTRY ? '' : dirname(args.importer)
          const resolved = resolveInManifest(manifest, base, args.path)
          if (resolved) return { path: resolved, namespace: 'vfs' }
          return { errors: [{ text: `Cannot resolve '${args.path}' from '${args.importer}'` }] }
        }

        externals.add(args.path)
        return { path: args.path, external: true }
      })

      build.onLoad({ filter: /.*/, namespace: 'vfs' }, async (args) => {
        if (args.path === VIRTUAL_ENTRY) return { contents: virtualEntry ?? '', loader: 'jsx' }
        return {
          contents: await fetchFile(args.path),
          loader: loaderFor(args.path),
        }
      })
    },
  }
}

export async function bundlePreview(manifest: Manifest, fetchFile: FetchFile): Promise<BundleOutcome> {
  try {
    await ensureEsbuild()

    const entry = await resolveEntry(manifest, fetchFile)
    if (!entry) {
      return {
        ok: false,
        error:
          'No entry point found. Expected one of: an index.html with a module script, ' +
          'src/main.jsx, src/index.jsx, main.jsx, index.jsx, or an App.jsx to auto-mount.',
      }
    }

    const externals = new Set<string>()
    const result = await esbuild.build({
      entryPoints: [entry.entry],
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'esm',
      jsx: 'automatic',
      target: 'es2020',
      logLevel: 'silent',
      plugins: [vfsPlugin(manifest, fetchFile, entry.virtualEntry, externals)],
    })

    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? ''
    const css = result.outputFiles
      .filter((f) => f.path.endsWith('.css'))
      .map((f) => f.text)
      .join('\n')

    return {
      ok: true,
      js,
      css,
      externals: [...externals],
      entryPath: entry.virtualEntry ? null : entry.entry,
    }
  } catch (err) {
    const messages = (err as { errors?: esbuild.Message[] }).errors
    if (messages?.length) {
      const formatted = await esbuild.formatMessages(messages, { kind: 'error' })
      return { ok: false, error: formatted.join('\n').trim() }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
