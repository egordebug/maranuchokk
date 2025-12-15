const socket = io({ transports: ["websocket"] });

// --- MOBILE 100VH FIX ---
function fixVH() {
    document.documentElement.style.setProperty("--vh", window.innerHeight * 0.01 + "px");
}
fixVH();
window.addEventListener("resize", fixVH);

// -------------------------
// DOM REFS
// -------------------------
const screens = {
    login: document.getElementById("login-screen"),
    chat: document.getElementById("chat-screen")
};

const inputs = {
    user: document.getElementById("username"),
    pass: document.getElementById("password"),
    search: document.getElementById("search-input"),
    msg: document.getElementById("message-input"),
    file: document.getElementById("file-input")
};

const btns = {
    login: document.getElementById("btn-login"),
    createGroup: document.getElementById("btn-create-group"),
    send: document.getElementById("btn-send"),
    addMember: document.getElementById("btn-add-member")
};

const lists = {
    chat: document.getElementById("chat-list"),
    search: document.getElementById("search-results"),
    msgs: document.getElementById("messages-area"),
    uploadStatus: document.getElementById("upload-status")
};

const elements = {
    sidebar: document.querySelector(".sidebar"),
    btnBack: document.getElementById("btn-back"),
    inputArea: document.getElementById("input-area"),
    chatTitleSpan: document.getElementById("chat-title-span")
};

let myId = null;
let currentChatId = null;

// =======================================================
//                   EVENT HANDLERS
// =======================================================

elements.btnBack.addEventListener("click", closeChatMobile);

btns.login.addEventListener("click", () => {
    const username = inputs.user.value.trim();
    const password = inputs.pass.value.trim();

    if (!username || !password) return alert("Введите данные");

    socket.emit("login", {
        username: sanitize(username),
        password: sanitize(password)
    });
});

inputs.search.addEventListener("input", (e) => {
    const q = e.target.value.trim();
    if (!q) {
        lists.search.classList.add("hidden");
        return;
    }
    socket.emit("search_users", sanitize(q));
});

btns.createGroup.addEventListener("click", () => {
    const name = prompt("Название группы?");
    if (name) {
        socket.emit("create_chat", {
            isGroup: true,
            groupName: sanitize(name)
        });
    }
});

btns.send.addEventListener("click", sendMessage);
inputs.msg.addEventListener("keypress", e => {
    if (e.key === "Enter") sendMessage();
});
inputs.msg.addEventListener("focus", scrollToBottom);

btns.addMember.addEventListener("click", () => {
    const username = prompt("Кого добавить?");
    if (username && currentChatId) {
        socket.emit("add_member_request", {
            chatId: currentChatId,
            username: sanitize(username)
        });
    }
});

// =======================================================
//                   SOCKET HANDLERS
// =======================================================

socket.on("login_success", (data) => {
    myId = data.userId;

    document.getElementById("my-username").innerText = data.username;
    screens.login.classList.remove("active");
    screens.chat.classList.add("active");
});

socket.on("login_error", (msg) => alert(msg || "Ошибка"));

socket.on("search_results", (users) => {
    lists.search.innerHTML = "";
    lists.search.classList.remove("hidden");

    users.forEach(u => {
        const d = document.createElement("div");
        d.className = "search-item";
        d.textContent = u.username;

        d.onclick = () => {
            socket.emit("create_chat", {
                partnerId: u.id,
                isGroup: false
            });
            lists.search.classList.add("hidden");
            inputs.search.value = "";
        };

        lists.search.appendChild(d);
    });
});

socket.on("update_chat_list", (chats) => {
    lists.chat.innerHTML = "";
    chats.forEach(chat => {
        const div = document.createElement("div");
        div.className = "chat-item";

        let name = chat.name;

        if (chat.type === "private") {
            const other = chat.members.find(m => m.id !== myId);
            if (other) name = other.username;
        }

        div.innerHTML = `
            <h4>${escapeHTML(name)}</h4>
            <span>${chat.type === "group" ? "Группа" : "Личное"}</span>
        `;

        if (chat.id === currentChatId) div.classList.add("active");
        div.onclick = () => openChat(chat.id, name);

        lists.chat.appendChild(div);
    });
});

