# 新御书屋小说下载器

[![Version](https://img.shields.io/badge/version-2.6.0-16794b)](https://github.com/Blackwindow6/qianyezw-novel-downloader/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Validate Userscript](https://github.com/Blackwindow6/qianyezw-novel-downloader/actions/workflows/validate.yml/badge.svg)](https://github.com/Blackwindow6/qianyezw-novel-downloader/actions/workflows/validate.yml)

一个兼容电脑和手机油猴扩展的新御书屋小说下载器，可以把整本小说一键保存为排版清晰的 TXT 文件。

## 功能

- 一键下载整本小说，不限制章节数和分页数
- 保留原文自然段、换行和章节顺序
- 自动拼接被网站拆分的章节分页
- 按设备限制并发速度，并以 40 个请求为一批自动续期站点会话
- 网络失败、限流或页面异常时持续重试，直到成功或用户取消
- 自动识别站点安全验证，在会话失效后续期并重试请求
- 下载前重新获取最新目录，避免使用缓存中的过期章节列表
- 识别网站空白末页、标题型通知和异常 HTML 残片
- 完整性检查不通过时，不会把缺章文件伪装成完整小说
- 支持 `GM.download`、`GM_download` 和浏览器原生下载

## 安装

先在浏览器中安装一个用户脚本扩展，例如 Tampermonkey、Violentmonkey 或 ScriptCat。

[点击安装新御书屋小说下载器](https://raw.githubusercontent.com/Blackwindow6/qianyezw-novel-downloader/main/qianyezw-downloader.user.js)

打开安装链接后，在扩展显示的页面中确认安装即可。

## 使用方法

1. 打开新御书屋的小说目录页面，例如 `https://www.qianyezw.com/book/12251/`。
2. 点击页面右下角的“下载整本 TXT”。
3. 等待状态显示“已保存 全部章节”。
4. 在浏览器的下载目录中找到生成的 TXT 文件。

下载期间不要关闭当前小说页面。点击状态栏右侧的关闭按钮可以取消任务，并保存已经完成的章节。

## 手机端

脚本针对手机浏览器做了单独适配：

- 手机端最多使用 4 路并发，减少浏览器卡死和随机缺章
- 按钮使用适合触摸操作的尺寸，并适配全面屏安全区域
- 下载界面使用隔离样式，避免被网页样式覆盖或移除
- 优先调用扩展提供的下载接口，不支持时自动交给浏览器保存
- 不依赖部分旧移动内核缺少的 `AbortSignal.any` 和 `AbortSignal.timeout`

可用于支持用户脚本扩展的 Android 浏览器。实际文件保存位置由浏览器或脚本扩展决定。

## 下载完整性

网络错误会自动重试，不设置重试次数上限。只有非法章节地址、404 或无法识别的分页结构等永久错误才会终止任务。正常下载出现永久错误时，脚本不会生成缺章 TXT；用户主动取消时，可以保存已完成部分。

## 开发检查

```bash
node --check qianyezw-downloader.user.js
npx --yes prettier@3.6.2 --check qianyezw-downloader.user.js
```

## 声明

本项目仅提供网页内容整理和个人备份工具。请遵守网站服务条款及所在地法律法规，并尊重作者和内容权利人的合法权益。

## License

[MIT](LICENSE)
