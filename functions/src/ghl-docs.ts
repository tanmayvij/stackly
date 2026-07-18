// Frozen constants that ship to the model and to generated apps:
//  - GHL_CLIENT_SOURCE: the platform-owned `src/lib/ghl.js` injected into
//    every AI commit (see repo.ts). Generated code talks to the ghlProxy
//    function through it and never sees real GHL tokens.
//  - GHL_DOCS: the condensed API reference appended to the system prompt.
// Both are kept byte-identical across requests so the provider's prefix
// caching hits. NOTE: endpoint/param/response shapes must be reconciled
// against the live HighLevel API docs before changing them.

import {createHash} from "node:crypto";

export const GHL_CLIENT_SOURCE = `// src/lib/ghl.js — provided by Stackly. Do not edit.
const cfg = (typeof window !== "undefined" && window.__STACKLY_GHL__) || {};

export class GhlError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, opts = {}) {
  if (!cfg.proxyUrl || !cfg.token) {
    throw new GhlError(
      0,
      "HighLevel preview is not configured. Open this app from Stackly.",
    );
  }
  const url = new URL(cfg.proxyUrl.replace(/\\/$/, "") + path);
  for (const [k, v] of Object.entries(opts.params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + cfg.token,
      ...(opts.body ? {"Content-Type": "application/json"} : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — surfaced via the generic error message below.
  }
  if (!res.ok) {
    const msg =
      (json && (json.message || json.error)) ||
      "HighLevel request failed (" + res.status + ")";
    throw new GhlError(res.status, msg, json);
  }
  return json;
}

export const ghl = {
  get: (path, params) => request("GET", path, {params}),
  post: (path, body, params) => request("POST", path, {params, body}),
  put: (path, body, params) => request("PUT", path, {params, body}),
  del: (path, params) => request("DELETE", path, {params}),
  locationId: cfg.locationId || "",
};
`;

export const GHL_CLIENT_SHA256 = createHash("sha256")
  .update(GHL_CLIENT_SOURCE, "utf8")
  .digest("hex");

export const GHL_DOCS = `GHL CLIENT API (src/lib/ghl.js - provided by the platform)
- await ghl.get(path, params?)          e.g. ghl.get('/contacts/', { limit: 100 })
- await ghl.post(path, body?, params?)
- await ghl.put(path, body?, params?)
- await ghl.del(path, params?)
- ghl.locationId                        the connected location id (string)
Returns parsed JSON. On failure throws GhlError with .status (HTTP code),
.message and .body. The platform automatically supplies locationId on every
request - never send it yourself.

ALLOWED ENDPOINTS (every other path is blocked by the platform)
Contacts
- GET  /contacts/            params: limit (max 100), startAfterId, startAfter,
                             query (name/email/phone search)
                             -> { contacts: [...], meta: { total, startAfterId,
                             startAfter } }
                             Page by passing meta.startAfterId + meta.startAfter
                             from the previous page until fewer than limit
                             results return.
- GET  /contacts/{id}        -> { contact }
- POST /contacts/            body: { firstName, lastName, email, phone, tags?,
                             source? }
- PUT  /contacts/{id}        body: fields to update
- DELETE /contacts/{id}
Conversations
- GET  /conversations/search params: contactId?, status? (all|read|unread|
                             starred), sortBy?, sort? (asc|desc), limit (max
                             100), startAfterDate? (ms epoch cursor)
                             -> { conversations: [...], total }
                             Page with startAfterDate = last conversation's
                             sort date until fewer than limit return.
- GET  /conversations/{id}   -> conversation details incl. contact info
- GET  /conversations/{id}/messages   params: limit, lastMessageId (cursor)
                             -> { messages: { messages: [...], lastMessageId,
                             nextPage } }
                             Page with lastMessageId while nextPage is true.
- POST /conversations/messages  body: { type: 'SMS' | 'Email', contactId,
                             message, subject? (Email only) }
Calendars
- GET  /calendars/           -> { calendars: [...] }
- GET  /calendars/events     params: startTime, endTime (ms epoch) plus ONE of
                             calendarId | userId | groupId
                             -> { events: [...] }
- GET  /calendars/events/appointments/{eventId}  -> { appointment }
- POST /calendars/events/appointments  body: { calendarId, contactId,
                             startTime, endTime?, title?, appointmentStatus? }
- PUT  /calendars/events/appointments/{eventId}  body: fields to update
- DELETE /calendars/events/{eventId}
- GET  /calendars/groups     -> { groups: [...] }
- GET  /calendars/{calendarId}/free-slots  params: startDate, endDate (ms
                             epoch) -> { ...dates: { slots: [...] } }`;
