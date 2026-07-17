const ESM_CDN = 'https://esm.sh'

const DEFAULT_DEPS: Record<string, string> = {
  react: '19',
  'react-dom': '19',
}

function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

function parseDeps(packageJson: string | null): Record<string, string> {
  if (!packageJson) return {}
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string> }
    const deps: Record<string, string> = {}
    for (const [name, version] of Object.entries(parsed.dependencies ?? {})) {
      deps[name] = version.replace(/^[\^~]/, '')
    }
    return deps
  } catch {
    return {}
  }
}

export interface ImportMapInput {
  externals: string[]
  packageJson: string | null
}

export function buildImportMap(input: ImportMapInput): Record<string, string> {
  const deps = { ...DEFAULT_DEPS, ...parseDeps(input.packageJson) }
  const reactVersion = deps.react ?? DEFAULT_DEPS.react
  const dedupe = `deps=react@${reactVersion},react-dom@${deps['react-dom'] ?? reactVersion}`

  const names = new Set(input.externals.map(packageName))
  names.add('react')
  names.add('react-dom')
  names.delete('tailwindcss')

  const imports: Record<string, string> = {}
  for (const name of names) {
    const version = deps[name] ?? 'latest'
    const isReact = name === 'react' || name === 'react-dom'
    const query = isReact ? '' : `?${dedupe}`
    const prefixQuery = isReact ? '' : `&${dedupe}`
    imports[name] = `${ESM_CDN}/${name}@${version}${query}`
    imports[`${name}/`] = `${ESM_CDN}/${name}@${version}${prefixQuery}/`
  }
  return imports
}

export function wantsTailwind(opts: {
  externals: string[]
  css: string
  packageJson: string | null
}): boolean {
  if (opts.externals.includes('tailwindcss')) return true
  if (/@import\s+["']tailwindcss/.test(opts.css) || /@tailwind\s/.test(opts.css)) return true
  const deps = parseDeps(opts.packageJson)
  if (deps.tailwindcss) return true
  return opts.packageJson === null
}

export function stripTailwindDirectives(css: string): string {
  return css
    .split('\n')
    .filter((line) => !/^\s*@import\s+["']tailwindcss/.test(line) && !/^\s*@tailwind\s/.test(line))
    .join('\n')
}

const ERROR_BRIDGE = `(function () {
  function send(msg) { parent.postMessage(Object.assign({ source: 'stackly-preview' }, msg), '*') }
  window.addEventListener('error', function (e) {
    send({ type: 'runtime-error', message: String((e.error && e.error.message) || e.message || 'Unknown error') })
  })
  window.addEventListener('unhandledrejection', function (e) {
    send({ type: 'runtime-error', message: 'Unhandled rejection: ' + String((e.reason && e.reason.message) || e.reason) })
  })
})()`

export function buildSrcdoc(opts: {
  js: string
  css: string
  importMap: Record<string, string>
  tailwind: boolean
}): string {
  const escapedJs = opts.js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
  const css = opts.tailwind ? stripTailwindDirectives(opts.css) : opts.css
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="importmap">${JSON.stringify({ imports: opts.importMap })}</script>
<script>${ERROR_BRIDGE}</script>
${opts.tailwind ? `<script src="https://unpkg.com/@tailwindcss/browser@4"></script>` : ''}
<style>html,body,#root{min-height:100%}body{margin:0;font-family:system-ui,sans-serif}</style>
${css ? `<style>${css}</style>` : ''}
</head>
<body>
<div id="root"></div>
<script type="module">${escapedJs}</script>
</body>
</html>`
}
