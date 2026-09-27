import {mountMicrophoneCapture} from './microphone-capture.js';

if (new URLSearchParams(location.search).get('mode') === 'panel' && window.desktop?.microphone) {
  mountMicrophoneCapture(window.desktop.microphone);
}
