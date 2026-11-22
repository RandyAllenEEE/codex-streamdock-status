# Codex Stream Dock Status

用一颗 MiraBox LCD 按键查看本地 Codex 的活动会话和完成提醒。按键可返回 Windows ChatGPT 桌面应用，蓝、黄、红灯时可打开对应会话。

A Windows MiraBox Stream Dock plugin that shows local Codex activity on one LCD key and opens ChatGPT when pressed.

## 状态

同时存在多个状态时，按红、黄、蓝、绿、灰显示。斜线右边只计正常运行的会话。黄灯 `1/2` 表示 1 个会话等待处理、2 个正在运行。

| 背景 | 显示 | 含义 | 短按 |
| --- | --- | --- | --- |
| 绿 | 运行数，例如 2 | 有会话正在运行 | 激活 ChatGPT |
| 蓝 | 完成未读数/运行数 | 有会话正常结束并等待查看 | 打开最早完成的一条会话并确认该条提醒 |
| 黄 | 等待数/运行数 | 有会话等待系统审批、回答选择框或确认计划 | 打开等待最久的会话 |
| 红 | 失败数/运行数 | 模型请求失败持续 15 秒，期间未观察到重试或推进 | 打开最早出现未恢复失败的会话 |
| 灰 | 0 或横线 | 0 表示空闲，横线表示插件启动后还未收到 Hook | 激活或启动 ChatGPT |

在 Codex 窗口内打开已完成的会话，插件观察到该条会话从侧栏未读列表移除后会清除这一条提醒。蓝键跳转也会确认所打开的那条。客户端的未读状态不可读取时，手动切回 Codex 前台可确认当前提醒。打开黄色的计划会话后，按键仍会提示等待确认。按键标题可在 Stream Dock 属性面板编辑，默认留空。

