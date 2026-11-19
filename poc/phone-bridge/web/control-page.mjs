/**
 * The local control page: start a meeting and join it with this computer's microphone, see the dial-in
 * number, call a phone out, and watch each phone leg's timings. Served on 127.0.0.1 only.
 */
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';

const $ = (id) => document.getElementById(id);
let av = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Poc': '1' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

function show(err) { $('error').textContent = err ? String(err.message || err) : ''; }

async function join({ meeting, attendee }) {
  const logger = new ConsoleLogger('control', LogLevel.WARN);
  const session = new DefaultMeetingSession(new MeetingSessionConfiguration(meeting, attendee), logger, new DefaultDeviceController(logger));
  av = session.audioVideo;
  const mics = await av.listAudioInputDevices();
  await av.startAudioInput(mics.length ? mics[0].deviceId : null);
  await av.bindAudioElement($('meeting-audio'));
  av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present, externalUserId) => {
    const id = `att-${attendeeId}`;
    const existing = document.getElementById(id);
    if (!present) { existing?.remove(); return; }
    if (existing) return;
    const li = document.createElement('li');
    li.id = id;
    li.textContent = externalUserId || attendeeId;
    $('roster').appendChild(li);
  });
  av.start();
}

async function leave() {
  if (av) { av.stop(); av = null; }
  $('roster').innerHTML = '';
}

$('start').onclick = async () => {
  show();
  try { await join(await api('/api/meeting/start')); } catch (e) { show(e); }
};
$('end').onclick = async () => {
  show();
  try { await leave(); await api('/api/meeting/end'); } catch (e) { show(e); }
};
$('dial').onclick = async () => {
  show();
  try { await api('/api/dial', { to: $('number').value.trim() }); } catch (e) { show(e); }
};

function renderLegs(legs) {
  const body = $('legs');
  body.innerHTML = '';
  for (const leg of legs) {
    const tr = document.createElement('tr');
    const t = leg.timings;
    const cells = [
      leg.direction === 'in' ? 'Dial-in' : 'Dial-out',
      leg.number,
      leg.status,
      t.attendeeJoinedMs != null ? `${t.attendeeJoinedMs} ms` : '',
      t.streamStartMs != null ? `${t.streamStartMs} ms` : '',
      t.droppedMs ? `${t.droppedMs} ms` : '0',
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    const td = document.createElement('td');
    if (leg.status !== 'ended') {
      const b = document.createElement('button');
      b.textContent = 'Hang up';
      b.onclick = () => api('/api/hangup', { legId: leg.legId }).catch(show);
      td.appendChild(b);
    }
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

const events = new EventSource('/api/events');
events.onmessage = (e) => {
  const s = JSON.parse(e.data);
  $('dial-in').textContent = s.dialInNumber || '';
  $('status').textContent = s.meetingId ? `Running (${s.meetingId})` : 'No meeting';
  $('public-url').textContent = s.publicUrl || 'starting tunnel...';
  $('start').disabled = Boolean(s.meetingId) && Boolean(av);
  $('end').disabled = !s.meetingId;
  $('dial').disabled = !s.meetingId;
  renderLegs(s.legs);
};
