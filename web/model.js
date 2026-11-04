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
            const hasVisibleModal = !!document.querySelector('.model:not(.hidden):not(.is-closing)');
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

// 弹窗的“从哪来、回哪去”动效：
// 弹窗整体缩放并位移到触发控件上，圆角同步变成控件的形状；关闭沿同一条几何路径收回。
// 展开与收回使用不对称的曲线：
//   展开：临界阻尼弹簧——柔和起步、中段加速、平滑落定，没有回弹；
//   收回：缓起步、中段加速、软着陆——不会一上来就猛缩，也不会在按钮附近慢慢爬。
// 弹窗在接近控件的那一段与控件交叉淡变：收回时渐渐变回按钮，展开时从按钮渐渐长成弹窗，
// 避免最后一帧突然切换。
const MODAL_OPEN_MS = 520;
const MODAL_CLOSE_MS = 380;
const MODAL_CLOSE_EASING = 'cubic-bezier(.4, 0, .15, 1)';
const MODAL_OPEN_FADE_MS = 110;
const MODAL_CLOSE_FADE_MS = 190;
const MODAL_RADIUS = 12;
// 终态把裁切区向外放开，避免弹窗阴影在动画最后一帧被切掉再突然出现
const MODAL_SHADOW_BLEED = 100;

// 临界阻尼弹簧 x(t) = 1 - (1 + ωt)e^(-ωt)，采样成 CSS linear() 缓动，起始速度为 0
function createSpringEasing(omega, durationMs, steps = 48) {
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const x = omega * (durationMs / 1000) * (i / steps);
        points.push(1 - (1 + x) * Math.exp(-x));
    }
    const last = points[steps];
    return `linear(${points.map((value) => (value / last).toFixed(4)).join(', ')})`;
}

const MODAL_OPEN_EASING = createSpringEasing(12, MODAL_OPEN_MS);

function getModalMorph(content, trigger) {
    const box = content.getBoundingClientRect();
    const source = trigger?.isConnected ? trigger.getBoundingClientRect() : null;
    const end = {
        transform: 'translate(0px, 0px) scale(1)',
        clipPath: `inset(-${MODAL_SHADOW_BLEED}px -${MODAL_SHADOW_BLEED}px -${MODAL_SHADOW_BLEED}px -${MODAL_SHADOW_BLEED}px round ${MODAL_RADIUS}px)`
    };

    // 触发源不可用（不可见、过大或根本不是控件）时退回为中心缩放
    const usable = source
        && source.width > 0 && source.height > 0
        && source.width < box.width * 0.9
        && source.height < box.height * 0.9;
    if (!usable) {
        return {
            start: { ...end, transform: 'translate(0px, 0px) scale(.9)' },
            end
        };
    }

    const scale = source.width / box.width;
    const dx = source.left + source.width / 2 - (box.left + box.width / 2);
    const dy = source.top + source.height / 2 - (box.top + box.height / 2);
    // 等比缩小后高度可能比控件高，纵向裁掉多出的部分，使起点轮廓与控件一致
    const insetY = Math.max(0, (box.height - source.height / scale) / 2);
    const rawRadius = getComputedStyle(trigger).borderTopLeftRadius;
    const radius = rawRadius.endsWith('%')
        ? (parseFloat(rawRadius) / 100) * Math.min(source.width, source.height)
        : parseFloat(rawRadius) || 0;
    const localRadius = Math.min(radius, source.height / 2) / scale;

    return {
        start: {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            clipPath: `inset(${insetY}px 0px ${insetY}px 0px round ${localRadius}px)`
        },
        end
    };
}

function cancelModalMotion(modal) {
    modal._motion?.forEach((animation) => animation.cancel());
    modal._motion = null;
}

// 实验开关：开启时用上面的“从哪来、回哪去”动画，关闭时用普通的淡入 + 缩放动画。
// 默认开启；启动时从设置读取，设置页切换后立即生效。
let modalMorphEnabled = true;

function setModalMorphEnabled(enabled) {
    modalMorphEnabled = enabled !== false;
}

if (window.electronAPI?.invoke) {
    window.electronAPI.invoke('getModalMorphEnabled')
        .then((enabled) => setModalMorphEnabled(enabled))
        .catch(() => {});
}

