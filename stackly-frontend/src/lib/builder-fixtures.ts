// Temporary dummy data for the builder chat, until that backend exists. Files,
// versions, and the preview are now real (see lib/builder-repo.ts and
// composables/usePreview.ts); the JSX constants below only feed the canned
// chat transcript. Consumed via stores/builder.ts (chat) and ChatPanel.

const APP_JSX = `import ContactsList from './components/ContactsList'
import AppointmentsCard from './components/AppointmentsCard'

export default function App() {
  return (
    <main className="app">
      <header>
        <h1>Recent Contacts</h1>
        <p>Live from your HighLevel location</p>
      </header>
      <section className="grid">
        <ContactsList limit={5} />
        <AppointmentsCard day="today" />
      </section>
    </main>
  )
}
`

const CONTACTS_LIST_JSX = `import { useEffect, useState } from 'react'
import { fetchContacts } from '../lib/ghl'

export default function ContactsList({ limit = 5 }) {
  const [contacts, setContacts] = useState([])

  useEffect(() => {
    fetchContacts(limit).then(setContacts)
  }, [limit])

  return (
    <ul className="contacts">
      {contacts.map((contact) => (
        <li key={contact.id}>
          <span>{contact.name}</span>
          <span className="muted">{contact.email}</span>
        </li>
      ))}
    </ul>
  )
}
`

const APPOINTMENTS_CARD_JSX = `import { useEffect, useState } from 'react'
import { fetchAppointments } from '../lib/ghl'

export default function AppointmentsCard({ day = 'today' }) {
  const [events, setEvents] = useState([])

  useEffect(() => {
    fetchAppointments(day).then(setEvents)
  }, [day])

  return (
    <div className="card">
      <h2>Appointments</h2>
      {events.map((event) => (
        <div key={event.id} className="event">
          <span>{event.title}</span>
          <time>{event.startTime}</time>
        </div>
      ))}
    </div>
  )
}
`

const GHL_JS = `const BASE_URL = 'https://services.leadconnectorhq.com'
const LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID

async function ghl(path, params = {}) {
  const url = new URL(path, BASE_URL)
  url.searchParams.set('locationId', LOCATION_ID)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url, {
    headers: { Version: '2021-07-28' },
  })
  if (!res.ok) throw new Error(\`GHL request failed: \${res.status}\`)
  return res.json()
}

export function fetchContacts(limit) {
  return ghl('/contacts/', { limit }).then((d) => d.contacts)
}

export function fetchAppointments(day) {
  return ghl('/calendars/events', { day }).then((d) => d.events)
}
`

export interface DiffLine {
  type: 'add' | 'del' | 'context'
  text: string
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

const addedLines = (src: string): DiffLine[] =>
  src.trimEnd().split('\n').map((text) => ({ type: 'add', text }))

export const MESSAGE_SEED = [
  {
    role: 'user' as const,
    text: 'Build me a dashboard that shows my recent contacts and upcoming calendar appointments.',
  },
  {
    role: 'assistant' as const,
    text: "Done — the dashboard pulls your 5 most recent contacts from the GHL Contacts API and today's events from the Calendars API.",
  },
  {
    role: 'diff' as const,
    summary: 'Edited 4 files',
    files: [
      { path: 'App.jsx', additions: 18, deletions: 0, lines: addedLines(APP_JSX) },
      {
        path: 'components/ContactsList.jsx',
        additions: 32,
        deletions: 0,
        lines: addedLines(CONTACTS_LIST_JSX),
      },
      {
        path: 'components/AppointmentsCard.jsx',
        additions: 27,
        deletions: 0,
        lines: addedLines(APPOINTMENTS_CARD_JSX),
      },
      { path: 'lib/ghl.js', additions: 12, deletions: 0, lines: addedLines(GHL_JS) },
    ] satisfies DiffFile[],
  },
  {
    role: 'assistant' as const,
    text: 'Preview updated. Want me to add search or pagination next?',
  },
]

export const CANNED_REPLY = {
  text: "On it — I'm updating the app now and wiring it to the matching GHL endpoint.",
  diff: {
    summary: 'Edited 2 files',
    files: [
      {
        path: 'src/App.jsx',
        additions: 9,
        deletions: 2,
        lines: [
          { type: 'context', text: '      <section className="grid">' },
          { type: 'del', text: '        <ContactsList limit={5} />' },
          { type: 'add', text: '        <ContactsList limit={10} />' },
          { type: 'add', text: '        <SearchBox onChange={setQuery} />' },
          { type: 'context', text: '        <AppointmentsCard day="today" />' },
          { type: 'context', text: '      </section>' },
        ],
      },
      {
        path: 'src/components/ContactsList.jsx',
        additions: 14,
        deletions: 3,
        lines: [
          { type: 'context', text: 'export default function ContactsList({ limit = 5 }) {' },
          { type: 'del', text: '  const [contacts, setContacts] = useState([])' },
          { type: 'add', text: '  const [contacts, setContacts] = useState([])' },
          { type: 'add', text: '  const [query, setQuery] = useState("")' },
          { type: 'context', text: '' },
          { type: 'del', text: '  useEffect(() => {' },
          { type: 'add', text: '  useEffect(() => {' },
          { type: 'add', text: '    fetchContacts(limit).then(setContacts)' },
          { type: 'del', text: '  }, [limit])' },
          { type: 'add', text: '  }, [limit, query])' },
        ],
      },
    ] satisfies DiffFile[],
  },
}

export const SUGGESTIONS = [
  { label: '+ Add search', prompt: 'Add a search box to filter contacts by name.' },
  { label: '+ Paginate contacts', prompt: 'Paginate the contacts list, 10 per page.' },
]

