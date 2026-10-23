/**
 * Bilibili XML 弹幕转 ASS 字幕转换器（纯算术查表测宽版）
 * 零外部依赖，兼容 Node.js / Electron / Browser Worker
 */

// ASCII 字符（0-127）相对于 fontSize 的宽度系数表（基于黑体/微软雅黑等无衬线体实测微调）
const ASCII_WIDTH_RATIO = [
    // 0-31 控制字符
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // 32-47: 空格 ! " # $ % & ' ( ) * + , - . /
    0.32, 0.35, 0.45, 0.65, 0.65, 0.88, 0.72, 0.30, 0.40, 0.40, 0.50, 0.65, 0.32, 0.42, 0.32, 0.42,
    // 48-57: 0-9
    0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62,
    // 58-64: : ; < = > ? @
    0.35, 0.35, 0.65, 0.65, 0.65, 0.55, 0.92,
    // 65-90: A-Z
    0.72, 0.70, 0.72, 0.75, 0.65, 0.62, 0.78, 0.75, 0.35, 0.52, 0.70, 0.60, 0.88,
    0.75, 0.78, 0.68, 0.78, 0.70, 0.68, 0.65, 0.75, 0.70, 0.98, 0.70, 0.68, 0.65,
    // 91-96: [ \ ] ^ _ `
    0.40, 0.42, 0.40, 0.60, 0.60, 0.40,
    // 97-122: a-z
    0.58, 0.60, 0.55, 0.60, 0.58, 0.38, 0.60, 0.60, 0.28, 0.30, 0.55, 0.28, 0.88,
    0.60, 0.60, 0.60, 0.60, 0.42, 0.52, 0.38, 0.60, 0.52, 0.82, 0.55, 0.55, 0.52,
    // 123-127: { | } ~ DEL
    0.42, 0.35, 0.42, 0.65, 0
];

// 默认配置项（贴合 B 站 1080P 播放器表现）
const DEFAULT_OPTIONS = {
    // 画布分辨率
    resX: 1920,
    resY: 1080,

    // 字体与排版样式
    fontName: 'Microsoft YaHei', // 默认字体（推荐微软雅黑、黑体或思源黑体）
    fontSize: 38,                // 基准字号（对应 XML 中的 25 号标准字）
    scaleFontSize: true,         // 是否根据 XML 原始字号（如 18 小字、36 大字）等比缩放
    bold: false,                  // 是否粗体（B站默认带一定字重，开启后抗锯齿更清晰）
    opacity: 0.80,               // 不透明度 (0.0 ~ 1.0)，0.8 为 B 站经典默认值
    outlineWidth: 1.5,           // 描边宽度（像素）
    shadowDepth: 0.0,            // 阴影深度（像素，B站默认无阴影或极浅阴影）
    lineSpacing: 6,              // 轨道行间距（像素）
    marginTop: 10,               // 顶部留白（像素）
    marginBottom: 10,            // 底部留白（像素）

    // 显示区域与运动耗时
    scrollArea: 0.75,            // 滚动弹幕占屏比 (0.0 ~ 1.0)，如 0.75 表示 3/4 屏
    fixedArea: 0.50,             // 顶部/底部固定弹幕占屏比 (0.0 ~ 1.0)
    scrollDuration: 12.0,        // 普通弹幕滚动穿越屏幕的基础耗时（秒）
    fixedDuration: 5.0,          // 顶部/底部弹幕停留耗时（秒）

    // 碰撞检测与防重叠控制
    horizontalPadding: 20,       // 同轨前后弹幕最小安全间距（像素，同时吸收测宽误差）
    allowOverlap: false,         // 轨道全满时是否允许重叠（false: 丢弃溢出弹幕；true: 选重叠最小的轨道强行挤入）
    maxOverlapOffset: 1.5,       // 若不丢弃，最大允许延后等待入轨的时间偏移（秒，0 表示不等待直接重叠或丢弃）

    // 时间轴与内容过滤
    timeOffset: 0.0,             // 全局时间轴偏移（秒，正数延后，负数提前）
    blockModes: [],              // 屏蔽的模式数组：1/2/3(滚动), 4(底部), 5(顶部), 6(逆向)
    blockColor: false,           // 是否屏蔽所有非白色（彩色）弹幕
    blockRegex: null,            // 正则屏蔽词（如 /剧透|打卡/i）
    deduplicate: true,           // 是否合并屏蔽短时间内的完全重复刷屏弹幕
    deduplicateWindow: 5.0       // 重复弹幕判定时间窗口（秒）
};

/**
 * 估算单条弹幕的像素宽度
 */
