/**
 * PHONE BRIDGE POC: Twilio phone legs into an Amazon Chime SDK WebRTC meeting, with no Amazon Chime SDK
 * PSTN Audio (SPEC-TELEPHONY FR10, SPEC-ASSISTANT-MEETINGS FR13a).
 *
 * Two servers, deliberately apart:
 *   - PUBLIC (tunneled to Twilio): POST /twilio/voice, POST /twilio/status, WS /twilio/media. Every
 *     webhook is checked against Twilio's signature; a media stream must present the per-leg token the
 *     signed webhook handed out.
 *   - LOCAL (127.0.0.1, never tunneled): the control page, its API and the bridge pages' audio sockets.
 *     The API requires an `X-Poc` header and a loopback Host, so another site open in the browser cannot
 *     place calls through it.
 *
 * A phone leg is one headless Chrome page that joins the meeting as its own attendee. The leg starts
 * joining as soon as the call is received or placed, in parallel with Twilio's greeting or the callee's
 * ringing, so the join time is hidden where it can be.
 */
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import puppeteer from 'puppeteer-core';
import twilio from 'twilio';
import { loadConfig, maskNumber, maskNumbersIn } from './config.mjs';
import { endIfNoStream, joinLegResources, parseTwilioFrame, placeCallForLeg, recordDroppedAudio } from './legs.mjs';
import { loadTwilioCredentials, twilioClient, pointNumberAt, restoreNumber } from './twilio-account.mjs';
import { startTunnel } from './tunnel.mjs';
import { meetingsApi } from './meeting.mjs';
import { mulawToPcm, pcmToMulaw } from './g711.mjs';

const cfg = await loadConfig();
const creds = await loadTwilioCredentials(cfg);
const tw = twilioClient(creds);
const chime = meetingsApi(cfg.region);
const DIST = new URL('../dist/', import.meta.url);

let publicUrl = '';
/** The one meeting this POC runs: dial-in always joins it. */
let meeting = null;
const legs = new Map();
const sseClients = new Set();

/** Every line is masked, so a number an error message carries is never logged in full. */
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a.map((x) => (typeof x === 'string' ? maskNumbersIn(x) : x)));
/** How long an answered inbound call has to open its audio stream before the leg is ended. */
const INBOUND_STREAM_MS = 20_000;
const since = (leg) => Date.now() - leg.t0;

function snapshot() {
  return {
    publicUrl,
    dialInNumber: cfg.twilioNumber,
    meetingId: meeting?.MeetingId ?? null,
    legs: [...legs.values()].map((l) => ({
      legId: l.legId, direction: l.direction, number: maskNumber(l.number), status: l.status, timings: l.timings,
    })),
  };
}
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function streamTwiml(leg, greeting) {
  const vr = new twilio.twiml.VoiceResponse();
  if (greeting) vr.say(greeting);
  const stream = vr.connect().stream({ url: `${publicUrl.replace(/^https/, 'wss')}/twilio/media` });
  stream.parameter({ name: 'leg', value: leg.legId });
  stream.parameter({ name: 'token', value: leg.token });
  return vr.toString();
}

function newLeg(direction, number, callSid) {
  const leg = {
    legId: randomUUID(), direction, number, callSid, status: 'connecting',
    token: randomBytes(24).toString('hex'), audioKey: randomBytes(24).toString('hex'),
    t0: Date.now(), timings: {}, twilioWs: null, pageWs: null, streamSid: null, page: null, attendee: null,
  };
  legs.set(leg.legId, leg);
  return leg;
}

// ── Joining a leg to the meeting ──────────────────────────────────────────────────────────────────────

let browserPromise = null;
function browser() {
  browserPromise ??= puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
  return browserPromise;
}

