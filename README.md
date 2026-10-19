# 小宝桌宠 (Xiaobao Desktop Pet)

基于 Electron + TypeScript 的桌面宠物应用，角色为用户自家马士提夫犬「小宝」的写实重建。

## 版本结构

- `v1/` — 基础版：角色互动（挠下巴 / 喂磨牙棒 / 握手 / 睡觉）、桌面走动、系统状态监控、程序员技巧
- `v2/` — 升级版：新增作息模式（白天自主散步/吃磨牙棒，夜晚 22:00–8:00 自动入睡、手动唤醒）、全趴睡动画（无站起帧）

## 运行

需要 Node.js 18+ 与 npm：

```bash
npm ci          # 安装锁定依赖
npm run check   # 静态与素材检查
npm run dev     # 源码开发预览
npm run package:win   # Windows 可运行 EXE（依赖同目录文件，不能单独拷走 EXE）
```

## 说明

- 素材 `src/assets/pet/*.png` 为本地生成产物（AI 生图 + 语义抠图），因体积与二进制限制未包含在仓库中，需按 `pet-spec.json` 重新生成。
- 各版本均带独立 `pet-spec.json`，是角色、状态、互动与素材的唯一真值。
