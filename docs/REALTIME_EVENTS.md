# Realtime Events

WebSocket namespace: `/match`  
Transport: Socket.IO  
Auth: client sends `userId` in handshake `auth` object (will be replaced with JWT in Phase 5).

---

## Event Inventory

| Direction        | Event name               | When                                               |
|------------------|--------------------------|----------------------------------------------------|
| server → client  | `match.found`            | Match engine pairs two users                       |
| server → client  | `match.expired`          | Session timer elapsed OR user ended session        |
| server → client  | `match.partner_liked`    | Partner sent a like (before mutual)                |
| server → client  | `match.mutual_like`      | Both users liked — session resolved                |
| server → client  | `conversation.created`   | Permanent conversation created after mutual like   |
| server → client  | `session.message`        | Ephemeral relay of an anonymous in-session message |
| server → client  | `session.message.error`  | Validation or auth rejection for session.message   |
| client → server  | `session.message`        | Send a message during an active anonymous session  |
| client → server  | `match.send_like`        | User taps Like during a session                    |
| client → server  | `typing.start`           | User starts typing (future)                        |
| client → server  | `typing.stop`            | User stops typing (future)                         |
| client → server  | `heartbeat`              | Presence keepalive                                 |

---

## Event Payloads

### `match.found` (server → client)

```json
{
  "sessionId": "uuid",
  "type": "TEXT | VOICE",
  "expiresAt": "2026-06-27T10:03:00.000Z"
}
```

For `VOICE` sessions, two additional fields are included — each user receives their **own** token:

```json
{
  "sessionId": "uuid",
  "type": "VOICE",
  "expiresAt": "2026-06-27T10:03:00.000Z",
  "roomId": "derived-room-id",
  "zegoToken": "<per-user-token>"
}
```

---

### `match.expired` (server → client)

Sent on both timer expiry **and** when a user calls `POST /match/sessions/:id/end`. The client behaviour is identical in both cases (show rating screen, close anonymous chat).

```json
{ "sessionId": "uuid" }
```

---

### `match.partner_liked` (server → client)

Notifies the non-liking user that their partner has sent a like (before the like is mutual). The client may show a visual indicator.

```json
{ "sessionId": "uuid" }
```

---

### `match.mutual_like` (server → client)

Both users have liked. The anonymous session is over. A permanent conversation has been created.

```json
{
  "sessionId": "uuid",
  "conversationId": "uuid"
}
```

---

### `conversation.created` (server → client)

Sent immediately after `match.mutual_like`. Each user receives the **other** person's profile details (anonymity is lifted at this point).

```json
{
  "conversationId": "uuid",
  "withUserId": "uuid",
  "withUsername": "alice",
  "withAvatarUrl": "https://... | null"
}
```

---

### `session.message` — client → server

Sends an ephemeral text message to the other anonymous participant during an ACTIVE match session.

**⚠ EPHEMERAL: These messages are NOT persisted anywhere (no DB write, no Redis write). The server is a pure relay. There is no message history, no pagination, and no replay after reconnect.**

```json
{
  "sessionId": "uuid",
  "content": "Hey, what kind of music do you like?"
}
```

**Validation rules:**
- `sessionId` must be a non-empty string.
- `content` must be a non-empty string, max 2,000 characters.
- Sender must be a participant in the session (`userAId` or `userBId` in `match:session:{sessionId}` Redis hash).
- Session `status` in Redis must be `ACTIVE`.

If any check fails, the server emits `session.message.error` back to the sender only.

---

### `session.message` — server → client

Relayed to the **other** participant only (the sender does NOT receive a copy). No `senderId` is included — both users appear as "Stranger" to maintain anonymity.

```json
{
  "sessionId": "uuid",
  "content": "Hey, what kind of music do you like?",
  "sentAt": "2026-06-27T10:01:42.123Z"
}
```

**Note:** `sentAt` is the server relay timestamp, not the client send time. There is no message ID; the client should treat each event as a fire-and-forget display item.

---

### `session.message.error` (server → client)

Sent back to the **sender only** when their `session.message` is rejected. The partner never sees this event.

```json
{
  "sessionId": "uuid",
  "reason": "Session not found or already ended"
}
```

Possible `reason` values:

| Reason | Cause |
|--------|-------|
| `Not authenticated` | Socket is not registered (internal guard) |
| `sessionId is required` | Payload missing or malformed sessionId |
| `content must be a non-empty string` | Missing or blank content |
| `content exceeds maximum length of 2000 characters` | Content too long |
| `Session not found or already ended` | Redis hash missing — session expired or ended |
| `You are not a participant in this session` | Sender userId not in userAId/userBId |
| `Session is not active (status: <STATUS>)` | Status is EXPIRED, ENDED, or MUTUAL_LIKE |

---

## Session Message Lifecycle

```
Client A                    Server (MatchGateway)              Client B
   |                               |                               |
   |-- session.message ----------->|                               |
   |   { sessionId, content }      |                               |
   |                               |-- hgetall match:session:id    |  (Redis lookup)
   |                               |<-- { userAId, userBId,        |
   |                               |     status: ACTIVE }          |
   |                               |                               |
   |                               |-- session.message ----------->|
   |                               |   { sessionId, content,       |
   |                               |     sentAt }                  |
   |                               |                               |
   | (no echo back to sender)      |                               |
```

If validation fails at any step, `session.message.error` is emitted back to Client A only.

---

## Redis Lookup — Why Not Postgres?

Session message relay uses `HGETALL match:session:{sessionId}` from Redis rather than a Postgres query. Rationale:

- The `match:session:{id}` hash is written atomically when the session is created and deleted immediately when the session ends or expires.
- It is already the authoritative real-time source for `status`, `userAId`, and `userBId`.
- An in-memory O(1) Redis read adds negligible latency on the hot path (every message relay).
- Postgres is the audit log; Redis is the truth for "is this session ACTIVE right now?"

---

## Persistence Boundary

| Layer | Anonymous session messages | Permanent conversation messages |
|-------|---------------------------|---------------------------------|
| Redis | not written | not applicable |
| Postgres | not written | written via MessagesService |

Anonymous in-session messages are relay-only. They vanish when the connection drops or the session ends. This is intentional — the product model is "talk first, reveal later," and history before mutual like would undermine anonymity.
