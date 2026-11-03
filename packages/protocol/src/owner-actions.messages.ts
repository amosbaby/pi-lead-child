// 主人操作给人看的文字（2026-11-01 多语言）：每个操作的名字和「不是我」时的撤销说明、凭证的来历、客户端、推送和会话卡的正文。
// daemon 写进数据库的文字按写入时的语言写；现在后端调用方都传 "zh"，以后改成用户的语言（store 的 getLocale）。
// 称呼 Lead 的地方写成 {lead}，给人看之前由 ownerActionText 换成 Lead 的名字。
import { defineMessages } from "./i18n.ts";
import type { BindingOrigin, OwnerActionClient, OwnerActionId } from "./owner-actions.ts";

type ActionText = { label: string; undoNote: string };

export const ownerActionMessages = defineMessages({
  en: {
    actions: {
      "approval.resolve": {
        label: "Resolve an approval",
        undoNote: "The approval changes to a rejection, and the conversation exemption is cancelled. "
          + "If the child already read the approval, the approved action already ran, and you cannot undo it. A rejection does not change.",
      },
      "decision.resolve": {
        label: "Answer a decision",
        undoNote: "The answer already went to the requester ({lead} or a child). You cannot undo it.",
      },
      "connection.confirm": {
        label: "Confirm a connection write",
        undoNote: "After you allow it, the write goes to the external service, and you cannot undo it. A refusal does not change.",
      },
      "memory.switch_confirm": {
        label: "Confirm a memory switch",
        undoNote: "The switch already started. The system does not switch back by itself. "
          + "If necessary, switch back in Settings → Memory. A refusal does not change.",
      },
      "standing_order.proposal_decide": {
        label: "Decide on a standing order proposal",
        undoNote: "An approved change rolls back to the version before the approval. A new standing order has no earlier version, so it cannot roll back. "
          + "Later changes do not roll back by themselves. A rejection does not change.",
      },
      "ticket.confirm": {
        label: "Confirm a ticket",
        undoNote: "The ticket goes back to draft. If the work already started, the system stops it first, then sets the ticket back to draft.",
      },
      "ticket.complete": {
        label: "Accept a ticket",
        undoNote: "The ticket goes back to review. If dependent tickets or the parent integration already started, they do not stop by themselves.",
      },
      "ticket.stop": {
        label: "Stop a ticket",
        undoNote: "The process already ended. The system does not start it again for you. If necessary, click \"Start\" in the ticket.",
      },
      "ticket.cancel": {
        label: "Cancel a ticket",
        undoNote: "The ticket goes back to draft (a reminder goes back to pending), and you must confirm it again. A stopped run does not restart by itself.",
      },
      "lead.trust": {
        label: "Change the authority of {lead}",
        undoNote: "The new authority is removed. Removing authority is safer, so the system does not restore it by itself.",
      },
      "lead.delegation": {
        label: "Change delegated acceptance",
        undoNote: "The new delegation is removed. Rework that started with the grant does not stop by itself. "
          + "Removing a delegation is safer, so the system does not restore it by itself.",
      },
      "connection.settings": {
        label: "Change connection permissions",
        undoNote: "What this change opened (new roles, direct writes) goes back to how it was. Later changes do not go back by themselves. "
          + "Tighter settings are safer, so the system does not restore them by itself. Writes that already ran cannot be undone.",
      },
      "channel.credentials": {
        label: "Change channel credentials",
        undoNote: "The system deletes the credentials that settings saved for this channel and disconnects it "
          + "(if Keychain or environment variables still have credentials, it uses them to connect again). Later changes are not deleted by themselves. "
          + "Deleting credentials is safer, so the system does not restore them by itself.",
      },
      "run.pause": {
        label: "Pause a run",
        undoNote: "If the run is still paused, the system resumes it.",
      },
      "run.stop": {
        label: "Stop a run",
        undoNote: "Stop is a final state. The process already ended, and you cannot undo it.",
      },
      "run.grant": {
        label: "Widen sub-agent permissions",
        undoNote: "The system removes the rules that this change added. The sub-agent cannot use them on its next call. "
          + "Writes that it already did with the new permissions are not undone.",
      },
      "connection.agent_write": {
        label: "A sub-agent writes to an external service for you",
        undoNote: "The write is already on the external service. It cannot be undone here. Change or delete it there.",
      },
      "workspace.release": {
        label: "Release a work folder",
        undoNote: "The work folder is already released. You cannot undo it.",
      },
      "workspace.cleanup": {
        label: "Clean up a work folder",
        undoNote: "The files in the work folder are already deleted. You cannot undo it.",
      },
      "standing_order.rollback": {
        label: "Roll back a standing order",
        undoNote: "The standing order goes back to the version before the rollback. Later changes do not roll back by themselves.",
      },
      "lead.profile": {
        label: "Change the assistant name and style",
        undoNote: "The name, persona and interaction style go back to how they were. Later changes do not go back by themselves.",
      },
      "ui.design": {
        label: "Change the appearance",
        undoNote: "The appearance goes back to how it was. Later changes do not go back by themselves.",
      },
      "channel.reply_style": {
        label: "Change the reply style",
        undoNote: "The reply style goes back to how it was. Later changes do not go back by themselves.",
      },
      "memory.preferences": {
        label: "Change standing preferences",
        undoNote: "The standing preferences go back to how they were. Later changes do not go back by themselves.",
      },
    } satisfies Record<OwnerActionId, ActionText>,
    origins: {
      cli: "the plc CLI credential",
      loopback_web: "the web page on this computer",
      phone_qr: "a phone paired with a QR code",
      admin_pairing: "a pairing made with plc pair",
      local_invitation: "a pairing invitation redeemed on this computer",
      aish: "Slack",
      channel_owner: "your direct message to yourself in Slack",
      unknown: "a credential from before v47",
    } satisfies Record<BindingOrigin, string>,
    clients: {
      cli: "CLI",
      web: "Web",
      phone: "Phone",
      lead: "{lead} did it for you in the conversation",
      agent: "A sub-agent from {lead} did it with its permission list",
      unknown: "Unknown client",
    } satisfies Record<OwnerActionClient, string>,
    onBehalfUndoCredentialNote: (leadName: string) =>
      `${leadName} did this for you in the conversation. Only this action is undone. The credential is not revoked. `
      + "If you did not say that, go to Settings → Paired devices and revoke that device.",
    agentDid: (lead: string, credential: string) => `A sub-agent from ${lead} did this with the permission list of ${credential}.`,
    agentUndo: "It cannot be undone here. Use the link to change or delete it on the external service.",
    undoNoteWithLink: (note: string, link: string) => `${note} Link: ${link}`,
    leadDid: (lead: string, credential: string, origin: string, bindingId: number) =>
      `${lead} did this for you in the conversation. That turn came from: ${credential} (${origin}, #${bindingId})`,
    leadUndo: (lead: string) =>
      `Did ${lead} misunderstand? Click "Undo" to undo this action. The credential is not revoked. `
      + "If you did not say that, go to Settings → Paired devices and revoke that device.",
    fromThisComputer: "From this computer",
    fromOtherDevice: "From another device",
    credentialLine: (credential: string, origin: string, bindingId: number, where: string) =>
      `Credential: ${credential} (${origin}, #${bindingId}) · ${where}`,
    notMe: "Not you? Click \"Not me\" to undo this action and revoke this credential.",
    recordBody: (deviceName: string) => `Done on ${deviceName} (a phone paired with a QR code). Recorded only, not pushed.`,
  },
  zh: {
    actions: {
      "approval.resolve": {
        label: "处理审批",
        undoNote: "批准改为拒绝，并取消会话豁免。发起的 child 已经读到批准时，被批准的动作已经执行，无法撤回。拒绝不改。",
      },
      "decision.resolve": { label: "回答决定请求", undoNote: "回答已经交给发起方（{lead} 或 child），无法撤回。" },
      "connection.confirm": { label: "确认连接的写入", undoNote: "允许以后，写入已经发到外部服务，无法撤回。不允许的不改。" },
      "memory.switch_confirm": { label: "确认记忆切换", undoNote: "切换已经开始，系统不自动切回。需要时在设置 → 记忆里切回。不同意的不改。" },
      "standing_order.proposal_decide": {
        label: "决定常设指令的提议",
        undoNote: "批准的修改回滚到批准前的版本。新建的指令没有更早的版本，不能回滚。之后又改过的不自动回滚。拒绝不改。",
      },
      "ticket.confirm": { label: "确认工单", undoNote: "工单回到草稿。已经开始执行的，先停止，再回到草稿。" },
      "ticket.complete": { label: "验收工单", undoNote: "工单回到待验收（review）。依赖它的工单、父工单的集成已经开始的，不会自动撤回。" },
      "ticket.stop": { label: "停止工单", undoNote: "执行的进程已经终止，系统不替你重新开始。需要时在工单里点「开始」。" },
      "ticket.cancel": { label: "取消工单", undoNote: "工单恢复到草稿（提醒恢复到待提醒），要你重新确认。被停止的执行不会自动重启。" },
      "lead.trust": { label: "改 {lead} 的授权", undoNote: "新给的授权被撤回。撤回授权更保守，不自动恢复。" },
      "lead.delegation": { label: "改委托验收", undoNote: "新给的委托被撤回，授权时顺带开始的返工不会自动停止。撤回委托更保守，不自动恢复。" },
      "connection.settings": {
        label: "改连接的权限设置",
        undoNote: "这次放开的（新加的角色、改成直接写入）恢复原样。之后又改过的不自动恢复。收紧更保守，不自动恢复。已经执行的写入无法撤回。",
      },
      "channel.credentials": {
        label: "改外部通道的凭据",
        undoNote: "删掉设置页里这个通道保存的凭据并断开（Keychain 或环境变量里还有凭据时，用它们重新连上）。之后又改过的不自动删除。"
          + "删除凭据更保守，不自动恢复。",
      },
      "run.pause": { label: "暂停 Run", undoNote: "Run 还在暂停时，恢复它。" },
      "run.stop": { label: "停止 Run", undoNote: "停止是终态，进程已经终止，无法撤回。" },
      "run.grant": { label: "放宽子 agent 的权限", undoNote: "这次加上的规则从清单里删掉，子 agent 下一次调用就用不了它们。用新权限已经做了的写操作不会撤回。" },
      "connection.agent_write": {
        label: "子 agent 代你写外部服务",
        undoNote: "写入已经发到外部服务，这里撤不回。请到那边改或删。",
      },
      "workspace.release": { label: "释放工作区", undoNote: "工作区已经释放，无法撤回。" },
      "workspace.cleanup": { label: "清理工作区", undoNote: "工作区的文件已经删除，无法撤回。" },
      "standing_order.rollback": { label: "回滚常设指令", undoNote: "指令回到回滚前的版本。之后又改过的，不自动回滚。" },
      "lead.profile": { label: "改助手的名字和风格", undoNote: "名字、人格和互动风格恢复成改之前的样子。之后又改过的，不自动恢复。" },
      "ui.design": { label: "改界面的外观", undoNote: "外观恢复成改之前的样子。之后又改过的，不自动恢复。" },
      "channel.reply_style": { label: "改代回复风格", undoNote: "代回复风格恢复成改之前的样子。之后又改过的，不自动恢复。" },
      "memory.preferences": { label: "改常驻偏好", undoNote: "常驻偏好恢复成改之前的样子。之后又改过的，不自动恢复。" },
    },
    origins: {
      cli: "plc 的 CLI 凭证",
      loopback_web: "本机网页",
      phone_qr: "扫码配对的手机",
      admin_pairing: "plc pair 建的配对",
      local_invitation: "在本机兑换的配对邀请",
      aish: "Slack",
      channel_owner: "你在 Slack 里发给自己的私信",
      unknown: "v47 之前的凭证",
    },
    clients: {
      cli: "CLI", web: "网页", phone: "手机", lead: "{lead} 在对话里代你做", agent: "{lead} 派的子 agent 按权限清单做", unknown: "未知客户端",
    },
    onBehalfUndoCredentialNote: (leadName) =>
      `这是 ${leadName} 在对话里代你做的：只撤销了这次操作，没有作废凭证。如果那句话不是你说的，请到「设置 → 已配对设备」撤销那台设备。`,
    agentDid: (lead, credential) => `${lead} 派的子 agent 按${credential}的权限清单做的。`,
    agentUndo: "这里撤不回。请用链接到外部服务上改或删。",
    undoNoteWithLink: (note, link) => `${note}链接：${link}`,
    leadDid: (lead, credential, origin, bindingId) => `${lead} 在对话里代你做的。那一轮来自：${credential}（${origin}，#${bindingId}）`,
    leadUndo: (lead) => `${lead} 理解错了？点「撤销」：撤销这次操作，不作废凭证。如果那句话不是你说的，请到「设置 → 已配对设备」撤销那台设备。`,
    fromThisComputer: "来自这台电脑",
    fromOtherDevice: "来自别的设备",
    credentialLine: (credential, origin, bindingId, where) => `凭证：${credential}（${origin}，#${bindingId}）· ${where}`,
    notMe: "不是你做的？点「不是我」：撤销这次操作，并作废这个凭证。",
    recordBody: (deviceName) => `在 ${deviceName} 上做的（扫码配对的手机）。只记录，不推送。`,
  },
});
