// 运行时（state/runtime.ts）给用户看的错误：客户端或 daemon 太旧、少了某个接口。
// 这里不依赖组件库，从 protocol 直接取 defineMessages。
import { defineMessages } from '@pi-lead-child/protocol';

export const runtimeMessages = defineMessages({
  en: {
    noLeadModelSwitch: 'This daemon cannot change the Lead model yet.',
    noBannerAck: 'This client version cannot acknowledge the banner.',
    noReminderMove: 'This client version cannot change the reminder time.',
    noAction: 'This client version cannot do this action.',
    noFilePreview: 'This server version cannot preview files.',
    serverNoAction: 'This server version does not support this action.',
    noModelSettings: 'This client version cannot change the model settings.',
    noMemorySettings: 'This client version cannot change the memory settings.',
    noMemoryChange: 'This client version cannot change memory.',
    noWidgetChange: 'This client version cannot change widgets.',
    noChannelCards: 'This daemon does not support channel cards.',
    noQueue: 'This daemon does not support the queue.',
    noFollowUp: 'This daemon does not support Steer and cancel.',
    // 凭证做不了决定（网关去掉了 approvals:respond），本机网页又换不到能做决定的凭证。
    decisionNeedsLoopbackPairing: 'This page\'s credential cannot make decisions. '
      + 'Restart the daemon with PLC_ALLOW_LOOPBACK_AUTO_PAIR=1, then reload this page.',
    decisionNeedsPairedDevice: 'This device\'s credential cannot make decisions. '
      + 'Decide in the web page opened on the Mac that runs the daemon, or on a phone paired by QR code.',
  },
  zh: {
    noLeadModelSwitch: '这个 daemon 还不能换 Lead 的模型',
    noBannerAck: '这个版本的客户端不能确认横幅',
    noReminderMove: '这个版本的客户端不能改提醒的时间',
    noAction: '这个版本的客户端不能做这个操作',
    noFilePreview: '这个版本的服务端不能预览文件。',
    serverNoAction: '这个版本的服务端不支持这个操作。',
    noModelSettings: '这个版本的客户端不能改模型设置',
    noMemorySettings: '这个版本的客户端不能改记忆设置',
    noMemoryChange: '这个版本的客户端不能改记忆',
    noWidgetChange: '这个版本的客户端不能改控件',
    noChannelCards: '这个 daemon 不支持通道卡片',
    noQueue: '这个 daemon 不支持排队',
    noFollowUp: '这个 daemon 不支持 Steer 和取消',
    decisionNeedsLoopbackPairing: '这个页面的凭证不能做决定。请用 PLC_ALLOW_LOOPBACK_AUTO_PAIR=1 重启 daemon，然后刷新这个页面。',
    decisionNeedsPairedDevice: '这台设备的凭证不能做决定。请在运行 daemon 的 Mac 上打开的网页里做，或者在扫码配对的手机上做。',
  },
});
