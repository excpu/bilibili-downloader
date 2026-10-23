// 根据"创建文件夹 / 文件夹嵌套"设置，为每个下载任务生成保存目录的文件夹层级。
// 层级按"外层在前、内层在后"返回，由主进程结合设置决定实际使用几层：
// - 未勾选创建文件夹：忽略层级，直接下载到下载目录（原有行为）
// - 勾选创建文件夹、未勾选嵌套：只使用第一层
// - 两者都勾选：使用完整层级（合集 -> 视频 -> 分P；分P视频 -> 主标题 -> 分P）
function createFolderStructure() {
    async function getFolderFlags() {
        const [inFolder, nesting] = await Promise.all([
            window.electronAPI.invoke('getDownloadInFolder'),
            window.electronAPI.invoke('getDownloadFolderNesting')
        ]);
        return {
            inFolder: inFolder === true,
            nesting: nesting === true && inFolder === true
        };
    }

    // 分P文件夹名称：P3 - 分P标题
    function partFolderName(partInfo) {
        if (!partInfo || !partInfo.part) return '';
        const page = Number(partInfo.page);
        return Number.isFinite(page) ? `P${page} - ${partInfo.part}` : String(partInfo.part);
    }

    // 合集中一个视频（一集）的文件夹名称：E2 - 视频标题
    function episodeFolderName(partInfo, identity) {
        const title = (partInfo && partInfo.episodeTitle) || (identity && identity.title) || '';
        const episode = Number(partInfo && partInfo.episode);
        return Number.isFinite(episode) ? `E${episode} - ${title}` : String(title);
    }

    // 合集中的视频是否包含多个分P（pageCount 由 buildCollectionParts 提供）
    function isMultiPartEpisode(partInfo) {
        return Number(partInfo && partInfo.pageCount) > 1;
    }

    // 计算单个任务的分层名称，partInfo 为该任务对应的分P/合集条目（无则为单P视频）
    function buildLayerNames(identity, partInfo) {
        if (!identity) return [];

        // 合集：外层是合集名，内层是视频名，视频有分P时再套一层分P名
        if (identity.isCollection) {
            const names = [identity.title || '合集'];
            if (partInfo) {
                names.push(episodeFolderName(partInfo, identity));
                if (isMultiPartEpisode(partInfo)) {
                    names.push(partFolderName(partInfo));
                }
            }
            return names;
        }

        // 分P视频：外层是视频主标题，内层是分P标题
        const names = [identity.title || ''];
        if (partInfo) {
            const partName = partFolderName(partInfo);
            if (partName) names.push(partName);
        }
        return names.filter(function (name) { return name && name.length > 0; });
    }

    // 单独下载弹幕/封面/字幕：没有具体分P条目时，按 cid 匹配当前分P
    async function forIdentity(identity, cid) {
        const flags = await getFolderFlags();
        if (!flags.inFolder) return [];
        return buildLayerNames(identity, matchPart(identity, cid));
    }

    // 从当前视频信息中按 cid 找到对应的分P条目（找不到返回 null）
    function matchPart(identity, cid) {
        const parts = (identity && identity.p) || [];
        return parts.find(function (item) {
            return item.cid && cid && item.cid === cid;
        }) || null;
    }

    return {
        getFolderFlags: getFolderFlags,
        buildLayerNames: buildLayerNames,
        matchPart: matchPart,
        forIdentity: forIdentity
    };
}

const folderStructure = createFolderStructure();