function estimateTextWidth(text, fontSize, padding = 20) {
    let emUnits = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0 && code <= 127) {
            emUnits += ASCII_WIDTH_RATIO[code];
        } else if (code >= 0xff61 && code <= 0xff9f) {
            // 半角日文片假名
            emUnits += 0.55;
        } else {
            // 汉字、全角标点、Emoji 等统一按 1.0 em 计算
            // 若为 UTF-16 代理对（如部分 Emoji），跳过低位代理避免算作两个字宽
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
                i++;
            }
            emUnits += 1.0;
        }
    }
    return Math.ceil(emUnits * fontSize) + padding;
}

/**
 * XML 实体反转义与 ASS 特殊字符清洗
 */
function cleanDanmakuText(rawText) {
    return rawText
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        // 剔除换行符，并将 ASS 控制括号替换为全角括号防止注入破坏标签
        .replace(/[\r\n]+/g, ' ')
        .replace(/\{/g, '｛')
        .replace(/\}/g, '｝')
        .trim();
}

/**
 * 秒数转 ASS 时间戳格式 (H:MM:SS.cc)
 */
function formatAssTime(seconds) {
    const safeSec = Math.max(0, seconds);
    const totalCs = Math.round(safeSec * 100);
    const cs = totalCs % 100;
    const totalS = Math.floor(totalCs / 100);
    const s = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const m = totalM % 60;
    const h = Math.floor(totalM / 60);

    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * 十进制 RGB 转 ASS 颜色 (&HBBGGRR&) 并判定是否为深色（B站深色弹幕会自动切换为白色描边）
 */
function parseColor(decColor) {
    const r = (decColor >> 16) & 0xff;
    const g = (decColor >> 8) & 0xff;
    const b = decColor & 0xff;

    const hexB = b.toString(16).padStart(2, '0').toUpperCase();
    const hexG = g.toString(16).padStart(2, '0').toUpperCase();
    const hexR = r.toString(16).padStart(2, '0').toUpperCase();

    // 使用 ITU-R BT.601 感知亮度公式计算明度，低于 45 时判定为暗色文字，需配白色描边
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const isDark = luminance < 45;

    return {
        assColor: `&H${hexB}${hexG}${hexR}&`,
        isWhite: decColor === 16777215,
        isDark
    };
}

/**
 * 解析 Bilibili XML 字符串为结构化弹幕数组
 */
function parseBiliXml(xmlString) {
    const danmakus = [];
    // 匹配 <d p="...">内容</d>
    const regex = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/gi;
    let match;

    while ((match = regex.exec(xmlString)) !== null) {
        const pParts = match[1].split(',');
        if (pParts.length < 4) continue;

        // 兼容标准 B 站 8 参数格式与新版 Proto 导出带 rowId 前缀的 9 参数格式
        // 标准格式：p[0]=时间(含小数), p[1]=模式(1-9), p[2]=字号, p[3]=颜色
        const offset = (pParts.length >= 9 && !pParts[0].includes('.') && pParts[1].includes('.')) ? 1 : 0;

        const time = parseFloat(pParts[offset]);
        const mode = parseInt(pParts[offset + 1], 10);
        const xmlSize = parseInt(pParts[offset + 2], 10);
        const color = parseInt(pParts[offset + 3], 10);

        if (isNaN(time) || isNaN(mode)) continue;

        const text = cleanDanmakuText(match[2]);
        if (!text) continue;

        danmakus.push({ time, mode, xmlSize: xmlSize || 25, color: isNaN(color) ? 16777215 : color, text });
    }

    // 按出现时间升序排列
    danmakus.sort((a, b) => a.time - b.time);
    return danmakus;
}

/**
 * 主转换函数：将 Bilibili XML 转换为 ASS 字符串
 * @param {string} xmlString 原始 XML 文本
 * @param {Partial<typeof DEFAULT_OPTIONS>} userOptions 自定义配置项
 * @returns {{ assContent: string, stats: object }}
 */
function convertXmlToAss(xmlString, userOptions = {}) {
    const opt = { ...DEFAULT_OPTIONS, ...userOptions };
    const rawList = parseBiliXml(xmlString);

    const stats = {
        totalParsed: rawList.length,
        rendered: 0,
        droppedOverlap: 0,
        filteredMode: 0,
        filteredRegexOrDup: 0
    };

    // 计算可用轨道数
    const trackHeight = opt.fontSize + opt.lineSpacing;
    const usableHeight = Math.max(trackHeight, opt.resY - opt.marginTop - opt.marginBottom);
    const maxScrollTracks = Math.max(1, Math.floor((usableHeight * opt.scrollArea) / trackHeight));
    const maxFixedTracks = Math.max(1, Math.floor((usableHeight * opt.fixedArea) / trackHeight));

    // 初始化轨道状态表
    // 滚动轨道记录：{ startTime, width, speed, leaveTime }
    const scrollTracks = new Array(maxScrollTracks).fill(null);
    const reverseTracks = new Array(maxScrollTracks).fill(null);
    // 顶部/底部固定轨道仅需记录轨道释放时间戳：number (freeTime)
    const topTracks = new Array(maxFixedTracks).fill(0);
    const bottomTracks = new Array(maxFixedTracks).fill(0);

    // 刷屏去重缓存 Map: text -> lastTime
    const recentTextMap = new Map();

    const dialogues = [];

    for (const item of rawList) {
        // 1. 剔除特殊弹幕（Mode 7/8/9）及不在支持列表中的模式
        if (item.mode < 1 || item.mode > 6) {
            stats.filteredMode++;
            continue;
        }

        // 2. 模式与颜色过滤
        if (opt.blockModes.includes(item.mode)) {
            stats.filteredMode++;
            continue;
        }
        if (opt.blockColor && item.color !== 16777215) {
            stats.filteredMode++;
            continue;
        }

        // 3. 正则屏蔽与防刷屏去重
        if (opt.blockRegex && opt.blockRegex.test(item.text)) {
            stats.filteredRegexOrDup++;
            continue;
        }

        const baseTime = item.time + opt.timeOffset;
        if (baseTime < 0) continue;

        if (opt.deduplicate) {
            const lastSeen = recentTextMap.get(item.text);
            if (lastSeen !== undefined && (baseTime - lastSeen) < opt.deduplicateWindow) {
                stats.filteredRegexOrDup++;
                continue;
            }
            recentTextMap.set(item.text, baseTime);
        }

        // 4. 计算实际渲染字号与预估像素宽度
        const actualFontSize = opt.scaleFontSize
            ? Math.max(12, Math.round((item.xmlSize / 25) * opt.fontSize))
            : opt.fontSize;

        const width = estimateTextWidth(item.text, actualFontSize, opt.horizontalPadding);
        const colorInfo = parseColor(item.color);

        // 组装内联样式覆盖标签（仅在偏离默认样式时才写入，大幅减小 ASS 文件体积）
        let styleOverride = '';
        if (actualFontSize !== opt.fontSize) {
            styleOverride += `\\fs${actualFontSize}`;
        }
        if (!colorInfo.isWhite) {
            styleOverride += `\\c${colorInfo.assColor}`;
        }
        if (colorInfo.isDark) {
            // B站特性：深色字体自动切换为白色边框保证可见度
            styleOverride += `\\3c&HFFFFFF&`;
        }

        // 5. 轨道分配与碰撞检测
        if (item.mode === 1 || item.mode === 2 || item.mode === 3 || item.mode === 6) {
            const isReverse = item.mode === 6;
            const tracks = isReverse ? reverseTracks : scrollTracks;
            const speed = (opt.resX + width) / opt.scrollDuration;

            let chosenTrack = -1;
            let actualStartTime = baseTime;
            let minWaitTime = Infinity;
            let bestWaitTrack = 0;

            for (let i = 0; i < tracks.length; i++) {
                const prev = tracks[i];
                // 逆向弹幕与普通滚动弹幕共用同一 y 轨道，方向相反会正面相撞，
                // 必须等待对向弹幕完全离场后本轨道才可用
                const opposite = (isReverse ? scrollTracks : reverseTracks)[i];

                // 计算在当前轨道上不发生碰撞所需的最早出发时间
                let requiredStartTime = baseTime;
                if (prev) {
                    // 约束 1：前车尾部完全进入屏幕（加上安全间距已在 prev.width 中体现）
                    const earliestForEntry = prev.startTime + (prev.width / prev.speed);
                    // 约束 2：前车完全离开屏幕前，后车车头不能追上前车车尾
                    const earliestForExit = prev.leaveTime - (opt.resX / speed);
                    requiredStartTime = Math.max(requiredStartTime, earliestForEntry, earliestForExit);
                }
                if (opposite) {
                    requiredStartTime = Math.max(requiredStartTime, opposite.leaveTime);
                }

                const waitTime = requiredStartTime - baseTime;

                if (waitTime <= 0.001) {
                    // 无需等待，当前轨道立即可用
                    chosenTrack = i;
                    actualStartTime = baseTime;
                    break;
                }

                if (waitTime < minWaitTime) {
                    minWaitTime = waitTime;
                    bestWaitTrack = i;
                }
            }

            // 若所有轨道立即可用性均不满足，判断是否可以通过微幅延后时间或强制重叠解决
            if (chosenTrack === -1) {
                if (opt.maxOverlapOffset > 0 && minWaitTime <= opt.maxOverlapOffset) {
                    chosenTrack = bestWaitTrack;
                    actualStartTime = baseTime + minWaitTime;
                } else if (opt.allowOverlap) {
                    chosenTrack = bestWaitTrack;
                    actualStartTime = baseTime;
                } else {
                    stats.droppedOverlap++;
                    continue;
                }
            }

            const endTime = actualStartTime + opt.scrollDuration;
            tracks[chosenTrack] = {
                startTime: actualStartTime,
                width,
                speed,
                leaveTime: endTime
            };

            const y = opt.marginTop + chosenTrack * trackHeight;
            // 使用 \an8 (顶部居中对齐)，起点 X 为屏幕右侧外加半个字宽，终点 X 为屏幕左侧外减半个字宽
            const halfW = Math.ceil(width / 2);
            const startX = isReverse ? -halfW : opt.resX + halfW;
            const endX = isReverse ? opt.resX + halfW : -halfW;

            const startStr = formatAssTime(actualStartTime);
            const endStr = formatAssTime(endTime);
            dialogues.push({
                start: actualStartTime,
                line: `Dialogue: 0,${startStr},${endStr},Danmaku,,0,0,0,,{\\move(${startX},${y},${endX},${y})${styleOverride}}${item.text}`
            });
            stats.rendered++;

        } else if (item.mode === 5 || item.mode === 4) {
            // Mode 5: 顶部固定 | Mode 4: 底部固定
            const isTop = item.mode === 5;
            const tracks = isTop ? topTracks : bottomTracks;

            let chosenTrack = -1;
            let earliestFreeTime = Infinity;
            let bestTrack = 0;

            for (let i = 0; i < tracks.length; i++) {
                if (baseTime >= tracks[i]) {
                    chosenTrack = i;
                    break;
                }
                if (tracks[i] < earliestFreeTime) {
                    earliestFreeTime = tracks[i];
                    bestTrack = i;
                }
            }

            if (chosenTrack === -1) {
                if (opt.allowOverlap) {
                    chosenTrack = bestTrack;
                } else {
                    stats.droppedOverlap++;
                    continue;
                }
            }

            const endTime = baseTime + opt.fixedDuration;
            tracks[chosenTrack] = endTime;

            const centerX = Math.round(opt.resX / 2);
            const y = isTop
                ? opt.marginTop + chosenTrack * trackHeight
                : opt.resY - opt.marginBottom - (chosenTrack + 1) * trackHeight + opt.lineSpacing;

            const startStr = formatAssTime(baseTime);
            const endStr = formatAssTime(endTime);
            // 固定弹幕图层设为 1（优先盖在普通滚动弹幕图层 0 之上，与 B 站层级一致）
            dialogues.push({
                start: baseTime,
                line: `Dialogue: 1,${startStr},${endStr},Danmaku,,0,0,0,,{\\pos(${centerX},${y})${styleOverride}}${item.text}`
            });
            stats.rendered++;
        }
    }

    // 6. 构建 ASS 头部与样式表
    // 按开始时间升序稳定排序：延后入轨（maxOverlapOffset）会让实际开始时间晚于后续
    // 弹幕，若保持解析顺序写入，文件内出现时间倒退会让顺序扫描型渲染器
    // （DirectVobSub / 部分 MPC 滤镜）卡顿、回退，必须保证 Dialogue 严格按时间递增
    dialogues.sort((a, b) => a.start - b.start);

    // ASS 透明度取值 00(不透明) ~ FF(全透明)
    const alphaHex = Math.round((1 - Math.min(1, Math.max(0, opt.opacity))) * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();

    const primaryColor = `&H${alphaHex}FFFFFF`;
    const outlineColor = `&H${alphaHex}000000`;
    const backColor = `&H${alphaHex}000000`;
    const boldFlag = opt.bold ? -1 : 0;

    const assHeader = [
        '[Script Info]',
        '; Script generated by Pure-JS DanmakuConverter',
        'Title: Bilibili Danmaku',
        'ScriptType: v4.00+',
        'Collisions: Normal',
        `PlayResX: ${opt.resX}`,
        `PlayResY: ${opt.resY}`,
        'Timer: 100.0000',
        'WrapStyle: 2',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // Alignment 设为 8（顶部居中），省去每行滚动和顶部弹幕重复声明 \an8
        `Style: Danmaku,${opt.fontName},${opt.fontSize},${primaryColor},${primaryColor},${outlineColor},${backColor},${boldFlag},0,0,0,100,100,0,0,1,${opt.outlineWidth},${opt.shadowDepth},8,0,0,0,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ].join('\r\n');

    return {
        assContent: assHeader + '\r\n' + dialogues.map(d => d.line).join('\r\n') + '\r\n',
        stats
    };
}

module.exports = {
    DEFAULT_OPTIONS,
    estimateTextWidth,
    parseBiliXml,
    convertXmlToAss
};