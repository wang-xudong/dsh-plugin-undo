# dsh-plugin-undo

DeepSeek Harness 会话撤回插件：在当前会话内撤销最后 n 轮对话，不新建会话、不改动项目文件。

## 为什么选择本插件

多数“回退对话”插件通过 `sessions.fork` 把历史前缀复制成一个**新会话**（原会话保留或归档）。本插件直接在当前 session 的 surface 上**原地撤销**，因此：

- **不 fork、不新建会话**，session id 保持不变
- 侧栏不会出现“原会话 + 新会话”两个近似会话
- 继续在当前会话中对话，模型上下文就是撤销后的保留历史

## 功能

- `/undo` 或 `/undo 1`：撤销最近 1 轮
- `/undo 3`：撤销最近 3 轮
- `/undo all`：撤销当前模型可见的全部轮次

撤销后：

- 模型可见历史被替换为“保留轮次”，被撤销的轮次不再进入模型上下文
- 原始会话日志保持 append-only，不做任何改写
- Web UI 自动折叠被撤销的轮次，只显示一行小标题
- 不新建 session，当前会话继续对话

## 效果

被撤销的轮次在页面中折叠为：

```text
↩ 第 N 轮已撤销 · 点击展开
```

点击该标题可在当前页面展开/折叠被撤销的轮次。`/undo` 命令卡片本身会被隐藏，折叠标题是唯一的撤销反馈。

## 原理

1. 插件按 `turn/start` / `turn/end` 计算当前模型可见的轮次
2. 取最后 n 轮，在其 surface 范围上追加一条 `surfaceOp: { op: 'replace', start, end }`
3. 该检查点是一条**空 assistant 消息**（位于任何 turn 之外），消息派生时会被跳过，因此模型只看到保留后的历史，不会看到任何撤销标记或轮次数字
4. 客户端读取 `/undo` 命令结果，用 DOM/CSS 折叠对应轮次

## 安装

```bash
dsh plugin --profile <profile> add file:/path/to/dsh-plugin-undo
```

重启对应 profile：

```bash
dsh --profile <profile>
```

安装后无需额外配置。

## 使用

在会话输入框中输入：

```text
/undo
/undo 1
/undo 3
/undo all
```

注意：撤销要求会话空闲。如果当前有正在运行的轮次，请先停止再执行 `/undo`。

## 构建与打包

发布入口在 `lib/`，源码在 `src/`。构建并生成 tarball：

```bash
npm run build
npm pack
```

会生成 `dsh-plugin-undo-<version>.tgz`，也可直接安装 tarball：

```bash
dsh plugin --profile <profile> add file:/path/to/dsh-plugin-undo-<version>.tgz
```

## 目录结构

```text
dsh-plugin-undo/
├── README.md
├── README_zh.md
├── cordis.patch.yml
├── package.json
├── scripts/
│   └── build.mjs
├── src/          # 源码
│   ├── index.js  # Host：/undo 命令与 surface replacement
│   └── client.js # Web：折叠被撤销轮次、隐藏命令卡片
└── lib/          # 构建产物（由 npm run build 生成）
```

## 许可证

本项目使用 [MIT](./LICENSE) 协议。

## 限制

- 只能撤销“最近连续 n 轮”，不支持指定中间某一条消息
- 只回退模型可见的对话历史，不回退项目文件
- 需要会话空闲时执行
