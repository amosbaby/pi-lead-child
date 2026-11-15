# Android 安装包的签名

发布 release 时，`.github/workflows/release-android.yml` 打出签了名的 `lead-child-<版本>.apk` 和它的 `.sha256`，挂到 release 上。用户从 GitHub 下载安装。本文说明签名用的密钥怎么准备、放在哪里。

## 先要知道的一件事

Android 只允许同一把密钥签的安装包覆盖安装。密钥丢了，已经装了的用户只能先卸载、再装新的，数据也会丢。所以：

- 只做一把密钥，以后每个版本都用它。
- 密钥文件和口令备份在密码管理器里。
- 密钥不进仓库，不进提交历史，不发给任何人。

## App 申请的权限

`apps/companion/app.json` 里声明。release 包只带这些：

| 权限 | 用来做什么 |
|---|---|
| `INTERNET`、`ACCESS_NETWORK_STATE` | 连局域网里的 daemon，判断网络通不通 |
| `CAMERA` | 扫配对二维码；以后拍照发给 Lead |
| `POST_NOTIFICATIONS` | Android 13 起发通知要先问用户；以后有通知时再弹出询问 |

选照片和文件用系统的选择器（Android 13 起的 Photo Picker 和文件选择器），不需要存储权限。所以下面这些权限在 `blockedPermissions` 里去掉，依赖带进来的也去掉：录音、读写外部存储、读媒体文件、悬浮窗。

另外，release 包允许明文 http（`plugins/withLanCleartext.js`）：daemon 在局域网里是 `http://192.168.x.x`，Android 9 起缺省禁止明文 http。

## 1. 生成密钥

二选一。两种得到的都是 PKCS#12 格式的密钥库，Gradle 和 apksigner 都认。

### 用 openssl（不用装 Java）

在一个只有你能访问的目录里执行：

```bash
umask 077
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32 > store-password.txt
openssl req -x509 -newkey rsa:4096 -sha256 -days 10950 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=Lead-Child"
openssl pkcs12 -export -name lead-child -inkey key.pem -in cert.pem \
  -keypbe AES-256-CBC -certpbe AES-256-CBC \
  -out release.keystore -passout file:store-password.txt
rm key.pem
```

- 有效期是 30 年（10950 天）。
- `-keypbe` 和 `-certpbe` 让密钥库用 AES 加密。macOS 自带的 openssl（LibreSSL）不加它们时用的是很旧的 RC2 加密。
- 别名是 `lead-child`。
- PKCS#12 只有一个口令：密钥库口令和密钥口令是同一个，都在 `store-password.txt` 里。
- `-subj` 里只写应用名，不写真实的姓名和邮箱：证书会随安装包公开。

### 用 keytool（已经装了 JDK 时）

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore release.keystore \
  -alias lead-child -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=Lead-Child"
```

keytool 会问口令。PKCS#12 的密钥口令和密钥库口令用同一个。

## 2. 记下证书指纹

```bash
openssl pkcs12 -in release.keystore -nokeys -passin file:store-password.txt \
  | openssl x509 -noout -fingerprint -sha256
```

记下 `SHA256 Fingerprint=` 后面的值。它不是机密，可以公开。

## 3. 备份

把 `release.keystore` 和口令存进密码管理器，作为一条记录的附件和字段。然后删掉本机的明文口令文件：

```bash
rm store-password.txt
```

## 4. 填进 GitHub

在仓库的 Settings → Secrets and variables → Actions 里，或者用 gh 命令，添加四个 secret 和一个变量。

| 名字 | 种类 | 内容 |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | secret | `release.keystore` 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | secret | 密钥库口令 |
| `ANDROID_KEY_ALIAS` | secret | 别名，例如 `lead-child` |
| `ANDROID_KEY_PASSWORD` | secret | 密钥口令（PKCS#12 时和密钥库口令一样） |
| `ANDROID_SIGNING_CERT_SHA256` | variable | 第 2 步的证书指纹 |

用 gh 时，口令从文件或者交互输入读，不写在命令行里：

```bash
base64 -i release.keystore | gh secret set ANDROID_KEYSTORE_BASE64
```

```bash
gh secret set ANDROID_KEYSTORE_PASSWORD
```

```bash
gh secret set ANDROID_KEY_ALIAS --body lead-child
```

```bash
gh secret set ANDROID_KEY_PASSWORD
```

```bash
gh variable set ANDROID_SIGNING_CERT_SHA256 --body "<第 2 步的指纹>"
```

不带 `--body` 时，gh 提示你粘贴值，值不进 shell 的历史记录。

有了 `ANDROID_SIGNING_CERT_SHA256`，workflow 签完包以后会比对证书指纹。用错了密钥时，job 失败，不上传。

## 5. 发版

和以前一样发布 release。`release-macos` 和 `release-android` 同时开始，apk 大约 20 分钟后出现在 release 的附件里。job 的摘要里写着这次签名的证书指纹。

如果要重新打某个版本的包，在 Actions 里手动运行 `release-android`，填同一个 tag。

## 用户怎么校验

在 README 或者 release 说明里公开证书指纹。用户可以这样校验：

- 下载 `.apk.sha256`，比对文件的 SHA-256。
- 用 `apksigner verify --print-certs` 或者 AppVerifier 这类应用，比对证书指纹。

## 以后上 F-Droid

有三条路，按省事的程度排：

1. **Obtainium**：用户在 Obtainium 里填 GitHub 仓库的地址，它跟着 release 的 apk 自动更新。我们什么都不用做。
2. **IzzyOnDroid**：一个兼容 F-Droid 客户端的第三方仓库，直接收录 GitHub release 里的 apk，签名还是我们的。用户从 GitHub 装的版本和从这里装的版本可以互相覆盖。要提一个收录申请。
3. **F-Droid 官方仓库**：F-Droid 从源码重新打包，缺省用 F-Droid 自己的密钥签名。这样 F-Droid 版和 GitHub 版签名不同，不能互相覆盖安装。要让 F-Droid 发布我们签的包，构建必须可复现（同样的源码打出逐字节相同的 apk），React Native 和 Expo 的项目很难做到。官方仓库还要求不含专有依赖，例如 Google Play 服务、Firebase 推送。

建议先只发 GitHub，告诉想要自动更新的用户用 Obtainium。需要出现在 F-Droid 客户端里时，先申请 IzzyOnDroid。
