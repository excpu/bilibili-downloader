function createModel() {
    function showSuccessMessage(message, second = 3000) {
        // 屏幕上方中心 fix 位置显式成功消息 （绿色）✅
        const messageElement = document.createElement('div');
        messageElement.className = 'notification notification-success';
        messageElement.innerHTML = `<span style="margin-right: 8px;">✅</span>${message}`;
        
        document.body.appendChild(messageElement);
        
        // 自动移除消息
        setTimeout(() => {
            messageElement.classList.add('notification-hide');
            setTimeout(() => {
                messageElement.remove();
            }, 300);
        }, second);
    }
    
    function showErrorMessage(message, second = 3000) {
        // 屏幕上方中心 fix 位置显式错误消息 （红色）❌
        const messageElement = document.createElement('div');
        messageElement.className = 'notification notification-error';
        messageElement.innerHTML = `<span style="margin-right: 8px;">❌</span>${message}`;
        
        document.body.appendChild(messageElement);
        
        // 自动移除消息
        setTimeout(() => {
            messageElement.classList.add('notification-hide');
            setTimeout(() => {
                messageElement.remove();
            }, 300);
        }, second);
    }

    return {
        showSuccessMessage,
        showErrorMessage
    };
}

const model = createModel();