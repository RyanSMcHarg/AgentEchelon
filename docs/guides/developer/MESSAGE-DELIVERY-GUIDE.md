# Message delivery & size: how assistant output reaches Amazon Chime SDK

> **Read this before building any feature that produces, extends, or re-renders a channel message** - a reply, a recap, a notification, a bilingual/translated message, an attachment, anything that calls `SendChannelMessage`/`UpdateChannelMessage`. The Amazon Chime SDK size limits apply to the encoded length, so text that fits by character count can still be refused with `BadRequestException: size limit exceeded`. The machinery to handle this exists; this guide points at it.

Canonical implementation: `backend/lambda/src/lib/chime/send.ts` (the one send, the caps and the one splitter) and `backend/lambda/src/lib/async-processor-core.ts` (the answer path).

## Encoded limits

Amazon Chime SDK Messaging caps the **request-parameter length**, i.e. `encodeURIComponent(s).length`, **not** the raw character count:

| Field | Cap (encoded chars) | Constant |
|---|---|---|
| Message `Content` | 4096 | `CHIME_CONTENT_MAX` |
| Message `Metadata` | 1024 | `CHIME_METADATA_MAX` |

Working budget used in code: `CHIME_CONTENT_SAFE = 3600`, with `CHUNK0_MARKER_HEADROOM = 700` reserved on the first chunk for the `<!--ACTIVE_TASK-->` / `<!--battlestats-->` markers that `finalize` appends after the split. Measure with `encodeURIComponent(s).length`, never `s.length`. A caller does not measure for itself: it posts through `sendInParts` or `handleLongResponse`, which split with `splitIntoChunks` and measure for it.

### Encoding multiplier

- **Prose/markdown roughly doubles** when URL-encoded (spaces, punctuation, newlines).
- **CJK is ~9x per character**: a Chinese character encodes to `%XX%XX%XX` = 9 encoded chars. So the *effective* budgets for Chinese are about **~450 chars in Content** and **~110 chars in Metadata**. For any feature touching Chinese (e.g. a CJK-language deployment), the encoding multiplier - not the word count - is the real constraint. Re-budget accordingly; do not reason in raw chars.

## Helpers

Use these rather than calling `SendChannelMessage` directly. The send, the caps and the splitter are exported from `lib/chime/send.ts`; `handleLongResponse`, `buildAttachmentLede` and `safeMetadataString` from `async-processor-core.ts`.

**A long message is split, never cut, everywhere.** An answer, an event workflow's agent step, a voiced send, a prompt welcome, an admin notice, and every message the router posts (a workflow `send`, a notice, the welcome's opening, the intake offer, a refusal, a stop acknowledgment, the turn's own reply on a flow entry) each post one response, in as many parts as it needs, through the same splitter and with the same continuation Metadata, so the chat app shows each as one response. Every part is percent-encoded, as every platform message is, and the markers a long text carries (`<!--corr:-->`, `<!--turn:-->`) ride its first part. `fitEncoded` fits a value to one message only where the medium holds it exactly once: an email subject inside Metadata, or a reply with no conversation to post further parts into.

**The Amazon Lex entry.** Amazon Lex V2 refuses a fulfillment message over 1000 characters (`LEX_MESSAGE_MAX`, `router-agent-handler.ts`). A reply on the Lex entry that fits goes back through Amazon Lex; a longer one is posted as the assistant in parts and Amazon Lex is handed the message the channel flow denies (`replyThroughLex`). Amazon Lex carries only a targeted message and the room's welcome ([ADR-036](../../design/decisions/036-why-turns-enter-through-amazon-lex.md)), so the parts are addressed to the person who spoke, as Amazon Lex's own reply would be, and the welcome is said to the room.

**Single by construction.** A placeholder (replaced in place by its answer), the queue's notice (updated in place), a handover instruction (the receiving assistant's one turn message), and a person's own email reply are each one message by what they are, and are sent with `sendChannelMessage`. `a-long-message-is-one-response-in-parts.test.ts` holds that list.

