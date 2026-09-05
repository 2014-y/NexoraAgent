'use strict';
const base = require('../package.json').build;
module.exports = {
  ...base,
  extends: null,
  // Optional Windows release assets must not be required for a clean Mac build.
  extraResources: base.extraResources.filter(resource => resource.to === 'gateway-runtime.tar'),
  mac: {
    ...base.mac,
    artifactName: 'Nexora-Agent-${version}-mac-${arch}.${ext}',
    minimumSystemVersion: '13.5',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Nexora Agent 使用麦克风进行语音输入。',
      NSCameraUsageDescription: 'Nexora Agent 在您使用相机功能时访问摄像头。',
      NSAppleEventsUsageDescription: 'Nexora Agent 在您使用桌面自动化时控制其他应用。'
    }
  }
};
