// Frozen constants that ship to the model and to generated apps:
//  - GHL_CLIENT_SOURCE: the platform-owned `src/lib/ghl.js` injected into
//    every AI commit (see modules/builder/versions). Generated code talks to
//    the ghlProxy function through it and never sees real GHL tokens.
//  - GHL_DOCS: the condensed API reference appended to the system prompt.
// Both are kept byte-identical across requests so the provider's prefix
// caching hits. Endpoint shapes were reconciled against the official
// HighLevel API docs (marketplace.gohighlevel.com/docs/ghl, 2026-07-18);
// Version headers and locationId are injected by the ghl proxy, so neither
// appears here.

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
  del: (path, params, body) => request("DELETE", path, {params, body}),
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
- await ghl.del(path, params?, body?)   some DELETEs take a JSON body (noted below)
- ghl.locationId                        the connected location id (string)
Returns parsed JSON. On failure throws GhlError with .status (HTTP code),
.message and .body. The platform automatically supplies locationId plus all
auth and version headers on every request - never send them yourself.

ALLOWED ENDPOINTS (every other path is blocked by the platform)

CONTACTS
- GET  /contacts/            params: limit (max 100), startAfterId, startAfter
                             (ms epoch number), query (name/email/phone text)
                             -> { contacts: [{ id, firstName, lastName, email,
                             phone, tags, source, dateAdded }], meta: { total,
                             startAfterId, startAfter } }
                             Page by passing BOTH meta.startAfterId and
                             meta.startAfter from the previous page until
                             fewer than limit return.
- POST /contacts/search      body: { query?, page (from 1), pageLimit (max
                             500), filters?, sort? }
                             filters: ANDed array of { field, operator, value }
                             or { group: 'AND'|'OR', filters: [...] }.
                             operators: eq, not_eq, contains, not_contains,
                             exists, not_exists, range ({ gt|gte|lt|lte }).
                             e.g. { field: 'tags', operator: 'contains',
                             value: 'vip' }
                             -> { contacts: [...], total }
                             Page by incrementing page while contacts.length
                             equals pageLimit.
- GET  /contacts/{id}        -> { contact: { id, firstName, lastName, email,
                             phone, tags, dnd, source, assignedTo, city,
                             state, country, dateOfBirth, dateAdded,
                             customFields: [{ id, value }] } }
- POST /contacts/            body: firstName?, lastName?, email?, phone?
                             (E.164 like +18885551234), tags?, source?,
                             assignedTo?, dateOfBirth? (YYYY-MM-DD),
                             customFields? ([{ id, value }])
                             At least one of name/email/phone is required.
                             -> { contact: {...} }
- POST /contacts/upsert      body: same as create; matches an existing
                             contact by email, then phone
                             -> { new (bool), contact: {...} }
- PUT  /contacts/{id}        body: fields to update. WARNING: passing tags
                             REPLACES the whole tag list - use the tag
                             endpoints to add/remove instead.
                             -> { succeded: true, contact: {...} }
- DELETE /contacts/{id}      -> { succeded: true }
- POST /contacts/{id}/tags   body: { tags: ['a', 'b'] } -> { tags: [...] }
- DELETE /contacts/{id}/tags body (3rd argument of ghl.del):
                             { tags: ['a'] } -> { tags: [...] }
- GET  /contacts/{id}/tasks  -> { tasks: [{ id, title, body, dueDate,
                             completed, assignedTo }] } (all, no paging)
- POST /contacts/{id}/tasks  body: title, dueDate (ISO UTC like
                             2025-10-25T11:00:00Z) and completed (bool) are
                             required; body?, assignedTo?
                             -> { task: {...} }
- PUT  /contacts/{id}/tasks/{taskId}   body: any task fields
                             -> { task: {...} }
- PUT  /contacts/{id}/tasks/{taskId}/completed   body: { completed: true }
- DELETE /contacts/{id}/tasks/{taskId} -> { succeded: true }
- GET  /contacts/{id}/notes  -> { notes: [{ id, body, userId, dateAdded }] }
                             (all, no paging)
- POST /contacts/{id}/notes  body: body (text, required), userId?
                             -> { note: {...} }
- PUT  /contacts/{id}/notes/{noteId}  body: { body } -> { note: {...} }
- DELETE /contacts/{id}/notes/{noteId} -> { succeded: true }
- GET  /contacts/{id}/appointments   -> { events: [{ id, calendarId, title,
                             appointmentStatus, startTime, endTime,
                             assignedUserId }] } (all; times formatted
                             'YYYY-MM-DD HH:mm:ss' with no timezone offset)

