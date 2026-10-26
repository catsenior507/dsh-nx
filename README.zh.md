# dsh-nx

让 DeepSeek Harness 通过 [nx-auto-mcp](https://github.com/cyw2527/nx-auto-mcp)
驱动 **Siemens NX** 的插件 —— 它不负责"建模"，负责把启动链路变成**可观测、可修复**的。

`nx-auto-mcp` 已经把 123 个 NX 工具通过 MCP 暴露出来，链路通的时候都能用。问题在链路：
**五件事必须同时成立**，任何一件不成立，模型看到的只是一句 `No work part is open.`
或者一张空的 PNG。

| # | 环节 | 断了会看到什么 |
|---|------|----------------|
| 1 | `ugraf.exe` 在运行 | 所有 `nx_*` 工具连不上 |
| 2 | `managed_plugin.dll` 已部署 | 没有菜单、没有监听、**也没有报错** |
| 3 | 这个 DLL 能被加载 | 同样安静 —— NX 拒载未签名插件时不提示 |
| 4 | 插件的 TCP 服务在监听 | 连接被拒 |
| 5 | NX 窗口可渲染 | 截图"成功"但里面什么都没有 |

本插件给 agent 一个工具 `nx`：分别检查这五个环节，并修复其中能从进程外修复的部分。

它**不替代** MCP 服务器：123 个建模工具仍然走 `@deepseek-ai/dsh-mcp-client`。
这里是它们下面那一层。

## 七个动作

| 动作 | 作用 |
|------|------|
| `status` | 五个环节 + 已部署 DLL + 签名状态 + 最新 syslog + 窗口状态，每一行要么是**观测到的**，要么明确标**未知** |
| `call` | 直接经 TCP 调一个插件工具，绕过 MCP 客户端 |
| `tools` | 实时工具清单，理由同上 |
| `launch` | 带上 `UGII_CUSTOM_DIRECTORY_FILE` / `UGII_USER_DIR` 启动 `ugraf.exe`，然后**轮询端口**而不是死等 |
| `focus` | 还原并置前 NX 窗口 |
| `capture` | 置前 → 等待 → 适配视图 → 截图 → **校验文件** |
| `deploy` | 编译、签名、安装托管插件，三步分别报告 |

### 为什么需要 `call`

MCP 客户端只在**连接时**拉一次 `tools/list`。新部署进 NX 的工具在重连前不可见。
`call` 直接和插件通信，永远看到实时清单 —— 而且它报告的是插件实际说的话，
不是某个缓存的工具列表以为的事。

### 为什么 `capture` 要等待

NX 导出的是图形缓冲区，不是重新渲染。窗口正在重绘时（刚还原、刚被遮挡）截图，
NX 会写出一张尺寸正确、内容却是未初始化像素的图，并且**报告成功**。
所以这个动作会置前、等待、适配视图、再等待，最后**测量文件**才认定截图成功。
窗口最小化是同一个故障的另一半：它根本没有可渲染的表面。

### 为什么按进程 ID 找窗口

NX 的标题在 Gateway 状态下是 `NX`，打开零件后是 `零件名 - NX - Gateway`，
其他语言的安装又是别的。而按 `NX` 模糊匹配会误中无关窗口（比如名字带
`SiemensNX-2412` 的资源管理器窗口）。所以窗口按**所属进程**选择，标题片段只用于排序。

## 安装

```powershell
dsh plugin --profile web add D:/deepseek_harness/dsh-nx
```

或者像这个 profile 里其他 `@dsh-external` 插件一样手工链接：

```powershell
# 1. 在 profile 的 node_modules 里建目录联接
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-external\dsh-nx" `
  -Target "D:\deepseek_harness\dsh-nx"

# 2. 加进 profile 的 bundles（package.json → dsh.profile.bundles）
# 3. 重启应用
```

配置写在 `cordis.patch.yml` 插入的那一行上：

```yaml
- insert:
    - id: tool-nx
      name: '@dsh-external/dsh-nx'
      config:
        nxRoot: 'D:\Program Files\Siemens\NX2412'
        nxAutoMcpPath: 'D:\deepseek_harness\ug\_repo'
```

字段全部可选。`nxRoot` 会依次回退到 `UGII_BASE_DIR`、`Program Files` 下的 `NX*` 扫描；
`nxAutoMcpPath` **没有**回退 —— 包位置未知时，唯一诚实的答案就是"未知"。

| 字段 | 默认 | 含义 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `1977` | 插件 TCP 端点 |
| `nxRoot` | 自动探测 | NX 安装根目录 |
| `nxAutoMcpPath` | — | nx-auto-mcp 检出目录（`deploy` 需要） |
| `customDirsFile` | `<nxAutoMcpPath>/custom_dirs.dat` | `launch` 导出的变量 |
| `userDir` | `<nxAutoMcpPath>` | `launch` 导出的 `UGII_USER_DIR` |
| `exePath` | `<nxRoot>/NXBIN/ugraf.exe` | `launch` 启动的程序 |
| `windowTitle` | `NX - Gateway` | `focus`/`capture` 的标题偏好 |
| `callTimeoutMs` | `180000` | 单次 TCP 调用 |
| `launchTimeoutMs` | `240000` | `launch` 等端口的时长 |
| `deployExecTimeoutMs` | `300000` | csc / SignDotNet 超时 |

## 用法

先问状态 —— 这是"插件没加载"和"插件拒绝了"的分界线：

```
nx status
```

调一个 MCP 客户端还没发现的工具：

```
nx call  tool=nx_measure_volume  params={}
```

NX 没开时用正确的方式启动：

```
nx launch
```

截一张**确实有模型**的图：

```
nx capture  imagePath=D:/tmp/nx.png
```

改了插件源码之后重新部署：

```
nx deploy
```

## `deploy` 会说什么、不会说什么

`deploy` 把编译、签名、安装**分开报告**，因为它们失败的原因不同，而只有一个是你的代码问题。

两条在 NX 2412 上踩出来的事实：

- **签名失败，NX 仍可能加载。** `SignDotNet` 向许可服务器要的是 *author* 许可；
  NX 运行时要的是另一种授权。机器可以只有后者 —— 此时 syslog 会对一个未签名 DLL
  写下 `DotNet author license is present. Authentication passed`。
  所以签名失败被如实记为失败，部署继续，结果照实说明，而不是抹平成"部署成功"。
- **`NXSigningResource.res` 在 `UGOPEN` 里**，而只装运行时的 NX 没有这个目录。
  缺它时 DLL 编译时就不带资源包，**根本无法签名** —— 这不是代码问题，也不是本插件能修的。

## 验证

```powershell
npm test                          # 13 个测试：报文格式、配置、选择规则、工具 schema
$env:NX_AUTO_MCP_PATH = 'D:\deepseek_harness\ug\_repo'
node scripts/live-check.mjs       # 对真实 NX；没开时会启动它
```

单元测试用一个假插件跑 TCP 层：真正要钉住的是报文契约，而这不需要许可证、桌面会话
或一个运行中的 CAD。`scripts/live-check.mjs` 是另一半，它会真的启动 NX。

在 NX 2412 / Windows 11（2026-10-26）实测：`launch` 8–12 秒端口就绪，`status` 看到 123 个工具，
`call` 能跑通建模调用，`capture` 得到 17 KB 的模型渲染图。

## 已知限制

- **仅 Windows。** NX 如此，窗口与进程探测也如此。
- **`focus`/`capture` 需要桌面会话。** 处在另一个会话的进程看不到也还原不了 NX 窗口 ——
  动作会明说，而不是静默失败。
- **`deploy` 签不了许可服务器不给的东西。** 见上。
- **`status` 读的是 `%TEMP%` 里最新的 `*.syslog`**，它可能早于当前这次 NX 会话。
  该行会带上日志时间戳，过期读数因此是可见的，而不会被当成现在。

## 许可

MIT。与 Siemens、与 nx-auto-mcp 均无隶属关系。
