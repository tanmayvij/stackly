import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { disconnectGhl, exchangeGhlCode, getGhlConnection } from '@/lib/callables'

interface GhlConnection {
  locationName: string
  scopesGranted: number
}

// GHL's marketplace location-picker authorize screen.
const AUTHORIZE_BASE = 'https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation'

const CLIENT_ID = import.meta.env.VITE_GHL_CLIENT_ID as string | undefined
const REDIRECT_URI = import.meta.env.VITE_GHL_REDIRECT_URI as string | undefined
const SCOPES = import.meta.env.VITE_GHL_SCOPES as string | undefined
const VERSION_ID = import.meta.env.VITE_GHL_VERSION_ID as string | undefined

export const useGhlStore = defineStore('ghl', () => {
  const connection = ref<GhlConnection | null>(null)

  const isConnected = computed(() => connection.value !== null)

  /** Loads the current connection status from the server. */
  async function fetchConnection() {
    const { data } = await getGhlConnection()
    connection.value = data
  }

  /** Builds the GHL authorize URL and redirects the browser to it. */
  function startConnect() {
    if (!CLIENT_ID || !REDIRECT_URI) {
      throw new Error('HighLevel OAuth is not configured (missing VITE_GHL_* env).')
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES ?? '',
    })
    if (VERSION_ID) params.set('version_id', VERSION_ID)
    window.location.href = `${AUTHORIZE_BASE}?${params.toString()}`
  }

  /** Exchanges the authorization code for a stored connection. */
  async function finalizeConnect(code: string) {
    const { data } = await exchangeGhlCode({ code, redirectUri: REDIRECT_URI ?? '' })
    connection.value = data
  }

  async function disconnect() {
    await disconnectGhl()
    connection.value = null
  }

  function reset() {
    connection.value = null
  }

  return {
    connection,
    isConnected,
    fetchConnection,
    startConnect,
    finalizeConnect,
    disconnect,
    reset,
  }
})
