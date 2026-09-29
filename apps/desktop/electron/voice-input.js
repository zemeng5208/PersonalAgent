import {VoiceSessionManager, createVoicePcmBuffer,
  createRuntimeClientTranscriptConsumer} from '@personal-agent/voice';
import {createDesktopVoiceInputCore} from './voice-input-core.js';

export function createDesktopVoiceInput(options) {
  if (!options.speechPorts?.recognition || !options.speechPorts?.output
    || typeof options.speechPorts?.dispose !== 'function') {
    throw Error('语音供应商尚未配置');
  }
  return createDesktopVoiceInputCore({...options, createBuffer: createVoicePcmBuffer,
    VoiceSessionManager, createConsumer: createRuntimeClientTranscriptConsumer,
    createSpeechPorts: () => options.speechPorts});
}
