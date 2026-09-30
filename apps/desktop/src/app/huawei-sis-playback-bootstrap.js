import {mountHuaweiSisPlayback} from './huawei-sis-playback.js';

if (new URLSearchParams(location.search).get('mode') === 'panel'
  && window.desktop?.sisPlayback) {
  mountHuaweiSisPlayback(window.desktop.sisPlayback);
}
