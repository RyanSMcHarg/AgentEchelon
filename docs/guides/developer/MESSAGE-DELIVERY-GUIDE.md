# Message delivery & size: how assistant output reaches Amazon Chime SDK

> **Read this before building any feature that produces, extends, or
> re-renders a channel message** - a reply, a recap, a notification, a
> bilingual/translated message, an attachment, anything that calls
> `SendChannelMessage`/`UpdateChannelMessage`. The Amazon Chime SDK size limits and the
> encoding multiplier are non-obvious and have bitten real features
> (a 4641-char answer threw `BadRequestException: size limit exceeded` even
> after a naive 5-way split). The machinery to do it right already exists;
> this guide points you at it so you don't reinvent it (wrongly).

Canonical implementation: `backend/lambda/src/lib/async-processor-core.ts`.

## The two hard limits - and they're on the ENCODED length

Amazon Chime SDK Messaging caps the **request-parameter length**, i.e.
`encodeURIComponent(s).length`, **not** the raw character count:

| Field | Cap (encoded chars) | Constant |
|---|---|---|
| Message `Content` | 4096 | `CHIME_CONTENT_MAX` |
| Message `Metadata` | 1024 | `CHIME_METADATA_MAX` |

Working budget used in code: `CHIME_CONTENT_SAFE = 3600`, with
`CHUNK0_MARKER_HEADROOM = 700` reserved on the first chunk for the
`<!--ACTIVE_TASK-->` / `<!--battlestats-->` markers that `finalize` appends
after the split. Use `encodedLen(s)` (= `encodeURIComponent(s).length`) to
measure - never `s.length`.

### The encoding multiplier (the part everyone misses)

- **Prose/markdown roughly doubles** when URL-encoded (spaces, punctuation,
  newlines).
- **CJK is ~9x per character**: a Chinese character encodes to `%XX%XX%XX` = 9
  encoded chars. So the *effective* budgets for Chinese are about **~450 chars
  in Content** and **~110 chars in Metadata**. For any feature touching Chinese
  (e.g. a CJK-language deployment), the encoding multiplier - not the word
  count - is the real constraint. Re-budget accordingly; do not reason in raw
  chars.

## The helpers - use them, don't hand-roll `SendChannelMessage`

