const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
// Bundled from the TypeScript source (the stack builds this function with esbuild): who the caller is
// comes from the one resolver every handler uses.
const { callerPersonId } = require('../src/lib/auth');
const { callerReachesConversation, conversationChannelArn, refusalAnswer } = require('../src/lib/conversation-access');
const { typeAllows, capabilityRefusal } = require('../src/lib/type-capability');
const { parseTranscriptKey } = require('../src/lib/meeting-transcript');
const { parseRecordingKey } = require('../src/lib/meeting-recording');
const { readChannelContext } = require('../src/lib/channel-context-client');
const { hostedMeetingLive } = require('../src/lib/meeting-host');
const { userArnFor } = require('../src/lib/person-arn');
const { chimeMessagingClient } = require('../src/lib/chime/clients');
const { loadProfileRegistry } = require('../../lib/profile-registry');

/**
 * The caller's own boundary in front of the signature: a member of the conversation, cleared for it. `keyClassification`,
 * for a key that names one, must be the conversation's own.
 */
async function refusedConversation(event, conversationId, origin, keyClassification) {
  const access = await callerReachesConversation(event, conversationId);
  if (access.ok && keyClassification !== undefined && access.classification !== keyClassification) {
    return respond(403, { error: 'This file is not of this conversation', code: 'FILE_KEY_NOT_OWNED' }, origin);
  }
  if (access.ok) return null;
  const { statusCode, body } = refusalAnswer(access);
  return respond(statusCode, body, origin);
}
const { responder, originsFrom, DEV_ORIGIN } = require('../src/lib/http-response');

const s3Client = new S3Client({});
/** The messaging client a host check asks a moderation of, created on first use. */
let messaging;
const moderatorReader = () => (messaging = messaging || chimeMessagingClient({}));
const BUCKET_NAME = process.env.BUCKET_NAME;
const EXPIRATION_SECONDS = parseInt(process.env.EXPIRATION_SECONDS || '300');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

// Tighten everything user-controlled. The Lambda must not trust body-supplied
// userId, conversationId, fileName (path traversal), or fileType (no MIME
// allow-list) without
// a size cap on the presigned PUT.
// 10 MiB; matches the frontend cap in frontend/packages/chat/src/services/attachmentService.ts.
//
// DELIBERATELY HIGHER THAN WHAT A MODEL CAN READ. The per-attachment
// budget for Amazon Bedrock is 3,750,000 raw bytes (5 MB base64), stated once in
// backend/lambda/src/lib/attachment-budget.ts. This cap is NOT lowered to match it, because an
// attachment has uses beyond being read by a model: a 6 MB PDF is still stored, still downloadable by
// every member, and still the thing the conversation is about. The turn degrades at SEND time instead -
// the assistant answers without the file and says so, in configured copy - so the person is told at the
// point the difference bites. Lowering this cap would mean moving the frontend cap and the upload-time
// copy with it, in one change.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Allow-list keyed to what the frontend can actually upload. Matches the
// list in frontend/src/services/attachmentService.ts ALLOWED_TYPES.
const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',
  'application/json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// Reject filenames with path separators / null bytes / control chars /
// parent-dir traversal segments. Keys are server-composed (timestamp +
// fileName) but a hostile fileName like `../../other-conv/x` collides
// into a peer prefix even though S3 doesn't normalise.
const UNSAFE_FILENAME_RE = /[\x00-\x1f\\/]|^\.\.?$|^\.\.[\\/]/;

/**
 * The name a downloaded file is saved under: a meeting's transcript or recording by its meeting id, any other file by the last
 * segment of its key. Only characters a header carries safely; nothing a person wrote decides it.
 */
function downloadNameOf(fileKey, meetingArtifact) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (meetingArtifact) {
    const ext = fileKey.endsWith('.mp4') ? 'mp4' : 'md';
    const part = meetingArtifact.partId ? `-${safe(meetingArtifact.partId)}` : '';
    return `meeting-${safe(meetingArtifact.meetingId)}${part}-${ext === 'md' ? 'transcript' : 'recording'}.${ext}`;
  }
  return safe(fileKey.split('/').pop() || 'download');
}