| Need | Use | Behavior |
|---|---|---|
| Send a possibly-long reply | `handleLongResponse(response, channelArn?, botArn?, parentMessageId?, parentTarget?, suppressContinuations?, copy?)` | `parentTarget` is the placeholder's `Target` when the caller already read it, so the continuations inherit the reply's real visibility without a second `GetChannelMessage`; omitting it makes this read the message itself rather than assume untargeted. `suppressContinuations` splits the response and returns chunk[0] without sending chunks[1..], which is how a stopped turn leaves nothing extra in the room. `copy` is the assistant's copy, so a truncation note is in its words. Within budget: returns it as a single `content`. Over budget: `splitIntoChunks` it - chunk[0] UPDATEs the placeholder; chunks[1..] are sent as new `STANDARD` messages tagged with a shared `responseGroup` + `{ continuation, part, totalParts }` metadata. |
| Post a new message that may be long | `sendInParts(client, { ...message, text })` (`lib/chime/send.ts`) | Splits `text` and posts the first part with the caller's Metadata, then each further part in order with `{ parentMessageId, responseGroup, continuation, part, totalParts }`, every part to the same `Target`. Throws `PartRefused` naming the first part refused, so a caller that records one outcome records it as posted only when every part was. |
| Split text by encoded budget | `splitIntoChunks(response, firstBudget?, restBudget?)` (`lib/chime/send.ts`) | Cuts on encoded length at the largest prefix that fits, on a paragraph, sentence or word boundary, never ending a part on a heading and never inside a surrogate pair (chunk[0] may take a smaller budget, as the answer path's marker-reserved one). Trims only whitespace, so every chunk stays within budget. |
| Attach a long deliverable instead of walling the channel | `buildAttachmentLede(response)` | The full text rides as an S3 attachment; the inline message is a short (~400-char) lede (the model's opening summary). Use for reports/long-form, not chat turns. |
| Put structured info on a message | `safeMetadataString(metadata)` | Over 1024 encoded chars it SHEDS low-priority keys first, in a fixed order (`METADATA_SHED_ORDER`: step-latency diagnostics, then config attribution and fallback detail, then bulky UI fields), and drops the blob entirely only if it still does not fit. Either way it warns and never fails the post - deliberate "honest degradation". Keys not in the shed order are the must-survive core, including the experiment join. |

## Rules

- **Never put large or variable-length text in `Metadata`.** It is a 1024 *encoded* budget and `safeMetadataString` sheds, and can still drop, what is over it, so the content would vanish (worse for Chinese, ~110 chars). Metadata is for **small structured tags only**: `responseGroup`, `part`, `totalParts`, `continuation`, ids, a language code. If a feature needs to carry text, it goes in **Content** (through `handleLongResponse`) or an **attachment** - never Metadata.
- **Analytics decoupling (Aurora mode).** The heavy per-message analytics fields (tokens, latencies, config fingerprint, intent confidence, fallback detail) do not ride Amazon Chime SDK `Metadata`. The async processor writes the full record to a dedicated `MessageAnalyticsTable` keyed by message id (`backend/lambda/src/lib/message-analytics.ts`), the Aurora archival pipeline reads it from there, and `Metadata` carries just the frontend-rendered fields (`pickFrontendMetadata`). So an over-budget turn does not drop analytics or the experiment join. In Athena mode there is no such table: the Metadata stays full and relies on the shedding backstop, and a shed field never reaches the archive. The archive is the system of record for telemetry ([TENETS](../../overview/TENETS.md), tenet D7), so in Athena mode a shed turn's archived row lacks its step latencies, config attribution and fallback detail, and nothing else holds them. Full design: `docs/specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md`.
- **Always route long output through `handleLongResponse` or `sendInParts`.** Do not call `SendChannelMessage` with Content whose encoded length was not measured, and do not cut a message to fit one send.
- **Link multi-part output with `responseGroup`** so the surface can regroup it. Continuation chunks already carry `{ responseGroup, part, totalParts }`.
- **Markers live in Content chunk[0]**, not Metadata (`<!--ACTIVE_TASK:-->`, `<!--corr:-->`, `<!--battlestats:-->`), and the surface strips them before display (`frontend/packages/shared/src/utils/messageParser.ts` in the SPA). Reserve headroom for them (`CHUNK0_MARKER_HEADROOM`) if you add to chunk[0].
- **Re-budget for the user's language.** A budget that is fine for English can overflow in Chinese by ~4.5x. Test the size path with CJK input.

## Surface contract

The producing side guarantees each message is within the encoded caps and tags multi-part output with `responseGroup`. The consuming side is responsible for: stripping `<!--...-->` markers, unwrapping the Lex `{"Messages":[...]}` envelope, the placeholder->final UPDATE in place, and regrouping `responseGroup` continuation parts. In the SPA the first two are `frontend/packages/shared/src/utils/messageParser.ts`; `responseGroup` is read off the metadata in `chimeService.ts` and `MessagingProvider.tsx`, kept across an UPDATE in `ConversationProvider.chime.tsx`, and regrouped in `ConversationInterface.tsx` (consecutive parts of one group render under one header). A new surface that renders channel messages must honor all four or it will show raw markers, JSON envelopes, or split walls. The embeddable widget (`frontend/packages/widget`) strips the markers with the same shared parser, unwraps the envelope with its own structural check (`unwrapLexStructural` in `frontend/packages/widget/src/messaging/messageFormat.ts`), and upserts an UPDATE in place; it does not regroup `responseGroup` parts (**NOT BUILT** in the widget).

**Rendering.** In the SPA, assistant replies render as **GFM Markdown** (`react-markdown` + `remark-gfm`, in `frontend/packages/chat/src/components/CollapsibleText.tsx`): headings, lists, tables, fenced/inline code, and links. Raw HTML is escaped/ignored by default, so rendering is XSS-safe without a separate sanitizer. User messages stay plain text. A new surface should render assistant output as Markdown (and keep raw HTML off) for parity; a plain-text surface will show `**`, `#`, and pipes literally.

## Extending output

Adding a second language, citations, or any per-message extra text is a **size** change first and a feature second. Decide up front:
1. Does it inflate `Content`? -> it must go through `handleLongResponse`.
2. Is it small + structured (a tag, an id, a lang code)? -> `Metadata` via `safeMetadataString` is fine.
3. Is it large + must survive? -> Content or attachment, **never** Metadata.
4. Did you re-budget for CJK?

See `docs/specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md` for a worked design (it sends a second language as a linked sibling message via `responseGroup`, with only small tags in Metadata, precisely because of the limits above). Only the reply language is built there; dual delivery is **NOT BUILT**.

## Related

- `docs/specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md` - how to keep `Metadata` under the 1024 cap durably: coded (integer) values for bounded state fields + heavy analytics moved out of band, keyed by message id. OSS-replicable for your own intents/states.
- `docs/overview/ARCHITECTURE.md` / `backend/ARCHITECTURE.md` - the Lex->Lambda->Amazon Chime SDK message flow and the direct-send pattern these helpers implement.
- `docs/specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md` - the shared async processor that calls `handleLongResponse` on every reply.
- `docs/specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md` - a worked design for extending output (a second language as a linked sibling message; dual delivery is **NOT BUILT**).
