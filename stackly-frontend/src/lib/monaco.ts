import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@guolao/vue-monaco-editor'
import reactDts from '../../node_modules/@types/react/index.d.ts?raw'
import reactGlobalDts from '../../node_modules/@types/react/global.d.ts?raw'
import reactJsxRuntimeDts from '../../node_modules/@types/react/jsx-runtime.d.ts?raw'
import reactDomDts from '../../node_modules/@types/react-dom/index.d.ts?raw'
import reactDomClientDts from '../../node_modules/@types/react-dom/client.d.ts?raw'
import csstypeDts from '../../node_modules/csstype/index.d.ts?raw'

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

monaco.typescript.javascriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowNonTsExtensions: true,
})
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
})
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowNonTsExtensions: true,
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  esModuleInterop: true,
})
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  // 2307/7016: project files are fetched lazily, so imports of not-yet-opened
  // files can't resolve — suppress those instead of all semantic validation.
  diagnosticCodesToIgnore: [2307, 7016],
})
monaco.typescript.typescriptDefaults.setEagerModelSync(true)

const TYPE_LIBS: Record<string, string> = {
  'file:///node_modules/@types/react/index.d.ts': reactDts,
  'file:///node_modules/@types/react/global.d.ts': reactGlobalDts,
  'file:///node_modules/@types/react/jsx-runtime.d.ts': reactJsxRuntimeDts,
  'file:///node_modules/@types/react-dom/index.d.ts': reactDomDts,
  'file:///node_modules/@types/react-dom/client.d.ts': reactDomClientDts,
  'file:///node_modules/csstype/index.d.ts': csstypeDts,
}
for (const [uri, content] of Object.entries(TYPE_LIBS)) {
  monaco.typescript.typescriptDefaults.addExtraLib(content, uri)
}

loader.config({ monaco })

const EXT_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  css: 'css',
  md: 'markdown',
}

export function languageFromPath(path: string): string {
  return EXT_LANGUAGE[path.split('.').pop() ?? ''] ?? 'plaintext'
}
