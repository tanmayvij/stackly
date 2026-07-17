// Temporary dummy data for the builder screen, until the files/versions/chat
// backend exists. Consumed only via stores/builder.ts.

export interface FileSeed {
  id: string
  name: string
  parentId: string | null
  kind: 'file' | 'folder'
  content?: string
}

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

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Recent Contacts Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`

const PACKAGE_JSON = `{
  "name": "recent-contacts-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^7.0.0"
  }
}
`

export const FILE_SEED: FileSeed[] = [
  { id: 'src', name: 'src', parentId: null, kind: 'folder' },
  { id: 'app-jsx', name: 'App.jsx', parentId: 'src', kind: 'file', content: APP_JSX },
  { id: 'components', name: 'components', parentId: 'src', kind: 'folder' },
  {
    id: 'contacts-list-jsx',
    name: 'ContactsList.jsx',
    parentId: 'components',
    kind: 'file',
    content: CONTACTS_LIST_JSX,
  },
  {
    id: 'appointments-card-jsx',
    name: 'AppointmentsCard.jsx',
    parentId: 'components',
    kind: 'file',
    content: APPOINTMENTS_CARD_JSX,
  },
  { id: 'lib', name: 'lib', parentId: 'src', kind: 'folder' },
  { id: 'ghl-js', name: 'ghl.js', parentId: 'lib', kind: 'file', content: GHL_JS },
  { id: 'index-html', name: 'index.html', parentId: null, kind: 'file', content: INDEX_HTML },
  { id: 'package-json', name: 'package.json', parentId: null, kind: 'file', content: PACKAGE_JSON },
]

export const DEFAULT_ACTIVE_FILE_ID = 'app-jsx'

export const VERSION_SEED = [
  { n: 12, message: 'Add appointments card', timeAgo: '2m ago' },
  { n: 11, message: 'Style contact rows', timeAgo: '14m ago' },
  { n: 10, message: 'Fetch contacts from GHL', timeAgo: '1h ago' },
  { n: 9, message: 'Initial scaffold', timeAgo: '2h ago' },
]

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

export const PREVIEW_SRCDOC = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; color: #18181b; background: #fff; }
      main { padding: 24px; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .sub { color: #71717a; font-size: 13px; margin: 0 0 20px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .card { border: 1px solid #e5e5e9; border-radius: 10px; padding: 16px; }
      .card h2 { font-size: 14px; margin: 0 0 12px; }
      .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f1f4; font-size: 13px; }
      .row:last-child { border-bottom: none; }
      .muted { color: #71717a; }
      @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Recent Contacts</h1>
      <p class="sub">Live from your HighLevel location</p>
      <div class="grid">
        <div class="card">
          <h2>Contacts</h2>
          <div class="row"><span>Jordan Lee</span><span class="muted">jordan@acme.co</span></div>
          <div class="row"><span>Priya Sharma</span><span class="muted">priya@acme.co</span></div>
          <div class="row"><span>Marcus Webb</span><span class="muted">marcus@acme.co</span></div>
          <div class="row"><span>Elena Ruiz</span><span class="muted">elena@acme.co</span></div>
          <div class="row"><span>Sam Okafor</span><span class="muted">sam@acme.co</span></div>
        </div>
        <div class="card">
          <h2>Appointments</h2>
          <div class="row"><span>Kickoff call</span><span class="muted">10:00</span></div>
          <div class="row"><span>Demo — Acme West</span><span class="muted">13:30</span></div>
          <div class="row"><span>Follow-up: Ruiz</span><span class="muted">16:00</span></div>
        </div>
      </div>
    </main>
  </body>
</html>
`