达到红灯条件的会话暂时退出活动计数，重试时重新计入。按键采用 [Codex 官方深链接](https://learn.chatgpt.com/docs/app/commands#deep-links)。会话标识无法用于深链接、Windows 未注册对应协议或系统报告启动失败时，按键回到激活 ChatGPT 的路径。

## 要求

- Windows 10 或 11，带可分配 LCD 按键的 MiraBox 设备。
- Stream Dock 3.10.205.0918 或更新版本。插件以 SDK 3 和 Stream Dock 内置 Node 20.8.1 为基线。
- 支持 [官方命令 Hooks](https://learn.chatgpt.com/docs/hooks) 的 ChatGPT/Codex 桌面客户端。本项目跟踪发出本地 Hooks 的会话。
- Hook 安装脚本和基准测试需要 PowerShell 7。从源码构建需要 Windows、Node.js 20.8.1 或更新版本、npm 和 Zig 0.15.2。原生模块的架构与执行构建的 Node 一致，当前实测为 x64。安装成品时，Hook 默认使用 Stream Dock 随附的 node20.exe。

## 安装与卸载

1. 解压 codex-streamdock-hooks.zip。这个压缩包提供 Hook 注册和卸载脚本。
2. 打开 Stream Dock，使安装脚本能找到内置 Node。若应用已退出，使用 -StreamDockExecutable 指向 StreamDock.exe。
3. 双击 com.randy.streamdock.codexstatus.sdPlugin 安装，在 Stream Dock 中将 **Codex Status** 拖到一个 LCD 键。
4. 从解压目录执行以下命令。Project 方式适合先在独立目录中验证。User 方式适用于本 Windows 用户的本地 Codex 会话。

    ~~~powershell
    .\scripts\hooks.ps1 -Action Install -Scope Project -ProjectRoot 'C:\path\to\test-project'
    .\scripts\hooks.ps1 -Action Install -Scope User
    ~~~

    两条命令是可选的安装范围。日常使用选择其中一种，避免同一个 Hook 在两个范围重复触发。安装不需要管理员权限。可用 -WhatIf 查看计划写入的配置路径。如果插件位于自定义位置，用 -PluginDirectory 指定完整的 .sdPlugin 目录。

5. 选择 Project 时，先在 ChatGPT 打开指定的本地工作区，并在客户端信任该工作区。项目级 Hooks 只在该工作区显示。选择 User 时可直接在 ChatGPT **设置 → Hooks** 中查看。审阅并信任新增命令后，开始一轮本地 Codex 对话。使用 -Action Status 和相同范围参数检查注册结果。

升级到 0.4.0 时，先更新 Stream Dock 插件，再用原有范围运行新版安装脚本。升级后本项目有 9 条 Hook。请在 Codex 里刷新、审阅并信任。若从 0.1.0 迁移，确认所有使用过的范围都已迁移后，可以删除旧的 %LOCALAPPDATA%\CodexStreamDockStatus 目录。

卸载时用 -Action Uninstall 和安装时相同的范围及插件位置参数清理 Hook 条目，然后在 Stream Dock 中移除 Codex Status。脚本保留同文件中的其他 Hooks。首次改动现有 hooks.json 时保留一份固定名称的备份，便于手工恢复。

## 构建、测试和开发部署

~~~powershell
npm ci
npm test
npm run build
node --test test/package.test.cjs
~~~

构建结果在 release 目录。插件包是 Stream Dock 所需的同名包装目录 ZIP，Hook 包包含可独立运行的安装脚本。构建本身不安装插件或修改 Codex 配置。Windows CI 在干净检出中运行测试、构建并核验两个包。

构建从 PATH 查找 zig.exe，也可通过 STREAMDOCK_ZIG 指定便携编译器的完整路径。首次构建下载并校验固定版本的 Node-API 头文件。编译缓存位于仓库的 build 目录。

本机开发部署用 npm run dev。它只写入本项目的插件目录。也可以传入独立的测试插件目录。

~~~powershell
npm run dev -- 'C:\path\to\StreamDock\plugins'
~~~

首次部署后重启 Stream Dock，在单独的测试配置页绑定 Codex Status。重新部署前先退出 Stream Dock，避免 Windows 锁定插件文件。部署后重新启动 Stream Dock。开发命令识别它自己创建的副本，安装过正式包时应通过 Stream Dock 管理该包。

## 数据、开销和可观察范围

- 命令 Hook 通过本机命名管道发送事件类型、会话和轮次标识及少量必要字段。选择框前后会额外发送调用标识，Stop 可发送会话文件路径。发送脚本随 .sdPlugin 打包。插件启动时在 hooks 子目录中重建固定大小的 endpoint.json。会话状态留在内存中。
- 活动会话表和待查看完成表各最多 128 条。60 分钟没有新信号的会话退出活动计数。完成提醒在插件运行期间保存在内存中。重启后从下一条可识别的 Hook 事件恢复显示，初始显示横线。
- 系统审批由 PermissionRequest 识别，批准后在下一次模型请求或终止时清除。两个工具 Hook 仅在 Codex 执行 `request_user_input` 时触发。普通文字提问、其他客户端交互及云端会话取决于客户端事件覆盖。
- 成功结束时，插件可在后台读取当前 Codex sessions 目录中对应会话文件的最后 512 KiB，核对同一轮的 Plan 模式、计划块和结束记录。符合条件时进入计划等待，其余成功结束生成完成提醒。多个会话共用一个尾读缓冲区。记录未写完时最多重试一次。格式变化、超长轮次和超时可能让计划显示为普通完成。确认后下一轮开始时解除等待。关闭客户端卡片本身可能不产生 Hook。
- 有可见按键和待查看项时，插件监听 Windows 前台事件和 Codex 桌面状态文件 `.codex-global-state.json`。最多每 500 ms 读取一次，文件上限 2 MiB，仅解析 `electron-thread-read-state-v1`。它是桌面版的内部格式。插件观察到同一账户和主机下的未读标记确实被移除时才确认。路径默认为用户的 .codex 目录，支持 CODEX_HOME。读取和监听均复用现有插件进程，提醒清除后停止监听。读取内容不会生成额外状态文件。
- 红灯跟踪模型请求失败，并给重试留出 15 秒。它的覆盖范围由 PostModelRequest 决定。客户端退出、系统休眠、或请求在没有新 Hook 的情况下长时间运行时，显示会在超时后回到空闲。
- 每次 Hook 由一个 Node 短进程处理。插件退出或更新期间，Hook 会在短超时内结束，并允许 Codex 继续工作。在 Stream Dock 3.10.205.0918 和内置 Node 20.8.1 上，对 64 KiB 输入做了 30 次命令链测量。接收端在线时中位数 109.0 ms，P95 119.4 ms。关闭接收端时 P95 118.3 ms，测试期间新增运行文件 0 个。10 次模型尝试的 20 个 Hook 按中位数合计约 2.18 秒。Node 路径含空格时使用 CMD 兼容启动，额外开销以该机器实测为准。可用以下命令复测。

    ~~~powershell
    npm run benchmark -- 'C:\path\to\StreamDock\node\node20.exe'
    ~~~

    基准输出单次中位数、P95、最大耗时和 10 次模型尝试的累计估算。基准针对命令和插件通信，Codex 自身的调度时间应在实机验收时另行核对。

## 验证记录

- 0.3.0 的原生监听在 MiraBox Node 20.8.1 x64 上测量 30 次启停。启动 P95 为 0.129 ms，停止 P95 为 0.428 ms。加载模块并等待事件时，独立测试 Node 的私有提交增加约 0.36 MiB。监听启用时增加一个线程，注销后线程数恢复。约 4.5 秒无切换事件的采样中，进程 CPU 计时未增加。
- 0.2.0 本机迁移后，Codex CLI 0.167.0-alpha.3.2 在项目内外都识别到 7 条已信任的用户级 Hook。一条临时会话中，UserPromptSubmit、PreModelRequest、PostModelRequest、Stop 均成功执行。Codex 报告的单次耗时为 325–363 ms，共 4 个样本。上一节的 119.4 ms P95 来自独立的命令链基准。
- MiraBox N3 实机连接 Stream Dock 3.10.205.0918。使用合成事件核对绿 2、黄 2、红 1、灰 0。实体键已验证可以激活 ChatGPT，黄灯时可打开指定的验证会话。重启后显示未收到 Hook，收到新事件后恢复显示。
- Codex CLI 0.167.0-alpha.3.2 的两条真实测试会话共发出并送达 14 条 Hook 事件，峰值活动计数 2。项目级 Hook 经客户端发现接口核验，全部 7 条识别成功。审批显示与失败延时使用合成事件验证。真实 CLI 测试没有产生系统审批提示，普通提问识别尚未启用。
- 两次 Windows 派发对比中，原 PowerShell 路径为 324–363 ms，直接派发为 160–172 ms。这个数字是启动命令完成时间。新版在 N3 实体键上复测可打开同一会话。

## Acknowledgements

- [MiraBox Stream Dock Plugin SDK](https://github.com/MiraboxSpace/StreamDock-Plugin-SDK) 与 [Plugin Builder](https://github.com/MiraboxSpace/StreamDock-Plugin-Builder) 提供了通信协议、动作生命周期和 Node 插件模板。
- [Codex Traffic Light for Windows](https://github.com/peters385/codex-traffic-light-windows) 的四色状态灯是本项目显示交互的参考。
- [Agent Signal Bar 的原作者 guan-ops](https://github.com/guan-ops) 与 [ridyang 的 Windows 移植](https://github.com/ridyang/Agent-Signal-Bar-Windows) 提供了多会话状态优先级的设计参考。

项目使用 [MIT 许可](LICENCE)。实际使用的模板和分发依赖声明见 [Third-party notices](THIRD_PARTY_NOTICES.md)。
- 开发 0.4.0 时，在本机约 0.81 MiB 的桌面状态文件上做了 30 次热缓存原型对比。只解析未读字段时，解析阶段临时堆增量 P95 从 2.89 MiB 降到 0.21 MiB，耗时 P95 从 3.67 ms 降到 0.65 ms。该测量不包含文件读取、桌面客户端写入或 LCD 刷新。
- 0.4.0 隔离测试中，Codex CLI 0.167.0-alpha.3.2 的内置选择框发出匹配的前后 Hook，插件也从一条本机历史记录识别出计划确认。打包后的插件在模拟 Stream Dock 按键上通过六轮蓝色 2/2、蓝色 1/2、绿色 2。真实桌面侧栏的已读写入和 N3 实体键需要对应会话验证。
- 同一测试中，插件进程的峰值工作集为 48.5 MiB，包含 Windows Node 异步文件线程池时私有提交约 57 MiB。另用实际桌面状态文件反复启停监听 120 次，文件读取加解析的热缓存 P95 为 1.46 ms。监听全部注销后，GC 测量未发现净增的读取缓冲区。