CONVERSATIONS
- GET  /conversations/search params: contactId?, query?, status? (all|read|
                             unread|starred|recents), sortBy?
                             (last_message_date), sort? (asc|desc),
                             limit (max 100), startAfterDate? (ms epoch)
                             -> { conversations: [{ id, contactId, fullName,
                             email, phone, lastMessageBody, lastMessageType,
                             type, unreadCount }], total }
                             Page: set startAfterDate to the last returned
                             conversation's sort timestamp; repeat until
                             fewer than limit return.
- GET  /conversations/{id}   -> { id, contactId, unreadCount, starred, ... }
- PUT  /conversations/{id}   body: unreadCount? (0 marks read), starred?
                             -> { success, conversation }
- POST /conversations/       body: { contactId } -> { conversation }
                             (only for contacts with no conversation yet)
- GET  /conversations/{id}/messages   params: limit (default 20),
                             lastMessageId? (cursor), type? (TYPE_* filter)
                             -> { messages: [{ id, direction (inbound|
                             outbound), messageType (TYPE_SMS, TYPE_EMAIL,
                             TYPE_CALL, ...), body, status, dateAdded,
                             attachments }], lastMessageId, nextPage (bool) }
                             Newest first. Page: while nextPage is true,
                             re-call with lastMessageId from the response.
- POST /conversations/messages   Send a message.
                             body: type ('SMS' or 'Email'), contactId,
                             message? (SMS text), subject? and html? (Email),
                             attachments? (array of URLs),
                             scheduledTimestamp? (UTC SECONDS, not ms)
                             -> { conversationId, messageId, emailMessageId? }

CALENDARS
- GET  /calendars/           params: groupId?
                             -> { calendars: [{ id, name, description,
                             calendarType, groupId, isActive, slotDuration,
                             teamMembers: [{ userId }] }] } (no pagination)
- GET  /calendars/groups     -> { groups: [{ id, name, description, slug,
                             isActive }] } (no pagination)
- GET  /calendars/{calendarId}/free-slots   params: startDate, endDate
                             (ms epoch, REQUIRED, range max 31 days),
                             timezone? (IANA like America/New_York)
                             -> a map keyed by date, NOT an array:
                             { '2025-10-28': { slots:
                             ['2025-10-28T10:00:00-05:00', ...] }, ... }
- GET  /calendars/events     params: startTime, endTime (ms epoch, REQUIRED)
                             plus exactly ONE of calendarId | userId | groupId
                             -> { events: [{ id, title, calendarId,
                             contactId, appointmentStatus, assignedUserId,
                             startTime, endTime (ISO with offset), notes }] }
                             (no pagination). GET /calendars/blocked-slots
                             takes the same params and returns blocked time.
- GET  /calendars/events/appointments/{eventId} -> { event: {...} }
- POST /calendars/events/appointments   body: calendarId, contactId and
                             startTime (ISO with offset like
                             2025-06-23T15:30:00+05:30) are required;
                             endTime?, title?, appointmentStatus? (new|
                             confirmed|cancelled|showed|noshow|invalid),
                             assignedUserId?, ignoreDateRange?,
                             ignoreFreeSlotValidation?
                             -> the appointment object (id at top level)
                             Times not on a free slot are rejected unless
                             ignoreFreeSlotValidation is true.
- PUT  /calendars/events/appointments/{eventId}   body: any create fields;
                             set appointmentStatus 'cancelled' to cancel
                             -> the appointment object
- DELETE /calendars/events/{eventId}   removes the event entirely (prefer
                             cancelling via PUT) -> { succeeded: bool }
- GET  /calendars/appointments/{appointmentId}/notes   params: limit and
                             offset (BOTH required)
                             -> { notes: [{ id, body, dateAdded }], hasMore }
                             Page by offset += limit while hasMore.
- POST /calendars/appointments/{appointmentId}/notes   body: { body: 'text' }
                             -> { note: {...} }

API QUIRKS - follow exactly
- Date formats differ by endpoint; use the format shown above. ms epoch
  numbers: calendar events/free-slots ranges, contact startAfter,
  conversation startAfterDate. ISO with offset: appointment bodies. ISO UTC
  (Z): task dueDate. scheduledTimestamp: UTC seconds.
- Some success responses spell it 'succeded' - match that spelling.
- Send-message type ('SMS'|'Email') is a different enum from the TYPE_*
  values used in message filters and messageType fields.
- The platform auto-sends the JSON body that DELETE /calendars/events
  requires; for DELETE /contacts/{id}/tags pass the body yourself.
- Phone numbers are E.164 (+15551234567).`;
