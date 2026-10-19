// 程序员常用小技巧（离线数据，随机展示）
// 来源：GitHub 官方文档、开发者社区通用经验整理
export const DEV_TIPS: string[] = [
  'GitHub 快捷跳转：任意仓库按 `T` 打开模糊文件搜索，秒找文件。',
  'GitHub 代码分享：链接末尾加 `#L10-L20`，直接定位到指定行区间。',
  'GitHub 命令面板：按 `Ctrl+K`（Mac 为 `Cmd+K`）打开，所有操作不用鼠标。',
  'GitHub 键盘流：`G C` 跳到 Code、`G I` 跳 Issues、`G P` 跳 Pull Requests、`G A` 跳 Actions。',
  'GitHub 比较分支：`仓库/compare/main...dev` 直接看两个分支的差异。',
  'Git 撤销上一次提交但不丢改动：`git reset --soft HEAD~1`。',
  'Git 只看本次改动文件：`git diff --name-only`，省去一长串输出。',
  'Git 查看提交历史树：`git log --oneline --graph --all`，分支一目了然。',
  'Git 别名提效：`git config --global alias.s "status -s"`，之后 `git s` 即简版状态。',
  'Git 暂存部分改动：`git add -p` 逐块选择，提交更干净。',
  'Git 删除本地已合并分支：`git branch --merged | xargs git branch -d`，清理利器。',
  'Git 找回误删分支：`git reflog` 找到 SHA 后 `git branch 名字 <SHA>` 恢复。',
  'VS Code 快速打开文件：`Ctrl+P` 输入文件名模糊搜索，比点文件树快 10 倍。',
  'VS Code 多光标编辑：按住 `Alt` 点击多位置，或 `Ctrl+Alt+↓` 向下加光标。',
  'VS Code 全文件替换变量名：选中后按 `F2`，自动重构所有引用。',
  'VS Code 命令面板：`Ctrl+Shift+P` 输入命令，几乎所有操作都能搜到。',
  'VS Code 快速跳定义：`F12` 跳到定义，`Alt+F12` 悬浮预览。',
  '终端快速清屏：`Ctrl+L` 而不是反复敲 `clear`。',
  '终端历史搜索：`Ctrl+R` 反向搜索之前敲过的命令，不再重复输入。',
  '终端命令中止：`Ctrl+C` 强制结束当前进程；`Ctrl+D` 退出当前 shell。',
  '终端管道三剑客：`grep` 过滤、`sed` 替换、`awk` 取列，组合起来无敌。',
  'Windows 剪贴板历史：`Win+V` 查看并粘贴历史剪贴板（需先在设置中开启）。',
  'Windows 快速切换窗口：`Alt+Tab` 已过时？试试 `Win+数字键` 直接切到任务栏对应应用。',
  'Windows 虚拟桌面：`Win+Ctrl+D` 新建桌面、`Win+Ctrl+←/→` 切换，写代码和摸鱼分开。',
  'PowerShell 查看命令来源：`Get-Command git | Select Source`，搞清跑的是哪个。',
  'PowerShell 快速打开当前目录资源管理器：`start .`（或 `ii .`）。',
  '错误优先排障法：先看报错第一行和最后 20 行日志，再动手改代码。',
  '写代码前先写注释：把思路写成 TODO 注释，再逐条实现，思路清晰不迷路。',
  '版本号语义化：主版本.次版本.补丁（如 1.4.2），破坏性变更升主版本。',
  'Commit 信息规范：`feat: 新增功能` / `fix: 修复bug` / `refactor: 重构`，配一句具体描述。',
  '环境变量别硬编码：敏感信息走 `.env` 文件并加入 `.gitignore`。',
  '看到重复代码先停下来：三处以上重复就该抽函数或组件了。',
];

export function randomTip(): string {
  return DEV_TIPS[Math.floor(Math.random() * DEV_TIPS.length)] ?? DEV_TIPS[0] ?? '';
}
