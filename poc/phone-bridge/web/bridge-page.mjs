/**
 * The page headless Chrome opens for ONE phone leg. It joins the meeting as that leg's attendee and moves
 * audio both ways over a local WebSocket to the bridge server:
 *
 *   caller (8 kHz Int16 frames) -> pstn-player -> MediaStream -> the attendee's microphone
 *   the meeting's mixed audio  -> pstn-capture -> 8 kHz Int16 frames -> the caller
 *
 * The meeting's mix excludes this attendee's own audio, so the caller does not hear themselves.
 */
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
import { WORKLETS } from './worklets.mjs';

window.startBridge = async ({ meeting, attendee, audioWsUrl }) => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const url = URL.createObjectURL(new Blob([WORKLETS], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);

  const player = new AudioWorkletNode(ctx, 'pstn-player');
  const toMeeting = ctx.createMediaStreamDestination();
  player.connect(toMeeting);
  player.port.onmessage = (e) => {
    console.warn(`[bridge] dropped late caller audio, total ${e.data.droppedMs} ms`);
    window.reportDroppedMs?.(e.data.droppedMs);
  };

  const ws = new WebSocket(audioWsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => player.port.postMessage(e.data, [e.data]);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('audio socket failed')); });

  const logger = new ConsoleLogger('bridge', LogLevel.WARN);
  const session = new DefaultMeetingSession(
    new MeetingSessionConfiguration(meeting, attendee),
    logger,
    new DefaultDeviceController(logger),
  );
  const av = session.audioVideo;
  await av.startAudioInput(toMeeting.stream);

  // Remote WebRTC audio reaches Web Audio in Chrome only while it is attached to a media element.
  const el = document.createElement('audio');
  el.autoplay = true;
  document.body.appendChild(el);
  await av.bindAudioElement(el);

  const started = new Promise((resolve, reject) => {
    av.addObserver({
      audioVideoDidStart: () => resolve(),
      audioVideoDidStop: (status) => reject(new Error(`meeting session stopped: ${status.statusCode()}`)),
    });
  });
  av.start();
  await started;
  av.realtimeUnmuteLocalAudio();

  const mix = await av.getCurrentMeetingAudioStream();
  if (mix) {
    const capture = new AudioWorkletNode(ctx, 'pstn-capture');
    ctx.createMediaStreamSource(mix).connect(capture);
    // A worklet runs only while something downstream pulls it; a silent gain keeps it pulled.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    capture.connect(silent).connect(ctx.destination);
    capture.port.onmessage = (e) => { if (ws.readyState === WebSocket.OPEN) ws.send(e.data); };
  } else {
    console.warn('[bridge] no meeting audio stream; the caller will hear nothing');
  }
  await ctx.resume();

  window.stopBridge = () => { try { av.stop(); } catch { /* already stopped */ } ws.close(); return ctx.close(); };
  return { sampleRate: ctx.sampleRate };
};
