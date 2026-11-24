# 03 · 构建、运行、测试

需要 Node.js 22+。

## 装依赖
```bash
npm install
```

## 开发 / 测试（最常用）
```bash
npm run dev        # Vite 开发服务器，浏览器预览（演示模式 + Chrome Web Bluetooth/Serial）
npm test           # 跑所有 Vitest（当前 109 个全过）
npx tsc --noEmit -p .   # 只做类型检查
npm run build      # tsc 类型检查 + vite 打包到 dist/
```

## 预览打包结果
```bash
npm run build
npx vite preview --port 4173 --strictPort
# 然后浏览器开 http://localhost:4173/
```

## 自动化端到端测试（本仓库用的方式）
开发时用 Playwright（已随 Electron 装好，`require('playwright')` 直接能用）对 `vite preview` 做端到端点击。模式：
1. `npm run build`
2. 后台起 `npx vite preview --port 4173 --strictPort`
3. 写个 `.cjs` 脚本用 `chromium.launch()` + iPhone 13 设备模拟，点击验证。
（这些 e2e 脚本是临时的，没进仓库；核心逻辑都有 Vitest 单测，优先加单测。）

## 出三端安装包

### Windows（Electron）
```bash
npm run cap:sync   # 其实 electron 不需要 cap sync；直接：
npm run build
npm run dist:win   # electron-builder 出 release/ 里的 portable + nsis exe
# 开发时实时调试：
npm run electron:dev
```
- **在 Linux 容器里打包 Windows 需要 wine**（本仓库开发环境装了 wine + wine32，用 `WINEDEBUG=-all WINEPREFIX=/root/.wine npx electron-builder --win portable`）。
- wine 下 NSIS 安装包这步会崩，**portable 单文件 exe 能出**。`package.json` 里 `win.signAndEditExecutable:false` 关掉了会崩的版本戳步骤——所以 portable exe **没有图标/签名**，Windows 首次运行提示"未知发布者"。
- **在真 Windows 上 `npm run dist:win` 没有这些限制**（不需要 wine，有图标、能出安装包）。

### 安卓（Capacitor）
```bash
npm run build
npx cap sync android
npx cap open android   # Android Studio 里 Run / Build APK
```
- 需要 Android Studio + JDK 21。
- **本仓库开发环境下载不了 Android SDK，出不了 APK**；在用户自己电脑上正常。
- 蓝牙/本地网络权限已写进 `android/app/src/main/AndroidManifest.xml`。

### iPhone（Capacitor）
```bash
npm run build
npx cap sync ios
npx cap open ios       # Xcode 里签名后运行到真机
```
- 需要 Mac + Xcode 26+。
- 蓝牙/本地网络权限已写进 `ios/App/App/Info.plist`。
- 蓝牙在模拟器上用不了，要真机。

## 当前已打包的 exe
- `downloads/MINI-R-Diag-0.3.0-portable.exe`（74MB，提交进仓库了，方便从 GitHub 网页直接下载）。
- 这个 exe 是 0.3.0 版，含到 map 调校为止的所有功能，但**不含本次刚加的宝马模块**（宝马加完后需要重新 `dist:win` 才会进 exe）。

## Git
- 开发分支 `claude/mini-r-chassis-flash-app-n74wvq`，**不要直接推 main**。
- `release/`、`node_modules/`、`dist/` 已 gitignore；`downloads/` 下的 exe 是特意 `-f` 强加进去的。
