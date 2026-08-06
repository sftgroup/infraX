---
name: "browser-tester"
description: "Three-tier browser testing stack for InfraX: playwright-cli (fast daily testing), @playwright/mcp (AI agent MCP integration), chrome-devtools-mcp (performance debugging). Invoke for any browser testing, E2E flows, or frontend debugging."
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(chrome-devtools-mcp:*)
---

# InfraX Browser Tester — 三层浏览器测试栈

## 工具选择决策树

```
你要做什么？
│
├─ 日常快速测试 / 页面快照 / 简单交互
│  → playwright-cli  （快、省 token、无 MCP 开销）
│
├─ AI Agent 集成 / MCP 协议 / 结构化页面操作
│  → @playwright/mcp  （MCP 服务器、accessibility 快照）
│
└─ 性能排查 / 网络分析 / Core Web Vitals
   → chrome-devtools-mcp  （DevTools 深度检查）
```

---

## 三层工具对照

| | playwright-cli | @playwright/mcp | chrome-devtools-mcp |
|---|---|---|---|
| **定位** | 日常测试 | MCP 集成 | 性能排查 |
| **安装** | `npm i -g @playwright/cli` | `npm i -g @playwright/mcp` | `npm i -g chrome-devtools-mcp` |
| **启动** | `playwright-cli open` | `npx @playwright/mcp` | `npx chrome-devtools-mcp` |
| **协议** | CLI 命令 | MCP (stdio/SSE) | MCP (stdio) |
| **浏览器** | Chromium/Firefox/WebKit | Chromium/Firefox/WebKit | Chrome/Chromium |
| **快照方式** | YAML 文本 | Accessibility tree | 截图 + DOM |
| **网络检查** | `requests` / `request N` | `browser_network_requests` | 完整 HAR |
| **性能分析** | 基础 | 无 | Core Web Vitals + Tracing |
| **代码执行** | `eval` + `run-code` | `browser_run_code` | JS Console |
| **Token 消耗** | 低 | 中 | 高 |
| **适用场景** | 快速回归测试 | AI 自动化工作流 | 深度性能排障 |

---

## 一、playwright-cli — 日常快速测试

**何时用**: 快速打开页面、点几下、截个快照、检查 console。不需要 MCP 服务器。

### 安装验证

```bash
playwright-cli --version
# 已安装: global | 浏览器: /root/.cache/ms-playwright/chromium-1232
```

### 常用命令速查

```bash
# 生命周期
playwright-cli open https://infrax.0xainet.top/index.html
playwright-cli close
playwright-cli close-all

# 页面交互
playwright-cli snapshot                      # 获取页面 ref 列表
playwright-cli click e15                     # 点击 ref
playwright-cli fill e7 "value" --submit      # 填表提交
playwright-cli type "search text"            # 键盘输入
playwright-cli find "Sign in"                # 搜索快照文本

# JS 执行
playwright-cli eval "document.title"
playwright-cli eval "el => el.textContent" e5
playwright-cli run-code "async page => { return await page.title(); }"

# 检查
playwright-cli console                       # 所有 console 消息
playwright-cli console warning               # 仅 warning+
playwright-cli requests                      # 网络请求列表
playwright-cli request 5                     # 第 5 个请求详情

# 截图
playwright-cli screenshot                    # 全页
playwright-cli screenshot e15                # 元素

# 标签页
playwright-cli tab-new http://...
playwright-cli tab-list
playwright-cli tab-select 0

# 存储
playwright-cli state-save auth.json
playwright-cli state-load auth.json
playwright-cli localstorage-set token abc123
```

---

## 二、@playwright/mcp — AI Agent MCP 集成

**何时用**: 需要 AI Agent 通过 MCP 协议控制浏览器。提供结构化 accessibility 快照（非截图），LLM 可以直接理解页面结构。

### MCP 客户端配置

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### InfraX 专用启动参数

```bash
# Headless 模式（服务器环境）
npx @playwright/mcp@latest \
  --headless \
  --no-sandbox \
  --viewport-size=1280x720 \
  --browser=chrome \
  --isolated \
  --console-level=warning \
  --timeout-action=10000

# Headed 模式（本地调试，有显示器）
npx @playwright/mcp@latest \
  --browser=chrome \
  --viewport-size=1280x720

# 持久化会话（保存登录状态）
npx @playwright/mcp@latest \
  --browser=chrome \
  --save-session \
  --output-dir=/tmp/infrax-mcp-sessions

# 连接已有浏览器
npx @playwright/mcp@latest \
  --cdp-endpoint=http://localhost:9222
```

### 关键工具

| MCP Tool | 功能 |
|----------|------|
| `browser_navigate` | 导航到 URL |
| `browser_snapshot` | 获取 accessibility 快照 |
| `browser_click` | 点击元素 (by ref) |
| `browser_type` | 键盘输入 |
| `browser_fill_form` | 批量填表 |
| `browser_take_screenshot` | 截图 |
| `browser_console_messages` | 读取 console |
| `browser_network_requests` | 网络请求 |
| `browser_run_code` | 执行 Playwright 代码 |
| `browser_tabs` | 标签页管理 |
| `browser_evaluate` | JavaScript 求值 |

