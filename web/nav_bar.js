function createNavBar() {
    const $avatar = document.getElementById('avatar');
    function updateAvatar(imgUrl){
        $avatar.innerHTML = `<img src="${imgUrl}" alt="用户头像" class="avatar-img">`;
    }

    return{
        updateAvatar
    }
}