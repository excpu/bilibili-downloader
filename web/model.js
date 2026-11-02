function createModel() {
    let notificationContainer;

    function getNotificationContainer() {
        if (!notificationContainer) {
            notificationContainer = document.createElement('div');
            notificationContainer.className = 'notification-container';
            document.body.appendChild(notificationContainer);
        }

        return notificationContainer;
    }

    // 每条通知独立显示与关闭，按触发顺序纵向排列。
    function showNotification(type, icon, message, second = 3000) {
        const messageElement = document.createElement('div');
        messageElement.className = `notification notification-${type}`;
        messageElement.innerHTML = `<span style="margin-right: 8px;">${icon}</span>${message}`;

        getNotificationContainer().appendChild(messageElement);

        setTimeout(() => {
            messageElement.classList.add('notification-hide');
            // 同步折叠高度（含 gap），让后面的通知平滑上移补位而不是跳变
            const height = messageElement.offsetHeight;
            messageElement.style.boxSizing = 'border-box';
            messageElement.style.height = `${height}px`;
            messageElement.style.overflow = 'hidden';
            void messageElement.offsetHeight;
            messageElement.style.transition = 'height .3s ease, padding .3s ease, margin-bottom .3s ease, border-width .3s ease';
            messageElement.style.height = '0px';
            messageElement.style.paddingTop = '0px';
            messageElement.style.paddingBottom = '0px';
            messageElement.style.borderWidth = '0px';
            messageElement.style.marginBottom = '-12px';
            setTimeout(() => {
                messageElement.remove();
            }, 320);
        }, second);
    }

    function showSuccessMessage(message, second = 3000) {
        // 成功消息（绿色）✅
        showNotification('success', '✅', message, second);
    }

    function showInfoMessage(message, second = 3000) {
        // 信息消息（蓝色）ℹ️
        showNotification('info', 'ℹ️', message, second);
    }
    
    function showErrorMessage(message, second = 3000) {
        // 错误消息（红色）❌
        showNotification('error', '❌', message, second);
    }

    // 观察页面中所有模态框的显示状态，动态同步 Windows 标题栏原生按钮遮罩状态
    function setupModalTitleBarSync() {
        if (!window.electronAPI || !window.electronAPI.invoke) return;

        function updateOverlayState() {
            // 只上报状态，具体颜色由主进程按当前主题决定（深色主题下顶栏本身就是浅字）
            const hasVisibleModal = !!document.querySelector('.model:not(.hidden)');
            window.electronAPI.invoke('setTitleBarOverlay', { modal: hasVisibleModal }).catch(() => {});
        }

        const modals = document.querySelectorAll('.model');
        if (modals.length > 0) {
            const observer = new MutationObserver(() => {
                updateOverlayState();
            });
            modals.forEach(m => {
                observer.observe(m, { attributes: true, attributeFilter: ['class', 'style'] });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupModalTitleBarSync);
    } else {
        setupModalTitleBarSync();
    }

    return {
        showSuccessMessage,
        showInfoMessage,
        showErrorMessage
    };
}

const model = createModel();