async function joinLeg(leg) {
  try {
    const meetingId = meeting.MeetingId;
    const joined = await joinLegResources(leg, {
      createAttendee: () => chime.createAttendee(meetingId, `phone-${leg.direction}-${leg.number.slice(-4)}-${leg.legId.slice(0, 8)}`),
      deleteAttendee: (a) => chime.deleteAttendee(meetingId, a.AttendeeId),
      openPage: async () => (await browser()).newPage(),
      closePage: (p) => p.close(),
    });
    if (!joined) return;
    const page = leg.page;
    page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'error') log(`[leg ${leg.legId.slice(0, 8)}]`, m.text()); });
    page.on('pageerror', (e) => log(`[leg ${leg.legId.slice(0, 8)}] page error`, e.message));
    // The page reports the late caller audio its player dropped, which the control page shows on the leg.
    await page.exposeFunction('reportDroppedMs', (ms) => { if (recordDroppedAudio(leg, ms)) broadcast(); });
    await page.goto(`http://127.0.0.1:${cfg.localPort}/bridge.html`);
    await page.evaluate((args) => window.startBridge(args), {
      meeting: { Meeting: meeting },
      attendee: { Attendee: leg.attendee },
      audioWsUrl: `ws://127.0.0.1:${cfg.localPort}/audio?leg=${leg.legId}&key=${leg.audioKey}`,
    });
    leg.timings.attendeeJoinedMs = since(leg);
    if (leg.status === 'connecting') leg.status = leg.twilioWs ? 'live' : 'joined, waiting for the call';
    log(`[leg ${leg.legId.slice(0, 8)}] attendee joined at ${leg.timings.attendeeJoinedMs} ms`);
  } catch (e) {
    if (leg.status === 'ended') return;
    log(`[leg ${leg.legId.slice(0, 8)}] join failed:`, e.message);
    leg.status = 'join failed';
    await endLeg(leg, 'join failed');
  }
  broadcast();
}

async function endLeg(leg, why) {
  if (leg.status === 'ended') return;
  leg.status = 'ended';
  log(`[leg ${leg.legId.slice(0, 8)}] ended: ${why}`);
  if (leg.callSid) await tw.calls(leg.callSid).update({ status: 'completed' }).catch(() => {});
  try { leg.twilioWs?.close(); } catch { /* closed */ }
  try { leg.pageWs?.close(); } catch { /* closed */ }
  if (leg.page) {
    await leg.page.evaluate(() => window.stopBridge?.()).catch(() => {});
    await leg.page.close().catch(() => {});
  }
  if (leg.attendee && meeting) await chime.deleteAttendee(meeting.MeetingId, leg.attendee.AttendeeId).catch(() => {});
  leg.attendee = null;
  broadcast();
}

// ── Public server: Twilio only ────────────────────────────────────────────────────────────────────────

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function signedParams(req, path, body) {
  const params = Object.fromEntries(new URLSearchParams(body));
  const ok = twilio.validateRequest(creds.authToken, req.headers['x-twilio-signature'] ?? '', `${publicUrl}${path}`, params);
  return ok ? params : null;
}

const publicServer = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method !== 'POST' || !['/twilio/voice', '/twilio/status'].includes(path)) { res.writeHead(404).end(); return; }
    const params = signedParams(req, path, await readBody(req));
    if (!params) { log('refused a webhook with a bad Twilio signature'); res.writeHead(403).end(); return; }

    if (path === '/twilio/status') {
      const leg = [...legs.values()].find((l) => l.callSid === params.CallSid);
      if (leg && ['busy', 'failed', 'no-answer', 'canceled', 'completed'].includes(params.CallStatus)) await endLeg(leg, `call ${params.CallStatus}`);
      else if (leg && params.CallStatus === 'ringing') { leg.timings.ringingMs = since(leg); broadcast(); }
      res.writeHead(204).end();
      return;
    }

    // An incoming call.
    if (!meeting) {
      const vr = new twilio.twiml.VoiceResponse();
      vr.say('No meeting is running right now. Goodbye.');
      vr.hangup();
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(vr.toString());
      return;
    }
    const leg = newLeg('in', params.From ?? '', params.CallSid);
    log(`[leg ${leg.legId.slice(0, 8)}] incoming call from ${maskNumber(leg.number)}`);
    joinLeg(leg);
    endIfNoStream(leg, INBOUND_STREAM_MS, (why) => endLeg(leg, why));
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(streamTwiml(leg, 'Joining the meeting.'));
    broadcast();
  } catch (e) {
    log('public request failed:', e.message);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const twilioWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
publicServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/twilio/media') { socket.destroy(); return; }
  twilioWss.handleUpgrade(req, socket, head, (ws) => onTwilioStream(ws));
});

