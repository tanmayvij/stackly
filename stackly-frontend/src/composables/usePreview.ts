import { ref, watch, type Ref } from 'vue'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { fetchBlob } from '@/lib/builder-repo'
import { bundlePreview } from '@/lib/preview-bundler'
import { buildImportMap, buildSrcdoc, wantsTailwind } from '@/lib/preview-html'
import { useAuthStore } from '@/stores/auth'
import { useBuilderStore } from '@/stores/builder'

export type PreviewStatus = 'empty' | 'building' | 'ready' | 'error'

export interface UsePreview {
  status: Ref<PreviewStatus>
  srcdoc: Ref<string>
  buildError: Ref<string | null>
  runtimeError: Ref<string | null>
  iframeKey: Ref<number>
  rebuild: () => void
}

export function usePreview(): UsePreview {
  const builder = useBuilderStore()
  const auth = useAuthStore()

  const status = ref<PreviewStatus>('empty')
  const srcdoc = ref('')
  const buildError = ref<string | null>(null)
  const runtimeError = ref<string | null>(null)
  const iframeKey = ref(0)

  let seq = 0

  async function build() {
    const mySeq = ++seq
    const uid = auth.user?.uid
    const pid = builder.projectId
    const manifest = builder.headManifest
    if (!uid || !pid) return

    if (builder.headVersion === 0 || !Object.values(manifest).some((h) => h !== null)) {
      status.value = 'empty'
      srcdoc.value = ''
      return
    }

    status.value = 'building'
    runtimeError.value = null

    const outcome = await bundlePreview(manifest, (path) => fetchBlob(uid, pid, manifest[path]!))
    if (mySeq !== seq) return

    if (!outcome.ok) {
      status.value = 'error'
      buildError.value = outcome.error
      return
    }

    const pkgHash = manifest['package.json']
    const packageJson = pkgHash ? await fetchBlob(uid, pid, pkgHash) : null
    if (mySeq !== seq) return

    const tailwind = wantsTailwind({ externals: outcome.externals, css: outcome.css, packageJson })
    srcdoc.value = buildSrcdoc({
      js: outcome.js,
      css: outcome.css,
      importMap: buildImportMap({ externals: outcome.externals, packageJson }),
      tailwind,
    })
    buildError.value = null
    status.value = 'ready'
  }

  const debouncedBuild = useDebounceFn(() => void build(), 300)

  watch(
    () => [builder.projectId, builder.headVersion] as const,
    () => void debouncedBuild(),
    { immediate: true },
  )

  useEventListener(window, 'message', (e: MessageEvent) => {
    if (e.data?.source === 'stackly-preview' && e.data.type === 'runtime-error') {
      runtimeError.value = String(e.data.message)
    }
  })

  function rebuild() {
    iframeKey.value++
    void build()
  }

  return { status, srcdoc, buildError, runtimeError, iframeKey, rebuild }
}
