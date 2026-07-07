function createModel() {
    // 通知队列：用于串行显示消息，避免短时间内多次触发导致重叠。
    const notificationQueue = [];
    let isProcessingQueue = false;

    // 入队并尝试启动消费流程。
    function enqueueNotification(type, icon, message, second = 3000) {
        notificationQueue.push({ type, icon, message, second });
        processQueue();
    }

    // 依次消费队列；每次只显示一条，等它完全消失后再显示下一条。
    function processQueue() {
        if (isProcessingQueue || notificationQueue.length === 0) {
            return;
        }

        isProcessingQueue = true;
        const { type, icon, message, second } = notificationQueue.shift();
        const messageElement = document.createElement('div');
        messageElement.className = `notification notification-${type}`;
        messageElement.innerHTML = `<span style="margin-right: 8px;">${icon}</span>${message}`;

        document.body.appendChild(messageElement);

        setTimeout(() => {
            messageElement.classList.add('notification-hide');
            setTimeout(() => {
                messageElement.remove();
                isProcessingQueue = false;
                processQueue();
            }, 300);
        }, second);
    }

    function showSuccessMessage(message, second = 3000) {
        // 成功消息（绿色）✅
        enqueueNotification('success', '✅', message, second);
    }

    function showInfoMessage(message, second = 3000) {
        // 信息消息（蓝色）ℹ️
        enqueueNotification('info', 'ℹ️', message, second);
    }
    
    function showErrorMessage(message, second = 3000) {
        // 错误消息（红色）❌
        enqueueNotification('error', '❌', message, second);
    }

    return {
        showSuccessMessage,
        showInfoMessage,
        showErrorMessage
    };
}

const model = createModel();