function onTwilioStream(ws) {
  let leg = null;
  // A stream that has not proved itself within 10 s is not Twilio.
  const deadline = setTimeout(() => { if (!leg) ws.close(); }, 10_000);
  // A socket error (an oversized frame, a reset) closes this stream only; the 'close' handler ends its leg.
  ws.on('error', (e) => log('Twilio media socket error:', e.message));
  ws.on('message', (raw) => {
    const msg = parseTwilioFrame(raw);
    if (!msg) return;
    if (msg.event === 'start') {
      const p = msg.start?.customParameters ?? {};
      const candidate = legs.get(p.leg);
      if (!candidate || candidate.status === 'ended' || !safeEqual(p.token ?? '', candidate.token)) { ws.close(); return; }
      clearTimeout(deadline);
      leg = candidate;
      leg.twilioWs = ws;
      leg.streamSid = msg.start.streamSid;
      leg.timings.streamStartMs = since(leg);
      if (leg.timings.attendeeJoinedMs != null) leg.status = 'live';
      log(`[leg ${leg.legId.slice(0, 8)}] Twilio stream started at ${leg.timings.streamStartMs} ms`);
      broadcast();
    } else if (msg.event === 'media' && leg && msg.media?.track !== 'outbound' && typeof msg.media?.payload === 'string') {
      if (leg.pageWs?.readyState === WebSocket.OPEN) {
        const pcm = mulawToPcm(Buffer.from(msg.media.payload, 'base64'));
        leg.pageWs.send(pcm.buffer);
      }
    } else if (msg.event === 'stop' && leg) {
      endLeg(leg, 'Twilio stream stopped');
    }
  });
  ws.on('close', () => { clearTimeout(deadline); if (leg) endLeg(leg, 'Twilio stream closed'); });
}

// ── Local server: control page, its API, and the bridge pages' audio ─────────────────────────────────

function isLoopbackHost(req) {
  const host = (req.headers.host ?? '').toLowerCase();
  return host === `127.0.0.1:${cfg.localPort}` || host === `localhost:${cfg.localPort}`;
}

async function sendFile(res, name, type) {
  try { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(await readFile(new URL(name, DIST))); }
  catch { res.writeHead(404).end('run npm run build'); }
}

const BRIDGE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bridge</title></head><body><script src="/bridge.js"></script></body></html>';

