// Session-only playback opt-in. Never serialize into patches, presets or imported state.
let enabled = false;
let timeout;
const contexts = new Set();
function lock() {
  enabled = false;
  button.textContent = "Enable playback for 15 minutes";
  document.querySelectorAll("audio,video").forEach(media => media.pause());
  contexts.forEach(context => { if(context.state !== "closed") void context.suspend(); });
}
document.addEventListener("play", event => {
  if(!enabled && event.target instanceof HTMLMediaElement) event.target.pause();
}, true);
const panel = document.createElement("aside");
panel.style.cssText = "position:fixed;top:16px;right:16px;max-width:340px;z-index:20000;background:#f7f8f5;color:#151716;padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid #ccd0c8;border-radius:8px";
const button = document.createElement("button");
button.textContent = "Enable playback for 15 minutes";
button.style.cssText = "background:#222;color:#fff;border:0;border-radius:5px;padding:9px 12px;font-weight:600;cursor:pointer";
const text = document.createElement("small");
text.textContent = "Spectral scope may be beyond 20 Hz–20 kHz or unknown. Browser/device resampling can alter output; playback does not verify physical ultrasonic emission. Reload locks playback.";
panel.append(button, text);
document.body.prepend(panel);
button.onclick = async () => {
  const response = await fetch("/playback-session", {method: enabled ? "DELETE" : "POST"});
  if (!response.ok) { text.textContent = "Playback session could not be changed."; return; }
  enabled = !enabled;
  button.textContent = enabled ? "Lock playback" : "Enable playback for 15 minutes";
  document.querySelectorAll("audio,video").forEach(media => { media.pause(); if(enabled) media.load(); });
  clearTimeout(timeout);
  if(enabled) timeout = setTimeout(lock, 900000);
  else lock();
};
// Also gate browser-born oscillators and already-decoded buffers in the dashboard.
const originalPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function(...args) {
  return enabled ? originalPlay.apply(this, args) : Promise.reject(new Error("Enable this playback session first"));
};
const NativeContext = window.AudioContext || window.webkitAudioContext;
if(NativeContext) {
  const Guarded = new Proxy(NativeContext, {construct(target,args) {
    const context = new target(...args);
    contexts.add(context);
    if(!enabled) void context.suspend();
    const resume = context.resume.bind(context);
    context.resume = () => enabled ? resume() : Promise.reject(new Error("Enable this playback session first"));
    const close = context.close.bind(context);
    context.close = () => { contexts.delete(context); return close(); };
    return context;
  }});
  window.AudioContext = Guarded;
  if(window.webkitAudioContext) window.webkitAudioContext = Guarded;
}