const MODAL_BACKDROP_HIDDEN = { backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(0px)' };

function playMorphMotion(modal, content, opening) {
    const { start, end } = getModalMorph(content, modal._motionTrigger);

    const duration = opening ? MODAL_OPEN_MS : MODAL_CLOSE_MS;
    const fadeDuration = opening ? MODAL_OPEN_FADE_MS : MODAL_CLOSE_FADE_MS;

    const contentAnimation = content.animate(opening ? [start, end] : [end, start], {
        duration,
        easing: opening ? MODAL_OPEN_EASING : MODAL_CLOSE_EASING,
        fill: 'both'
    });
    // 与控件的交叉淡变：展开时在开头淡入，收回时在结尾淡出（露出底下真实的控件）
    const fadeAnimation = content.animate(
        opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
        {
            duration: fadeDuration,
            delay: opening ? 0 : duration - fadeDuration,
            easing: opening ? 'ease-out' : 'cubic-bezier(.4, 0, .6, 1)',
            fill: 'both'
        }
    );
    // 遮罩单独变暗/变亮；收回时在弹窗落到控件之前就褪去，让落点的控件保持清晰
    const backdropAnimation = modal.animate(opening ? [MODAL_BACKDROP_HIDDEN, {}] : [{}, MODAL_BACKDROP_HIDDEN], {
        duration: opening ? 360 : 300,
        easing: opening ? 'cubic-bezier(.2, .8, .2, 1)' : 'cubic-bezier(.4, 0, .2, 1)',
        fill: 'both'
    });

    modal._motion = [contentAnimation, fadeAnimation, backdropAnimation];
    return contentAnimation;
}

// 普通动画：整体淡入 + 轻微缩放上浮；进入减速落定，退出加速离开，两者不对称
function playPlainMotion(modal, content, opening) {
    const rest = { opacity: 1, transform: 'translateY(0px) scale(1)' };
    const away = { opacity: 0, transform: 'translateY(8px) scale(.96)' };

    const contentAnimation = content.animate(opening ? [away, rest] : [rest, away], {
        duration: opening ? 300 : 180,
        easing: opening ? 'cubic-bezier(.16, 1, .3, 1)' : 'cubic-bezier(.4, 0, 1, 1)',
        fill: 'both'
    });
    const backdropAnimation = modal.animate(opening ? [MODAL_BACKDROP_HIDDEN, {}] : [{}, MODAL_BACKDROP_HIDDEN], {
        duration: opening ? 240 : 180,
        easing: opening ? 'cubic-bezier(.16, 1, .3, 1)' : 'cubic-bezier(.4, 0, 1, 1)',
        fill: 'both'
    });

    modal._motion = [contentAnimation, backdropAnimation];
    return contentAnimation;
}

function playModalMotion(modal, content, direction) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return null;
    }

    // 必须在没有任何动画干预的状态下量取弹窗位置
    cancelModalMotion(modal);
    const opening = direction === 'open';

    return modalMorphEnabled
        ? playMorphMotion(modal, content, opening)
        : playPlainMotion(modal, content, opening);
}

function openModal(modal, trigger = document.activeElement) {
    const content = modal?.querySelector('.model-content');

    if (!content) {
        return;
    }

    const isShown = !modal.classList.contains('hidden') && !modal.classList.contains('is-closing');
    modal._motionTrigger = trigger;

    if (isShown) {
        return;
    }

    modal.classList.remove('is-closing');
    modal.classList.remove('hidden');
    playModalMotion(modal, content, 'open');
}

function closeModal(modal) {
    if (!modal || modal.classList.contains('hidden') || modal.classList.contains('is-closing')) {
        return;
    }

    const content = modal.querySelector('.model-content');
    const animation = content ? playModalMotion(modal, content, 'close') : null;

    if (!animation) {
        modal.classList.add('hidden');
        return;
    }

    modal.classList.add('is-closing');
    animation.finished.then(() => {
        modal.classList.add('hidden');
        modal.classList.remove('is-closing');
        cancelModalMotion(modal);
    }, () => {
        // 收回途中被重新打开：动画被取消，状态由 openModal 接管
    });
}

const model = createModel();