const localServer = http.createServer(async (req, res) => {
  if (!isLoopbackHost(req)) { res.writeHead(403).end(); return; }
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET') {
      if (path === '/') return sendFile(res, 'control.html', 'text/html; charset=utf-8');
      if (path === '/control.js') return sendFile(res, 'control.js', 'text/javascript');
      if (path === '/bridge.js') return sendFile(res, 'bridge.js', 'text/javascript');
      if (path === '/bridge.html') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(BRIDGE_HTML); return; }
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST' || req.headers['x-poc'] !== '1') { res.writeHead(403).end(); return; }
    const body = JSON.parse((await readBody(req)) || '{}');
    const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

    if (path === '/api/meeting/start') {
      meeting ??= await chime.createMeeting();
      log(`meeting ${meeting.MeetingId} running`);
      const attendee = await chime.createAttendee(meeting.MeetingId, `host-${randomUUID().slice(0, 8)}`);
      broadcast();
      return json(200, { meeting: { Meeting: meeting }, attendee: { Attendee: attendee } });
    }
    if (path === '/api/meeting/end') {
      if (meeting) {
        await Promise.all([...legs.values()].map((l) => endLeg(l, 'meeting ended')));
        await chime.deleteMeeting(meeting.MeetingId);
        log(`meeting ${meeting.MeetingId} ended`);
        meeting = null;
        legs.clear();
      }
      broadcast();
      return json(200, {});
    }
    if (path === '/api/dial') {
      if (!meeting) return json(409, { error: 'Start a meeting first.' });
      const to = String(body.to ?? '');
      if (!/^\+[1-9]\d{6,14}$/.test(to)) return json(400, { error: 'Enter the number in E.164 form, like +15555550100.' });
      if (!publicUrl) return json(409, { error: 'The tunnel is not up yet.' });
      const leg = newLeg('out', to, null);
      joinLeg(leg);
      try {
        const call = await placeCallForLeg(leg, () => tw.calls.create({
          to, from: cfg.twilioNumber,
          twiml: streamTwiml(leg, null),
          statusCallback: `${publicUrl}/twilio/status`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['ringing', 'answered', 'completed'],
        }), (sid) => tw.calls(sid).update({ status: 'completed' }));
        if (!call) return json(409, { error: 'The leg ended before the call was placed.' });
      } catch (e) {
        const refusal = `Twilio refused the call: ${maskNumbersIn(e.message)}`;
        await endLeg(leg, refusal);
        return json(502, { error: refusal });
      }
      log(`[leg ${leg.legId.slice(0, 8)}] calling ${maskNumber(to)}`);
      broadcast();
      return json(200, { legId: leg.legId });
    }
    if (path === '/api/hangup') {
      const leg = legs.get(body.legId);
      if (leg) await endLeg(leg, 'hung up from the control page');
      return json(200, {});
    }
    res.writeHead(404).end();
  } catch (e) {
    log('local request failed:', e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: maskNumbersIn(e.message) }));
  }
});

const audioWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
localServer.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const leg = legs.get(u.searchParams.get('leg') ?? '');
  if (!isLoopbackHost(req) || u.pathname !== '/audio' || !leg || !safeEqual(u.searchParams.get('key') ?? '', leg.audioKey)) { socket.destroy(); return; }
  audioWss.handleUpgrade(req, socket, head, (ws) => {
    leg.pageWs = ws;
    ws.on('error', (e) => log(`[leg ${leg.legId.slice(0, 8)}] audio socket error:`, e.message));
    ws.on('message', (data, isBinary) => {
      if (!isBinary || !leg.twilioWs || leg.twilioWs.readyState !== WebSocket.OPEN || !leg.streamSid) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Copied, because a Buffer's byteOffset need not be even and an Int16Array view requires it.
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
      leg.twilioWs.send(JSON.stringify({ event: 'media', streamSid: leg.streamSid, media: { payload: pcmToMulaw(pcm).toString('base64') } }));
    });
  });
});

// ── Start and stop ────────────────────────────────────────────────────────────────────────────────────

await new Promise((r) => localServer.listen(cfg.localPort, '127.0.0.1', r));
await new Promise((r) => publicServer.listen(cfg.publicPort, '127.0.0.1', r));
browser().catch((e) => log('Chrome did not start:', e.message));
log(`control page: http://127.0.0.1:${cfg.localPort}/`);

const tunnel = await startTunnel(cfg.cloudflaredPath, cfg.publicPort);
publicUrl = tunnel.url;
await pointNumberAt(tw, cfg.twilioNumber, `${publicUrl}/twilio/voice`, `${publicUrl}/twilio/status`);
log(`tunnel up; ${maskNumber(cfg.twilioNumber)} now rings the bridge`);
broadcast();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping: hanging up, ending the meeting, restoring the number');
  await Promise.all([...legs.values()].map((l) => endLeg(l, 'bridge stopping')));
  if (meeting) await chime.deleteMeeting(meeting.MeetingId);
  await restoreNumber(tw).then((ok) => ok && log('number restored')).catch((e) => log('RESTORE FAILED, run npm run restore:', e.message));
  tunnel.proc.kill();
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
