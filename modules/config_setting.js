const { app } = require('electron');
const fs = require('fs');
const path = require('path');


// 配置文件保存在 config.json 不加密，和认证文件分开
class Setting{
    constructor(){
        this.settingFilePath = path.join(app.getPath('userData'), 'config.json');
    }
}