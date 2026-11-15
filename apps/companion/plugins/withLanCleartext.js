// 允许 App 用明文 http 连局域网里的 daemon（2026-11-15）。
// 配对后 App 连的是同一个局域网里的 http://192.168.x.x:端口。Android 9 起缺省禁止明文 http：Expo Go 和调试包里放开了，
// release 包里不放开就连不上 daemon。网络安全配置只能按域名放开，不能按局域网的 IP 段，所以整个 App 放开明文；
// 连外网的地址（文档、更新）本来就是 https。
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withLanCleartext(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) throw new Error('AndroidManifest.xml has no <application> element');
    application.$['android:usesCleartextTraffic'] = 'true';
    return next;
  });
};
