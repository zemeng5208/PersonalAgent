import {VoiceSessionManager, createVoicePcmBuffer, createRuntimeClientTranscriptConsumer,
  createWindowsSystemSpeechPorts} from '@personal-agent/voice';
import {createDesktopVoiceInputCore} from './voice-input-core.js';

export function createDesktopVoiceInput(options) {
  return createDesktopVoiceInputCore({...options, createBuffer: createVoicePcmBuffer,
    VoiceSessionManager, createConsumer: createRuntimeClientTranscriptConsumer,
    createSpeechPorts: createWindowsSystemSpeechPorts});
}