const http = responder({ origin: { allow: originsFrom(ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'POST,OPTIONS' });
const respond = http.respond;

/**
 * Lambda handler for generating presigned URLs for S3 upload/download.
 * Cognito-authed at the API Gateway (s3-storage-stack.ts) AND now
 * Lambda-side identity-binds + validates inputs (H5).
 */
exports.handler = async (event) => {
  console.log('PresignedUrl:', event.httpMethod, event.path);
  // The deployment's classifications, read at runtime from the rows its stacks publish (cached): the
  // conversation check below reads clearance from them, and an unloaded registry refuses to be read.
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;

  try {
    // Caller identity must come from the verified token, resolved to the person
    // (`callerPersonId`), not the request body. If userId were body-supplied, an
    // authed user A could write attachments under user B's storage prefix.
    const callerSub = await callerPersonId(event);
    if (!callerSub) {
      return respond(401, { error: 'Unauthorized' }, origin);
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON body' }, origin);
    }

    const { action, fileName, fileType, conversationId, fileKey } = body;

    if (!action) {
      return respond(400, { error: 'action is required ("upload" or "download")' }, origin);
    }

    if (action === 'upload') {
      // ---------- Upload path ----------
      if (!fileName || !conversationId) {
        return respond(400, { error: 'fileName and conversationId are required for upload' }, origin);
      }

      if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) {
        return respond(400, { error: 'fileName must be a non-empty string ≤ 255 chars' }, origin);
      }

      if (UNSAFE_FILENAME_RE.test(fileName)) {
        return respond(400, {
          error: 'fileName contains path separators or control characters',
          code: 'UNSAFE_FILENAME',
        }, origin);
      }

      if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
        return respond(400, {
          error: 'conversationId must match [a-zA-Z0-9_-]{1,128}',
          code: 'INVALID_CONVERSATION_ID',
        }, origin);
      }

      // MIME allow-list. Default 'application/octet-stream' is NOT
      // allowed here — must be one of the explicit types — because the
      // client always sends a concrete type and any "fallback" implies
      // an attempt to bypass.
      const ct = typeof fileType === 'string' ? fileType : '';
      if (!ALLOWED_MIME_TYPES.has(ct)) {
        return respond(400, {
          error: `fileType not allowed (got ${ct || 'none'})`,
          code: 'UNSUPPORTED_MIME',
        }, origin);
      }

      const uploadRefused = await refusedConversation(event, conversationId, origin);
      if (uploadRefused) return uploadRefused;
      // A TYPE THAT TURNS ATTACHMENTS OFF IS REFUSED HERE (`lib/type-capability.ts`): a customer's room declares them off.
      const uploadChannel = conversationChannelArn(conversationId, process.env.APP_INSTANCE_ARN || '');
      const allowed = uploadChannel ? await typeAllows(uploadChannel, 'attachments') : null;
      if (!allowed || !allowed.ok) {
        return respond(allowed ? allowed.statusCode : 400, allowed ? capabilityRefusal(allowed) : { error: 'conversationId names no conversation of this instance', code: 'INVALID_CONVERSATION_ID' }, origin);
      }

      // Server-composed key — userId is the caller's person id, NOT the
      // body. Timestamp + sanitised fileName tail.
      const key = `attachments/${conversationId}/${callerSub}/${Date.now()}-${fileName}`;

      // PRESIGNED POST, not a presigned PUT, and the difference is the size cap actually working.
      // The previous shape signed ContentLength: MAX_FILE_BYTES on a PutObjectCommand believing it
      // capped the upload - but a signed content-length is an EXACT pin, not a maximum, so every
      // real upload (whose length is never exactly 10 MiB) failed SignatureDoesNotMatch and user
      // uploads were broken wholesale (measured live; found by the 1:1 @all attachment e2e).
      // POST policies are the S3 mechanism built for browser uploads: content-length-range is a
      // true range condition, and the type/encryption/metadata pins move into policy conditions.
      const fields = {
        'Content-Type': ct,
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-meta-conversationid': conversationId,
        'x-amz-meta-userid': callerSub,
        'x-amz-meta-uploadedat': new Date().toISOString(),
      };
      const { url: uploadUrl, fields: signedFields } = await createPresignedPost(s3Client, {
        Bucket: BUCKET_NAME,
        Key: key,
        Conditions: [
          ['content-length-range', 1, MAX_FILE_BYTES],
          ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
        ],
        Fields: fields,
        Expires: EXPIRATION_SECONDS,
      });

      return respond(200, {
        uploadUrl,
        // The client posts these verbatim as form fields ahead of the file part.
        fields: signedFields,
        fileKey: key,
        expiresIn: EXPIRATION_SECONDS,
        maxBytes: MAX_FILE_BYTES,
      }, origin);
    }

    if (action === 'download') {
      // ---------- Download path ----------
      // Caller must reference a previously-issued fileKey (the upload
      // response surfaces this). Verify the key is under the caller's
      // own storage prefix — otherwise an authed user A could enumerate
      // user B's attachments by guessing timestamps.
      if (typeof fileKey !== 'string' || fileKey.length === 0 || fileKey.length > 1024) {
        return respond(400, {
          error: 'fileKey is required for download',
          code: 'MISSING_FILE_KEY',
        }, origin);
      }
      // Three download-able shapes, each scoped to the conversation the caller names, and each signed
      // only after the caller is proven a current member of that conversation and cleared for its
      // classification (`refusedConversation`, below):
      //  - attachments/<conversationId>/<callerSub>/...  a file the CALLER uploaded (per-person prefix);
      //  - generated-docs/<conversationId>/...           a document an assistant generated for the
      //    conversation (generateAndUploadDocument), which belongs to the conversation, not one uploader;
      //  - battle-images/<conversationId>/...            an image an assistant generated for the
      //    conversation (persistImageGenOutput), likewise the conversation's.
      // A removed member and a person whose clearance no longer reaches the conversation are refused
      // whatever key they hold.
      const ownUploadPrefix = `attachments/${conversationId}/${callerSub}/`;
      const generatedDocPrefix = `generated-docs/${conversationId}/`;
      const battleImagePrefix = `battle-images/${conversationId}/`;
      // A MEETING'S TRANSCRIPT (`transcripts/<classification>/<conversationId>/<meetingId>.md`, `meeting-transcript.ts`):
      // the conversation's, signed only for a member of that conversation and only where the key's classification is
      // the one the conversation carries, checked below once the conversation is read.
      const transcript = parseTranscriptKey(fileKey);
      // A MEETING'S AUDIO AND VIDEO RECORDING (`recordings/<classification>/<conversationId>/<meetingId>/<part>/media/
      // composited-video/<id>.mp4`, `meeting-recording.ts`): the conversation's, under the same rule as its transcript. Only the
      // finished file is signed; a capture chunk is never a recording.
      const recording = parseRecordingKey(fileKey);
      const meetingArtifact = transcript || recording;
      if (!conversationId || !(
        fileKey.startsWith(ownUploadPrefix)
        || fileKey.startsWith(generatedDocPrefix)
        || fileKey.startsWith(battleImagePrefix)
        || (meetingArtifact && meetingArtifact.conversationId === conversationId)
      )) {
        return respond(403, {
          error: 'fileKey must belong to the caller (own upload) or the named conversation (generated doc/image)',
          code: 'FILE_KEY_NOT_OWNED',
        }, origin);
      }

      if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
        return respond(400, { error: 'conversationId must match [a-zA-Z0-9_-]{1,128}', code: 'INVALID_CONVERSATION_ID' }, origin);
      }
      const downloadRefused = await refusedConversation(event, conversationId, origin, meetingArtifact ? meetingArtifact.classification : undefined);
      if (downloadRefused) return downloadRefused;
      // A MEETING'S TRANSCRIPT AND RECORDING ARE ITS HOSTS' (SPEC-ASSISTANT-MEETINGS FR28, FR70): signed only for a person the
      // meeting's own record on its conversation's row names a host, read as written; for a record that names no host, the
      // person who started it, else a moderator of the conversation it was started from, asked live as the caller
      // (`hostedMeetingLive`). A row that cannot be read signs nothing.
      if (meetingArtifact) {
        const meetingArn = conversationChannelArn(conversationId, process.env.APP_INSTANCE_ARN || '');
        let row;
        try {
          row = meetingArn ? await readChannelContext(meetingArn, { consistent: true }) : null;
        } catch {
          return respond(503, { error: 'The meeting could not be read just now', code: 'MEETING_UNREADABLE' }, origin);
        }
        const person = { personId: callerSub, personArn: userArnFor(process.env.APP_INSTANCE_ARN || '', callerSub) };
        if (!(await hostedMeetingLive(row, meetingArn, meetingArtifact.meetingId, person, moderatorReader()))) {
          return respond(403, { error: 'Only the meeting\'s hosts may open its transcript and recording', code: 'NOT_A_HOST' }, origin);
        }
      }

      // A DOWNLOAD SAVES THE FILE under a name of the platform's, where the reader asks for one; otherwise the browser shows it.
      const savedName = body.disposition === 'attachment' ? downloadNameOf(fileKey, meetingArtifact) : undefined;
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileKey,
        ...(savedName ? { ResponseContentDisposition: `attachment; filename="${savedName}"` } : {}),
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: EXPIRATION_SECONDS,
      });

      return respond(200, {
        downloadUrl: presignedUrl,
        fileKey,
        expiresIn: EXPIRATION_SECONDS,
      }, origin);
    }

    return respond(400, { error: 'Invalid action. Use "upload" or "download"' }, origin);
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    // Don't echo raw error.message to client.
    return respond(500, { error: 'Failed to generate presigned URL' }, origin);
  }
};