---

## 三、chrome-devtools-mcp — 性能排查

**何时用**: 页面加载慢、JS 内存泄漏、网络请求异常、Core Web Vitals 不达标。需要 Chrome DevTools 的完整能力。

### InfraX 专用启动参数

```bash
# 性能排查模式
npx chrome-devtools-mcp@latest \
  --headless \
  --chrome-arg='--no-sandbox' \
  --chrome-arg='--disable-setuid-sandbox' \
  --viewport=1280x720 \
  --isolated \
  --logFile=/tmp/infrax-cdt-mcp.log

# 连接已有 Chrome
npx chrome-devtools-mcp@latest \
  --browserUrl=http://localhost:9222

# 性能 + 截图优化
npx chrome-devtools-mcp@latest \
  --headless \
  --viewport=1280x720 \
  --screenshot-format=jpeg \
  --screenshot-quality=80
```

### 核心能力

| 类别 | 工具 |
|------|------|
| **网络** | 请求/响应头体、时序瀑布图、HAR 导出 |
| **性能** | Core Web Vitals (LCP/FID/CLS)、JS Profiling、Tracing |
| **DOM** | 元素检查、样式计算、CSS 覆盖 |
| **Console** | 完整日志 + 堆栈 |
| **截图** | 全页/元素/Jpeg 压缩 |
| **内存** | 堆快照、内存时间线 |

---

## InfraX 测试配置

### 目标 URL

```
Production:   https://infrax.0xainet.top          # 域名根（当前 / 200；/api/* 502 待修，portal 不受影响）
Landing:      https://infrax.0xainet.top/landing.html
Connect:      https://infrax.0xainet.top/connect.html
Admin:        https://infrax.0xainet.top/admin-login.html
Dashboard:    https://infrax.0xainet.top/index.html
# 域名异常时直连 IP 兜底（-k + Host 头）：
#   curl -k -H 'Host: infrax.0xainet.top' https://43.163.105.172/landing.html
```

### 测试钱包

```
EOA:       0x2ba20a76af1297d4ef9bd242866f690aceaab9f1
PK:        0xb1eb7c5b3ad9ea36d62e744c4bd07dfb99b0605c2675faaaf8f9c4121ecd8644
MPC Addr:  0xA39fDC3396e74979045C961484FaFe014Aa4B579
```

### Admin

```
Username:  admin
Password:  a87cefd6e1ce487334a67b0c
```

---

## E2E 测试流程

### Flow 1: 私钥登录 (playwright-cli)

```bash
playwright-cli open https://infrax.0xainet.top/index.html
sleep 3
playwright-cli snapshot
playwright-cli find "Private Key"
# 根据快照 ref 操作...
playwright-cli close
```

### Flow 2: 模块遍历 (playwright-cli)

```bash
playwright-cli open https://infrax.0xainet.top/index.html
sleep 3
for mod in mpc waas safe dc pay; do
  playwright-cli click "[data-page='$mod']"
  sleep 1
  playwright-cli snapshot --filename="snap-${mod}.yml"
done
playwright-cli close
```

### Flow 3: MCP Agent 自动化 (@playwright/mcp)

```
# AI Agent 通过 MCP 协议发送:
browser_navigate → https://infrax.0xainet.top/index.html
browser_snapshot → 获取页面结构
browser_click → Private Key tab
browser_type → 输入私钥
browser_click → Connect 按钮
browser_snapshot → 验证 Dashboard 渲染
```

### Flow 4: 性能排查 (chrome-devtools-mcp)

```bash
# 启动 MCP，Agent 连接后:
# 1. navigate to InfraX
# 2. take_screenshot
# 3. performance_start_trace
# 4. 用户操作...
# 5. performance_stop_trace
# 6. 分析 LCP / FID / CLS
```

---

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `INFRAX_URL` | `https://infrax.0xainet.top` | 测试目标 |
| `INFRAX_PK` | `0xb1eb7c5...cd8644` | 测试私钥 |
| `ADMIN_PASS` | `a87cefd6e1ce487334a67b0c` | Admin 密码 |

## 已知限制

- MetaMask 弹窗无法自动确认（需真实钱包）
- Headless 模式 Web3 连接行为可能有差异
- Safe Vault 部署需区块链签名 — 无法完全自动化
- chrome-devtools-mcp 仅支持 Chrome/Chromium

## 参考文件

- `test-reports/INFRAX_TEST_P7_USER_JOURNEYS.md` — E2E 场景
- `test-reports/E2E_TEST_REPORT.md` — 历史结果
- `projects/web/test/browser-test.sh` — 快捷 wrapper
- `~/.claude/skills/playwright-cli/` — playwright-cli 完整文档
- https://github.com/microsoft/playwright-mcp — @playwright/mcp 源码
- https://github.com/ChromeDevTools/chrome-devtools-mcp — chrome-devtools-mcp