socket.on("open_chat_force", ({ id, name }) => openChat(id, name));

socket.on("chat_history", (chat) => {
    lists.msgs.innerHTML = "";
    chat.messages.forEach(appendMessage);
    scrollToBottom();

    if (chat.type === "group") btns.addMember.classList.remove("hidden");
    else btns.addMember.classList.add("hidden");
});

socket.on("new_message", (msg) => {
    if (msg.chatId === currentChatId) {
        appendMessage(msg);
        scrollToBottom();
    }
});

socket.on("member_added", ({ username, chatName }) => {
    alert(`${username} добавлен в "${chatName}"`);
});

socket.on("add_member_error", alert);

// =======================================================
//                    CHAT FUNCTIONS
// =======================================================

function openChat(chatId, name) {
    currentChatId = chatId;
    elements.chatTitleSpan.innerText = name;

    elements.sidebar.classList.add("hidden-on-mobile");
    elements.inputArea.classList.remove("hidden");
    elements.btnBack.classList.remove("hidden");

    socket.emit("join_chat", chatId);
}

function closeChatMobile() {
    currentChatId = null;

    elements.sidebar.classList.remove("hidden-on-mobile");
    elements.inputArea.classList.add("hidden");
    elements.btnBack.classList.add("hidden");
    btns.addMember.classList.add("hidden");
}

function scrollToBottom() {
    setTimeout(() => {
        lists.msgs.scrollTop = lists.msgs.scrollHeight;
    }, 50);
}

// ======================= MESSAGE RENDERER =======================

function appendMessage(msg) {
    const div = document.createElement("div");
    const isMe = msg.senderId === myId;

    div.className = `message ${isMe ? "my" : "other"}`;

    let html = `<span class="msg-sender">${escapeHTML(msg.senderName)}</span>`;

    if (msg.text) html += `<div>${escapeHTML(msg.text)}</div>`;

    if (msg.filePath) {
        const safeURL = sanitizeURL(msg.filePath);

        if (msg.fileMime.startsWith("image/")) {
            html += `<img src="${safeURL}" class="msg-img">`;
        } else if (msg.fileMime.startsWith("video/")) {
            html += `<video src="${safeURL}" controls class="msg-video"></video>`;
        } else {
            html += `<a href="${safeURL}" target="_blank" class="msg-file">📄 ${escapeHTML(msg.fileOriginal)}</a>`;
        }
    }

    div.innerHTML = html;
    lists.msgs.appendChild(div);
}

// ========================= SECURE SEND =========================

let sending = false;

async function sendMessage() {
    if (!currentChatId || sending) return;
    sending = true;

    const text = sanitize(inputs.msg.value.trim());
    const file = inputs.file.files[0];
    let fileData = null;

    if (!text && !file) {
        sending = false;
        return;
    }

    if (file) {
        if (file.size > 40 * 1024 * 1024) {
            alert("Файл больше 40MB");
            sending = false;
            return;
        }

        const form = new FormData();
        form.append("file", file);

        try {
            lists.uploadStatus.textContent = "Загрузка...";

            const r = await fetch("/upload", {
                method: "POST",
                body: form
            });

            fileData = await r.json();
        } catch {
            alert("Ошибка загрузки файла");
            sending = false;
            return;
        } finally {
            lists.uploadStatus.textContent = "";
        }
    }

    socket.emit("send_message", {
        chatId: currentChatId,
        text,
        fileData
    });

    inputs.msg.value = "";
    inputs.file.value = "";
    sending = false;
}

// =======================================================
//                 SECURITY HELPERS
// =======================================================

function escapeHTML(str) {
    return str.replace(/[&<>"']/g, m => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[m]));
}

function sanitize(str) {
    return escapeHTML(String(str)).slice(0, 200);
}

function sanitizeURL(url) {
    if (!url.startsWith("/uploads/")) return "#";
    return url.replace(/[\s<>"]/g, "");
}