| Need | Use | Behaviour |
|---|---|---|
| Send a possibly-long reply | `handleLongResponse(response, userType, channelArn?, botArn?, parentMessageId?)` | Within budget: returns it as a single `content`. Over budget: `splitIntoChunks` it - chunk[0] UPDATEs the placeholder; chunks[1..] are sent as new `STANDARD` messages tagged with a shared `responseGroup` + `{ continuation, part, totalParts }` metadata. |
| Split text by encoded budget | `splitIntoChunks(response, firstBudget, restBudget)` | Cuts on encoded length (chunk[0] gets the smaller marker-reserved budget). Trims only whitespace, so every chunk stays within budget. |
| Cut a string at a safe encoded index | `cutIndexByEncoded(text, budget)` | Largest prefix whose encoded length fits. |
| Attach a long deliverable instead of walling the channel | `buildAttachmentLede(response)` | The full text rides as an S3 attachment; the inline message is a short (~400-char) lede (the model's opening summary). Use for reports/long-form, not chat turns. |
| Put structured info on a message | `safeMetadataString(metadata)` | Returns the JSON **only if** it fits 1024 encoded; otherwise **drops it (with a warning)** rather than failing the post - deliberate "honest degradation". |

## Rules of thumb (the do / don't)

- **Never put large or variable-length text in `Metadata`.** It's a 1024
  *encoded* budget AND `safeMetadataString` silently drops anything over it - 
  so the content would just vanish (worse for Chinese, ~110 chars). Metadata
  is for **small structured tags only**: `responseGroup`, `part`,
  `totalParts`, `continuation`, ids, a language code. If a feature needs to
  carry text, it goes in **Content** (through `handleLongResponse`) or an
  **attachment** - never Metadata. **Analytics decoupling (Aurora mode):** the
  heavy per-message analytics fields (tokens, latencies, config fingerprint,
  etc.) do not ride Amazon Chime SDK `Metadata`. The async processor writes the full blob
  to a dedicated `MessageAnalyticsTable` keyed by message id, the Aurora archival
  pipeline reads it from there, and the Amazon Chime SDK `Metadata` carries just the
  frontend-rendered fields (`pickFrontendMetadata`). So an over-budget turn does
  not drop analytics or the experiment join. In Athena mode (no archival consumer
  for these fields) the Metadata stays full and relies on the shedding backstop.
  Full design: `docs/specs/conversation-messaging/SPEC-MESSAGE-METADATA-CODEBOOK.md`.
- **Always route long output through `handleLongResponse`.** Don't call
  `SendChannelMessage` with un-chunked Content you didn't measure with
  `encodedLen`.
- **Link multi-part output with `responseGroup`** so the surface can regroup
  it. Continuation chunks already carry `{ responseGroup, part, totalParts }`.
- **Markers live in Content chunk[0]**, not Metadata
  (`<!--ACTIVE_TASK:-->`, `<!--corr:-->`, `<!--battlestats:-->`) - and are
  stripped before display by the surface (`frontend/.../messageParser.ts`,
  and the embeddable widget's marker strip). Reserve headroom for them
  (`CHUNK0_MARKER_HEADROOM`) if you add to chunk[0].
- **Re-budget for the user's language.** A budget that's fine for English can
  overflow in Chinese by ~4.5x. Test the size path with CJK input.

## Surface (frontend / widget) contract

The producing side guarantees each message is within the encoded caps and
tags multi-part output with `responseGroup`. The consuming side
(`frontend/src/utils/messageParser.ts` in the SPA; the embeddable widget for
host deployments) is responsible for: stripping `<!--...-->` markers, unwrapping
the Lex `{"Messages":[...]}` envelope, the placeholder->final UPDATE in place, and
regrouping `responseGroup` continuation parts. A new surface that renders
channel messages must honour all four or it will show raw markers, JSON
envelopes, or split walls.

**Rendering.** In the SPA, assistant replies render as **GFM Markdown**
(`react-markdown` + `remark-gfm`, in `frontend/src/components/CollapsibleText.tsx`):
headings, lists, tables, fenced/inline code, and links. Raw HTML is escaped/ignored by
default, so rendering is XSS-safe without a separate sanitizer. User messages stay plain
text. A new surface should render assistant output as Markdown (and keep raw HTML off) for
parity; a plain-text surface will show `**`, `#`, and pipes literally.

## When you're extending output (e.g. bilingual / translation)

Adding a second language, citations, or any per-message extra text is a
**size** change first and a feature second. Decide up front:
1. Does it inflate `Content`? -> it must go through `handleLongResponse`.
2. Is it small + structured (a tag, an id, a lang code)? -> `Metadata` via
   `safeMetadataString` is fine.
3. Is it large + must survive? -> Content or attachment, **never** Metadata.
4. Did you re-budget for CJK?

See `docs/specs/assistant-context/SPEC-BILINGUAL-CONVERSATIONS.md` for a worked example (it deliberately
sends a second language as a linked sibling message via `responseGroup`, with
only small tags in Metadata, precisely because of the limits above).

## Related

- `docs/specs/conversation-messaging/SPEC-MESSAGE-METADATA-CODEBOOK.md` - how to keep `Metadata` under the
  1024 cap durably: coded (integer) values for bounded state fields + heavy
  analytics moved out of band, keyed by message id. OSS-replicable for your own
  intents/states.
- `docs/overview/ARCHITECTURE.md` / `backend/ARCHITECTURE.md` - the Lex->Lambda->Amazon Chime SDK
  message flow and the direct-send pattern these helpers implement.
- `docs/specs/assistant-context/SPEC-PER-PROFILE-OWNERSHIP.md` - the shared async processor that calls
  `handleLongResponse` on every reply.
- `docs/specs/assistant-context/SPEC-BILINGUAL-CONVERSATIONS.md` - first feature to extend output and
  the reason this guide exists.
