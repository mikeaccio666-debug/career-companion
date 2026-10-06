import { browser } from 'wxt/browser';
import { INTAKE_RECORDER_PORT, parseIntakeRecorderCommand, type IntakeClientCode, type IntakeRecorderMessage } from '@edaix/contracts';
import { encodeIntakePcm } from '../../assistant/features/intake/audio';
import workletUrl from './pcm-worklet.js?url&no-inline';
import './style.css';
const port = browser.runtime.connect({ name: INTAKE_RECORDER_PORT });
const status = document.getElementById('status')!;
const chinese = new URL(location.href).searchParams.get('locale') === 'zh-CN';
if (chinese) { document.documentElement.lang = 'zh-CN'; document.querySelector('h1')!.textContent = 'ArgoLand.AI · 语音输入'; document.getElementById('hint')!.textContent = '说话时请保持此页打开。转写内容会出现在 Assistant 输入框中，供你修改后发送。'; document.getElementById('stop')!.textContent = '结束录音'; document.getElementById('cancel')!.textContent = '取消'; }
let stream: MediaStream | null = null, context: AudioContext | null = null, node: AudioWorkletNode | null = null;
let stopped = false, started = false, received = 0, index = 0, used = 0, limit = 0, buffer = new Float32Array(0), timer: ReturnType<typeof setTimeout> | undefined;
const pending = new Set<number>();
function send(message: IntakeRecorderMessage) { try { port.postMessage(message); } catch { release(); status.textContent = chinese ? '录音暂时不可用，请关闭此页后重试。' : 'Recording is unavailable. Close this page and try again.'; } }
function release() { stopped = true; clearTimeout(timer); node?.disconnect(); node = null; stream?.getTracks().forEach(track => track.stop()); stream = null;
  if (context) void context.close().catch(() => { status.textContent = chinese ? '录音暂时不可用，请关闭此页后重试。' : 'Recording is unavailable. Close this page and try again.'; }); context = null; }
function fail(code: IntakeClientCode) { release(); buffer = new Float32Array(0); send({ kind: 'ERROR', code }); status.textContent = code === 'CANCELLED' ? (chinese ? '录音已取消，可以关闭此页。' : 'Recording cancelled. You can close this page.') : code === 'LIMIT_REACHED' ? (chinese ? '已达到录音上限，请返回 Assistant 查看转写。' : 'Recording limit reached. Return to the Assistant to review the transcript.') : (chinese ? '录音未能完成，请返回 Assistant 重试。' : 'Recording could not finish. Return to the Assistant and try again.'); }
function flush() {
  if (!used) return;
  if (pending.size >= 3) { fail('LIMIT_REACHED'); return; }
  const samples = buffer.slice(0, used); used = 0;
  // Silence is omitted locally. The API independently verifies samples and duration.
  if (!samples.some(n => Math.abs(n) >= 16 / 32768)) return;
  const bytes = encodeIntakePcm(samples); let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  pending.add(index); send({ kind: 'CHUNK', index: index++, base64: btoa(binary) });
}
function finish() { if (stopped) return; flush(); release(); buffer = new Float32Array(0); send({ kind: 'STOPPED' }); status.textContent = chinese ? '正在完成转写…' : 'Finishing transcription…'; }
async function start(maximumSeconds: number, chunkSeconds: number) {
  if (started || stopped) { fail('VALIDATION_FAILED'); return; } started = true; limit = maximumSeconds * 16000; buffer = new Float32Array(chunkSeconds * 16000);
  try {
    status.textContent = chinese ? '请在浏览器中允许麦克风权限。' : 'Allow microphone access in your browser.';
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true }, video: false });
    if (stopped) { acquired.getTracks().forEach(t => t.stop()); return; } stream = acquired;
    context = new AudioContext({ sampleRate: 16000 });
    if (context.sampleRate !== 16000) { fail('AUDIO_INVALID'); return; }
    await context.audioWorklet.addModule(workletUrl); if (stopped || !context) return;
    node = new AudioWorkletNode(context, 'intake-pcm');
    node.port.onmessage = event => {
      if (stopped || !(event.data instanceof Float32Array)) return;
      for (const sample of event.data) {
        if (stopped) break;
        if (received >= limit) { finish(); break; }
        buffer[used++] = sample; received++;
        if (used === buffer.length) flush();
      }
    };
    const mute = context.createGain(); mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node).connect(mute).connect(context.destination); await context.resume();
    status.textContent = chinese ? '正在录音…' : 'Recording…';
    timer = setTimeout(finish, maximumSeconds * 1000);
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', finish, { once: true }));
  } catch (error) { fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'VOICE_DENIED' : error instanceof DOMException && error.name === 'NotFoundError' ? 'VOICE_NO_DEVICE' : 'UNAVAILABLE'); }
}
port.onMessage.addListener(raw => {
  const command = parseIntakeRecorderCommand(raw); if (!command) { fail('RESPONSE_MALFORMED'); return; }
  if (command.kind === 'START') void start(command.maximumSeconds, command.chunkSeconds);
  else if (command.kind === 'ACK') pending.delete(command.index);
  else if (command.kind === 'STOP') finish();
  else { release(); buffer = new Float32Array(0); status.textContent = chinese ? '录音已结束，可以关闭此页。' : 'Recording ended. You can close this page.'; }
});
port.onDisconnect.addListener(() => { release(); buffer = new Float32Array(0); status.textContent = chinese ? '录音暂时不可用，请关闭此页后重试。' : 'Recording is unavailable. Close this page and try again.'; });
document.getElementById('stop')!.addEventListener('click', finish);
document.getElementById('cancel')!.addEventListener('click', () => fail('CANCELLED'));
addEventListener('pagehide', () => { release(); port.disconnect(); });
send({ kind: 'READY' });
