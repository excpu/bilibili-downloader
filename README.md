# bilibili-downloader
开箱即用的 BiliBili 下载器  
本项目是一个基于 Node.js 和 Electron 构建的跨平台BiliBili下载工具，支持所有主流操作系统。
![主界面展示](images/image.png)

## 🔧 功能
### 已经实现功能
* 视频下载
* 分P视频下载
* 弹幕下载
* 封面下载

### 开发中功能
* 字幕下载

### 实验性功能
* Windows on ARM 支持


## ⚡ 快速体验

### Windows
从 Release 中下载 bilibili.Setup.x.x.x.exe 后执行正常安装流程即可
Windows 已经经实验性支持 ARM64 共用同一个安装包，暂无设备测试

### Linux
#### 从 Release 中下载支持的发行版包，目前支持：
rpm  
deb  
AppImage  
#### Linux支持多种架构
amd64  
arm64  
~~armv7l（仅 AppImage）~~

### Mac
MAC 版本无签名，需要命令行处理或从本地开发环境运行
#### 从Release下载并使用命令行处理
**1. 下载ZIP软件包，方便后续处理**  
注意区分Intel版和AppleSilicon（ARM64）版本  
Apple芯片版  
![ARM版](images/image-2.png)  
Intel版  
![Intel版](images/image-3.png)  
**2. 解压ZIP获取.app包**  
**3. 使用命令行去除互联网下载标签**  
输入（注意空格）
``` bash
xattr -cr 
```
后拖入.app 包并回车
**4. 移入Application并且开始使用**  
#### 从本地开发环境运行
见教程


## 🚀 本地开发环境运行指南
### 🛠️ 环境准备 (Prerequisites)
在开始之前，请确保你的开发环境已安装以下软件：

* **Node.js**: 推荐使用 [LTS 版本](https://nodejs.org/) (v22.x)。
* **Git**: 用于克隆项目仓库。（可选从Github下载ZIP）

### 📥下载项目
#### 使用git
``` bash
cd path/to/your/folder
git clone https://github.com/excpu/bilibili-downloader.git
cd bilibili-downloader
```
#### 使用ZIP
解压ZIP
``` bash
cd bilibili-downloader
```

### 📦安装依赖
``` bash
npm install
```

### ▶️开发环境运行或自己打包
#### 开发环境运行
``` bash
npm run start
```
#### 自行打包
``` bash
npm run build
```
打包后文件会出现在 dist 目录中

## 🐞 Bug、意见反馈和帮助
### Bug
使用Issue并添加 bug TAG
### 功能意见
使用Issue并添加 enhancement TAG
### 需要帮助
使用Discussion功能发布帮助请求
#
**额外申明**  
该项目仅供学习研究使用，请勿用于非法用途  
项目仅用于可用BiliBili客户端缓存的视频，不支持版权内容的下载  
联系删除：contact@5share.site