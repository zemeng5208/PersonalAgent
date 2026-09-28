import {mountLiveVoicePlayback} from './live-voice-playback.js';
if (new URLSearchParams(location.search).get('mode') === 'panel' && window.desktop?.livePlayback) {
  const dispose = mountLiveVoicePlayback(window.desktop.livePlayback);
  window.addEventListener('unload', dispose);
}
