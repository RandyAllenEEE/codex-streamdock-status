# Codex Stream Dock Status

用一颗 MiraBox LCD 按键看本地 Codex 会话是否在工作、是否需要处理。按键可返回 Windows ChatGPT 桌面应用，黄灯或红灯时优先打开对应会话。

A Windows MiraBox Stream Dock plugin that shows local Codex activity on one LCD key and opens ChatGPT when pressed.

## 状态

主数字始终表示**运行中和等待中的会话总数**。同时存在多个状态时，按红、黄、绿、灰显示。

| 背景 | 小字 | 含义 | 短按 |
| --- | --- | --- | --- |
| 绿 | RUN | 有会话正在运行 | 激活 ChatGPT |
| 黄 | WAIT 数量 | 有会话等待系统审批 | 打开等待最久的会话 |
| 红 | ERR 数量 | 模型请求失败持续 15 秒，期间未观察到重试或推进 | 打开最早出现未恢复失败的会话 |
| 灰 | IDLE 或 HOOK | 0 表示空闲，横线表示插件启动后还未收到 Hook | 激活或启动 ChatGPT |

达到红灯条件的会话暂时退出活动计数，重试时重新计入。按键采用 [Codex 官方深链接](https://learn.chatgpt.com/docs/app/commands#deep-links)。会话标识无法用于深链接、Windows 未注册对应协议或系统报告启动失败时，按键回到激活 ChatGPT 的路径。

## 要求

- Windows 10 或 11，带可分配 LCD 按键的 MiraBox 设备。
- Stream Dock 3.10.205.0918 或更新版本。插件以 SDK 3 和 Stream Dock 内置 Node 20.8.1 为基线。
- 支持 [官方命令 Hooks](https://learn.chatgpt.com/docs/hooks) 的 ChatGPT/Codex 桌面客户端。本项目跟踪发出本地 Hooks 的会话。
- Hook 安装脚本和基准测试需要 PowerShell 7。从源码构建需要 Node.js 20.8.1 或更新版本和 npm。安装成品时，Hook 默认使用 Stream Dock 随附的 node20.exe。

## 安装与卸载

1. 解压 codex-streamdock-hooks.zip，保留其中的 scripts 和 src 目录。
2. 打开 Stream Dock，使安装脚本能找到内置 Node。若应用已退出，使用 -StreamDockExecutable 指向 StreamDock.exe。
3. 双击 com.randy.streamdock.codexstatus.sdPlugin 安装，在 Stream Dock 中将 **Codex Status** 拖到一个 LCD 键。
4. 从解压目录执行以下命令。Project 方式适合先在独立目录中验证。User 方式适用于本 Windows 用户的本地 Codex 会话。

    ~~~powershell
    .\scripts\hooks.ps1 -Action Install -Scope Project -ProjectRoot 'C:\path\to\test-project'
    .\scripts\hooks.ps1 -Action Install -Scope User
    ~~~

    两条命令是可选的安装范围。日常使用选择其中一种，避免同一个 Hook 在两个范围重复触发。安装不需要管理员权限。可用 -WhatIf 查看计划写入的配置路径。

5. 选择 Project 时，先在 ChatGPT 打开指定的本地工作区，并在客户端信任该工作区。项目级 Hooks 只在该工作区显示。选择 User 时可直接在 ChatGPT **设置 → Hooks** 中查看。审阅并信任新增命令后，开始一轮本地 Codex 对话。使用 -Action Status 和相同范围参数检查注册结果。

卸载时在 Stream Dock 中移除 Codex Status，再用 -Action Uninstall 和安装时相同的范围参数清理 Hook 条目。脚本保留同文件中的其他 Hooks。确定所有范围均已卸载后，可以从 Windows 用户本地应用数据目录移除 CodexStreamDockStatus 文件夹。首次改动现有 hooks.json 时保留一份固定名称的备份，便于手工恢复。

## 构建、测试和开发部署

~~~powershell
npm ci
npm test
npm run build
node --test test/package.test.cjs
~~~

构建结果在 release 目录。插件包是 Stream Dock 所需的同名包装目录 ZIP，Hook 包包含可独立运行的安装脚本。构建本身不安装插件或修改 Codex 配置。Windows CI 在干净检出中运行测试、构建并核验两个包。

本机开发部署用 npm run dev。它只写入本项目的插件目录。也可以传入独立的测试插件目录。

~~~powershell
npm run dev -- 'C:\path\to\StreamDock\plugins'
~~~

首次部署后重启 Stream Dock，在单独的测试配置页绑定 Codex Status。重新部署前先退出 Stream Dock，避免 Windows 锁定插件文件。部署后重新启动 Stream Dock。开发命令识别它自己创建的副本，安装过正式包时应通过 Stream Dock 管理该包。

## 数据、开销和可观察范围

- 命令 Hook 将事件类型、会话和轮次标识、时间及必要结果标志送往本机命名管道。插件只保存内存状态。固定安装文件位于 %LOCALAPPDATA%\CodexStreamDockStatus。
- 会话表最多 128 条，60 分钟没有新信号的会话退出活动计数。重启后从下一条可识别的 Hook 事件恢复显示。尚未收到 Hook 时显示 HOOK。
- 通过 PermissionRequest 识别系统审批。批准后要等到同一轮下一次模型请求或终止事件，黄灯才会更新。普通提问、异步输入及云端会话取决于客户端事件覆盖，本版只声明系统审批支持。
- 红灯跟踪模型请求失败，并给重试留出 15 秒。它的覆盖范围由 PostModelRequest 决定。客户端退出、系统休眠、或请求在没有新 Hook 的情况下长时间运行时，显示会在超时后回到空闲。
- 每次 Hook 由一个 Node 短进程处理。插件退出时发送端在短超时内结束。用户数据中不会按事件产生文件。在 Stream Dock 3.10.205.0918 和内置 Node 20.8.1 上，对 64 KiB 输入做了 30 次命令链测量。接收端在线时中位数 108.6 ms，P95 112.5 ms。关闭接收端时 P95 111.6 ms，测试期间新增运行文件 0 个。10 次模型尝试的 20 个 Hook 按中位数合计约 2.17 秒。含空格的路径使用 CMD 兼容启动，额外开销以该机器实测为准。可用以下命令复测。

    ~~~powershell
    npm run benchmark -- 'C:\path\to\StreamDock\node\node20.exe'
    ~~~

    基准输出单次中位数、P95、最大耗时和 10 次模型尝试的累计估算。基准针对命令和插件通信，Codex 自身的调度时间应在实机验收时另行核对。

## 验证记录

- MiraBox N3 实机连接 Stream Dock 3.10.205.0918。使用合成事件核对绿 2、黄 2、红 1、灰 0。实体键已验证可以激活 ChatGPT，黄灯时可打开指定的验证会话。重启后显示未收到 Hook，收到新事件后恢复显示。
- Codex CLI 0.167.0-alpha.3.2 的两条真实测试会话共发出并送达 14 条 Hook 事件，峰值活动计数 2。项目级 Hook 经客户端发现接口核验，全部 7 条识别成功。审批显示与失败延时使用合成事件验证。真实 CLI 测试没有产生系统审批提示，普通提问识别尚未启用。
- 两次 Windows 派发对比中，原 PowerShell 路径为 324–363 ms，直接派发为 160–172 ms。这个数字是启动命令完成时间。新版在 N3 实体键上复测可打开同一会话。

## Acknowledgements

- [MiraBox Stream Dock Plugin SDK](https://github.com/MiraboxSpace/StreamDock-Plugin-SDK) 与 [Plugin Builder](https://github.com/MiraboxSpace/StreamDock-Plugin-Builder) 提供了通信协议、动作生命周期和 Node 插件模板。
- [Codex Traffic Light for Windows](https://github.com/peters385/codex-traffic-light-windows) 的四色状态灯是本项目显示交互的参考。
- [Agent Signal Bar 的原作者 guan-ops](https://github.com/guan-ops) 与 [ridyang 的 Windows 移植](https://github.com/ridyang/Agent-Signal-Bar-Windows) 提供了多会话状态优先级的设计参考。

项目使用 [MIT 许可](LICENCE)。实际使用的模板和分发依赖声明见 [Third-party notices](THIRD_PARTY_NOTICES.md)。
