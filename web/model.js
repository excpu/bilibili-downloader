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
            setTimeout(() => {
                messageElement.remove();
            }, 300);
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
            const hasVisibleModal = !!document.querySelector('.model:not(.hidden)');
            if (hasVisibleModal) {
                window.electronAPI.invoke('setTitleBarOverlay', {
                    color: '#00000000',
                    symbolColor: '#ffffff'
                }).catch(() => {});
            } else {
                window.electronAPI.invoke('setTitleBarOverlay', {
                    color: '#00000000',
                    symbolColor: '#333333'
                }).catch(() => {});
            }
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