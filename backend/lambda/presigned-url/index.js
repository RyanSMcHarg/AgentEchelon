const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME;
const EXPIRATION_SECONDS = parseInt(process.env.EXPIRATION_SECONDS || '3600');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

// Tighten everything user-controlled. The Lambda must not trust body-supplied
// userId, conversationId, fileName (path traversal), or fileType (no MIME
// allow-list) without
// a size cap on the presigned PUT.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB; matches frontend cap

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

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGIN.split(',').includes(origin) ? origin : ALLOWED_ORIGIN.split(',')[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Vary': 'Origin',
  };
}

function respond(statusCode, body, origin) {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

/**
 * Lambda handler for generating presigned URLs for S3 upload/download.
 * Cognito-authed at the API Gateway (s3-storage-stack.ts) AND now
 * Lambda-side identity-binds + validates inputs (H5).
 */
exports.handler = async (event) => {
  console.log('PresignedUrl:', event.httpMethod, event.path);
  const origin = event.headers?.origin || event.headers?.Origin;

  try {
    // Caller identity must come from the JWT claims, not the request body. If
    // userId were body-supplied, an authed user A could write attachments under
    // user B's storage prefix.
    const claims = event.requestContext?.authorizer?.claims || {};
    const callerSub = claims.sub || claims['cognito:username'];
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

      // Server-composed key — userId is the caller's JWT sub, NOT the
      // body. Timestamp + sanitised fileName tail.
      const key = `attachments/${conversationId}/${callerSub}/${Date.now()}-${fileName}`;

      // ContentLength constrains the presigned PUT to a max byte cap.
      // The S3-request-presigner attaches this as a signed header; an
      // upload exceeding it gets a 400 from S3.
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: ct,
        ContentLength: MAX_FILE_BYTES,
        ServerSideEncryption: 'AES256',
        Metadata: {
          conversationId,
          userId: callerSub,
          uploadedAt: new Date().toISOString(),
        },
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: EXPIRATION_SECONDS,
        unhoistableHeaders: new Set(['content-length']),
      });

      return respond(200, {
        uploadUrl: presignedUrl,
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
      // Two download-able shapes, both scoped to the conversation the caller names:
      //  - attachments/<conversationId>/<callerSub>/...  a file the CALLER uploaded (per-user prefix);
      //  - generated-docs/<conversationId>/...           an assistant-GENERATED doc (report) for the
      //    channel (generateAndUploadDocument writes generated-docs/<channelId>/...). These have no
      //    user sub in the key (they belong to the conversation, not one uploader), so any member can
      //    download them. The channelId is an unguessable UUID a non-member never sees, so requiring an
      //    exact conversationId + fileKey match ties the download to the caller's own conversation.
      //    FOLLOW-UP (defense in depth): additionally verify Chime channel membership for the
      //    generated-docs path, so a former member who kept an old channelId cannot re-fetch.
      //  - battle-images/<conversationId>/...            an assistant-GENERATED image (image_generation
      //    intent / battle generation-out). Like generated docs it belongs to the conversation, not one
      //    uploader (persistImageGenOutput writes battle-images/<channelId>/..., and channelId is the
      //    conversation id), so any member downloads it; the unguessable conversationId + exact fileKey
      //    match ties the download to the caller's own conversation.
      const ownUploadPrefix = `attachments/${conversationId}/${callerSub}/`;
      const generatedDocPrefix = `generated-docs/${conversationId}/`;
      const battleImagePrefix = `battle-images/${conversationId}/`;
      if (!conversationId || !(
        fileKey.startsWith(ownUploadPrefix)
        || fileKey.startsWith(generatedDocPrefix)
        || fileKey.startsWith(battleImagePrefix)
      )) {
        return respond(403, {
          error: 'fileKey must belong to the caller (own upload) or the named conversation (generated doc/image)',
          code: 'FILE_KEY_NOT_OWNED',
        }, origin);
      }

      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileKey,
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
