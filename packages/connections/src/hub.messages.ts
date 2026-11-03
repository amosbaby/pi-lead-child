// 连接中心回给设置页的文字（2026-11-01 多语言）：连接的状态和问题、设置说明、连接流程的结果、设置页操作的错误。
// 按当时用户选的语言（store 的 getLocale）写。同一个错误也回给 Lead 的工具时，也按用户的语言写。
// 只给 agent 看的拒绝（守卫、清单、角色、写入确认的要求）不在这里，留在 hub.ts。
import { defineMessages } from "@pi-lead-child/protocol";

export const hubMessages = defineMessages({
  en: {
    // ── 找连接 ──
    knownNotConnected: (label: string, url: string) =>
      `${label} is not connected. Go to Settings → Connections and add the custom MCP ${url}`,
    noSuchConnection: (key: string) => `This connection does not exist: ${key}`,
    notConnected: (label: string) => `${label} is not connected`,
    needsReauth: (label: string) => `The authorization for ${label} is not valid. Authorize it again`,

    // ── 状态和设置说明 ──
    setupSlack: "First, configure the Slack app of your workspace on the daemon (client ID)",
    setupGhCli: "Uses the gh login on this Mac",
    setupGhDevice: "Shows a device code. Type it on GitHub",
    setupGhMissing: "First, install gh and log in, or paste a PAT",
    problemInvalidClient: (label: string) => `${label} does not accept this client any more. Authorize it again`,
    problemInsufficientScope: (label: string) => `The authorization for ${label} does not have the necessary permissions. Authorize it again`,
    problemInvalidGrant: (label: string) =>
      `The authorization for ${label} is not valid (it is possibly revoked or expired). Authorize it again`,
    problemTransient: (label: string) => `Cannot reach ${label} now. The daemon tries again automatically`,
    problemExpiring: (label: string, days: number) =>
      `The authorization for ${label} expires in ${days === 1 ? "1 day" : `${days} days`}. If you authorize it again before then, running work does not stop`,
    problemExpiresToday: (label: string) => `The authorization for ${label} expires today`,
    reauthFallback: (label: string) => `${label} needs authorization again`,
    expiringFallback: (label: string) => `The authorization for ${label} expires soon`,

    // ── 开始连接 ──
    noServerUrl: "This service does not have an address yet",
    patOnlyGithub: "Only GitHub accepts a pasted token",
    urlAlreadyListed: "This address is already in the connection list. Connect it from the list",
    urlHasSecret: "The address has a parameter that looks like a key or token. Remove it. Keys are entered in Settings → Connections",
    localStartFailed: (label: string, detail: string) => `${label} did not start: ${detail}`,
    localNoTools: (label: string) => `${label} started, but it has no tools`,
    needsPreregisteredApp: (label: string) => `First, configure a pre-registered app for ${label} on the daemon`,
    readAuthInfoFailed: (label: string) => `Cannot read the authorization details of ${label}`,
    registerClientFailed: "Cannot register the client",
    exchangeTokenFailed: "Cannot get a token",
    authTransient: (prefix: string) => `${prefix}: the network or the service is temporarily not available. Try again later`,
    authFailed: (prefix: string, detail: string) => `${prefix}: ${detail}`,

    // ── 浏览器授权 ──
    flowLinkInvalid: (leadName: string) => `This authorization link is not valid any more. Go back to ${leadName} and connect again`,
    flowLinkUsed: "This authorization link was already used",
    flowTimedOut: "The authorization timed out. Connect again",
    flowTimedOutReturn: (leadName: string) => `The authorization timed out. Go back to ${leadName} and connect again`,
    deniedOnAuthPage: "You refused the authorization on the authorization page",
    authorizationFailed: (detail: string) => `The authorization failed: ${detail}`,
    wrongIssuer: "The authorization response came from a different authorization server. It was refused",
    noCode: "The authorization response has no authorization code",
    flowEnded: "The authorization ended or timed out",

    // ── GitHub ──
    notGithubToken: "This does not look like a GitHub token",
    githubRejectedToken: "GitHub does not accept this token",
    noGhLogin: "No one logged in to gh on this Mac. Run gh auth login first, or paste a GitHub token",

    // ── 设置、测试、调用 ──
    vaultUnavailable: (detail: string) => `The vault is temporarily not available. The settings were not saved: ${detail}`,
    testOk: (tools: number) => `It works. ${tools === 1 ? "1 tool" : `${tools} tools`}`,
    confirmationGone: "This confirmation expired or does not exist",
    confirmSummary: (tool: string) => `Call ${tool}`,
    writeSummary: (label: string, tool: string) => `Called ${tool} on ${label}`,
    callTransient: (label: string, detail: string) => `Cannot reach ${label} now: ${detail}`,
    callRejected: (label: string, detail: string) => `${label} refused this call: ${detail}`,
  },
  zh: {
    knownNotConnected: (label, url) => `${label} 还没有连接：在设置 → 连接里添加自定义 MCP ${url}`,
    noSuchConnection: (key) => `没有这个连接：${key}`,
    notConnected: (label) => `${label} 还没有连接`,
    needsReauth: (label) => `${label} 的授权失效了，需要重新授权`,

    setupSlack: "需要先在 daemon 上配置你们工作区的 Slack app（client ID）",
    setupGhCli: "会使用这台 Mac 上 gh 的登录",
    setupGhDevice: "会显示一个设备码，在 GitHub 上输入即可",
    setupGhMissing: "需要先安装并登录 gh，或者粘贴一个 PAT",
    problemInvalidClient: (label) => `${label} 不再认这个客户端，需要重新授权`,
    problemInsufficientScope: (label) => `${label} 的授权缺少需要的权限，需要重新授权`,
    problemInvalidGrant: (label) => `${label} 的授权失效了（可能被撤销或已过期），需要重新授权`,
    problemTransient: (label) => `暂时连不上 ${label}，daemon 会自动重试`,
    problemExpiring: (label, days) => `${label} 的授权 ${days} 天后到期，到期前重新授权不会打断正在跑的工作`,
    problemExpiresToday: (label) => `${label} 的授权今天到期`,
    reauthFallback: (label) => `${label} 需要重新授权`,
    expiringFallback: (label) => `${label} 的授权快到期了`,

    noServerUrl: "这个服务还没有地址",
    patOnlyGithub: "只有 GitHub 支持粘贴令牌",
    urlAlreadyListed: "这个地址已经在连接列表里了，请直接在列表里连接",
    urlHasSecret: "地址里有一个像密钥或令牌的参数，先去掉它。密钥在设置 → 连接里填",
    localStartFailed: (label, detail) => `${label} 起不来：${detail}`,
    localNoTools: (label) => `${label} 起来了，但是没有工具`,
    needsPreregisteredApp: (label) => `${label} 需要先在 daemon 上配置预注册的 app`,
    readAuthInfoFailed: (label) => `读不到 ${label} 的授权信息`,
    registerClientFailed: "注册客户端失败",
    exchangeTokenFailed: "换取令牌失败",
    authTransient: (prefix) => `${prefix}：网络或服务暂时不可用，请稍后再试`,
    authFailed: (prefix, detail) => `${prefix}：${detail}`,

    flowLinkInvalid: (leadName) => `这个授权链接已经失效了，请回到 ${leadName} 重新连接`,
    flowLinkUsed: "这个授权链接已经用过了",
    flowTimedOut: "授权超时了，请重新连接",
    flowTimedOutReturn: (leadName) => `授权超时了，请回到 ${leadName} 重新连接`,
    deniedOnAuthPage: "你在授权页上拒绝了授权",
    authorizationFailed: (detail) => `授权失败：${detail}`,
    wrongIssuer: "授权响应来自另一个授权服务器，已拒绝",
    noCode: "授权响应里没有授权码",
    flowEnded: "授权已经结束或超时",

    notGithubToken: "这不像一个 GitHub 令牌",
    githubRejectedToken: "GitHub 不接受这个令牌",
    noGhLogin: "这台 Mac 上没有登录过的 gh。请先运行 gh auth login，或者粘贴一个 GitHub 令牌",

    vaultUnavailable: (detail) => `保险库暂时不可用，设置没有保存：${detail}`,
    testOk: (tools) => `能用，${tools} 个工具`,
    confirmationGone: "这个确认已经过期或不存在",
    confirmSummary: (tool) => `调用 ${tool}`,
    writeSummary: (label, tool) => `调用了 ${label} 的 ${tool}`,
    callTransient: (label, detail) => `暂时连不上 ${label}：${detail}`,
    callRejected: (label, detail) => `${label} 拒绝了这次调用：${detail}`,
  },
});
