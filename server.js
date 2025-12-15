// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50 * 1024 * 1024 });

/* --------------------------
   Config
   -------------------------- */
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'db.sqlite');
const MESSAGE_LIMIT_PER_CHAT = 2000; // держать не более N сообщений на чат

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* --------------------------
   Middlewares
   -------------------------- */
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

// basic rate limiter for HTTP endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300 // limit each IP to 300 requests per windowMs
});
app.use(apiLimiter);

/* --------------------------
   Database (better-sqlite3)
   -------------------------- */
const db = new Database(DB_FILE);

// Create tables if not exists
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  userId TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  senderId TEXT NOT NULL,
  senderName TEXT NOT NULL,
  text TEXT,
  file TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chatId, timestamp);
`);

// Prepared statements
const stmt = {
  // users
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)'),

  // chats
  insertChat: db.prepare('INSERT INTO chats (id, type, name, createdAt) VALUES (?, ?, ?, ?)'),
  getPrivateChatBetween: db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members m1 ON m1.chatId = c.id
    JOIN chat_members m2 ON m2.chatId = c.id
    WHERE c.type = 'private' AND m1.userId = ? AND m2.userId = ?
    LIMIT 1
  `),
  getChatById: db.prepare('SELECT * FROM chats WHERE id = ?'),

  // members
  insertMember: db.prepare('INSERT INTO chat_members (id, chatId, userId) VALUES (?, ?, ?)'),
  isUserMemberOfChat: db.prepare('SELECT 1 FROM chat_members WHERE chatId = ? AND userId = ? LIMIT 1'),
  getChatMembers: db.prepare('SELECT u.id, u.username FROM users u JOIN chat_members m ON u.id = m.userId WHERE m.chatId = ?'),

  // chat list
  getChatsOfUser: db.prepare(`
    SELECT c.id, c.type, c.name, c.createdAt
    FROM chats c
    JOIN chat_members m ON m.chatId = c.id
    WHERE m.userId = ?
    ORDER BY c.createdAt DESC
  `),

  // messages
  insertMessage: db.prepare(`
    INSERT INTO messages (id, chatId, senderId, senderName, text, file, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getMessagesOfChat: db.prepare('SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp ASC'),
  countMessagesOfChat: db.prepare('SELECT COUNT(1) as cnt FROM messages WHERE chatId = ?'),
  deleteOldestMessages: db.prepare('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE chatId = ? ORDER BY timestamp ASC LIMIT ?)')
};

/* --------------------------
   File upload (Multer)
   -------------------------- */

// Accept only images, pdf, plain text (change as needed)
function fileFilter(req, file, cb) {
  const allowed = (
    file.mimetype.startsWith('image/') ||
    file.mimetype === 'application/pdf' ||
    file.mimetype === 'text/plain'
  );
  cb(null, allowed);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}-${uuidv4()}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40 MB
  fileFilter
});

/* --------------------------
   Simple helpers
   -------------------------- */
function sendUpdatedChatListToUser(userId) {
  const chats = stmt.getChatsOfUser.all(userId);
  io.to(userId).emit('update_chat_list', chats);
}

function sanitizeUsername(u) {
  if (!u || typeof u !== 'string') return '';
  return u.trim().slice(0, 64);
}

function sanitizeText(t) {
  if (!t) return '';
  if (typeof t !== 'string') t = String(t);
  return t.trim().slice(0, 2000);
}

/* --------------------------
   HTTP upload endpoint
   -------------------------- */
app.post('/upload', upload.single('file'), (req, res) => {
  // Basic API rate-limit already applied
  if (!req.file) return res.status(400).json({ error: 'No file uploaded or file type not allowed.' });

  res.json({
    filename: req.file.filename,
    originalname: path.basename(req.file.originalname),
    mimetype: req.file.mimetype,
    path: '/uploads/' + req.file.filename,
    size: req.file.size
  });
});

/* --------------------------
   Socket.IO logic
   -------------------------- */
io.on('connection', (socket) => {
  let currentUser = null;

  // helper to require auth for socket events
  function requireAuth(eventName) {
    if (!currentUser) {
      socket.emit('error', { event: eventName, message: 'Not authenticated' });
      return false;
    }
    return true;
  }

  // 1) login / register
  socket.on('login', ({ username, password }) => {
    username = sanitizeUsername(username);
    if (!username || !password) {
      socket.emit('login_error', 'Invalid username or password');
      return;
    }

    let user = stmt.getUserByName.get(username);
    if (user) {
      // user exists -> check password
      const ok = bcrypt.compareSync(String(password), user.password);
      if (!ok) {
        socket.emit('login_error', 'Неверный пароль');
        return;
      }
    } else {
      // register new
      const id = uuidv4();
      const hashed = bcrypt.hashSync(String(password), 10);
      try {
        stmt.insertUser.run(id, username, hashed);
        user = stmt.getUserById.get(id);
      } catch (e) {
        socket.emit('login_error', 'Ошибка регистрации');
        return;
      }
    }

    currentUser = user;
    socket.join(user.id); // personal room
    socket.emit('login_success', { userId: user.id, username: user.username });

    // send chat list
    sendUpdatedChatListToUser(user.id);
  });

  // 2) search users
  socket.on('search_users', (query) => {
    if (!requireAuth('search_users')) return;
    if (typeof query !== 'string' || query.length > 64) {
      socket.emit('search_results', []);
      return;
    }
    query = query.trim();
    if (!query) {
      socket.emit('search_results', []);
      return;
    }

    const like = `%${query}%`;
    const rows = db.prepare('SELECT id, username FROM users WHERE username LIKE ? AND id <> ? LIMIT 50').all(like, currentUser.id);
    socket.emit('search_results', rows);
  });

  // 3) create chat
  socket.on('create_chat', ({ partnerId, isGroup, groupName }) => {
    if (!requireAuth('create_chat')) return;

    if (isGroup) {
      const chatId = uuidv4();
      const name = (typeof groupName === 'string' && groupName.trim()) ? groupName.trim().slice(0, 128) : 'Новая группа';
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        stmt.insertChat.run(chatId, 'group', name, now);
        stmt.insertMember.run(uuidv4(), chatId, currentUser.id);
      });

      try {
        tx();
      } catch (e) {
        socket.emit('create_chat_error', 'Не удалось создать группу');
        return;
      }

      sendUpdatedChatListToUser(currentUser.id);
      socket.emit('open_chat_force', { id: chatId, name });
      return;
    }

    // private chat
    if (!partnerId) return;
    const partner = stmt.getUserById.get(partnerId);
    if (!partner) {
      socket.emit('create_chat_error', 'Партнёр не найден');
      return;
    }

    // check existing private chat
    const exist = stmt.getPrivateChatBetween.get(currentUser.id, partnerId) || stmt.getPrivateChatBetween.get(partnerId, currentUser.id);
    if (exist) {
      socket.emit('open_chat_force', { id: exist.id, name: partner.username });
      return;
    }

    // create private
    const chatId = uuidv4();
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      stmt.insertChat.run(chatId, 'private', partner.username, now);
      stmt.insertMember.run(uuidv4(), chatId, currentUser.id);
      stmt.insertMember.run(uuidv4(), chatId, partnerId);
    });

    try {
      tx();
    } catch (e) {
      socket.emit('create_chat_error', 'Не удалось создать чат');
      return;
    }

    // notify both users
    [currentUser.id, partner.id].forEach(uid => sendUpdatedChatListToUser(uid));
    socket.emit('open_chat_force', { id: chatId, name: partner.username });
  });

  // 4) join chat (get history)
  socket.on('join_chat', (chatId) => {
    if (!requireAuth('join_chat')) return;
    if (!chatId) return;

    // check membership
    const isMember = stmt.isUserMemberOfChat.get(chatId, currentUser.id);
    if (!isMember) {
      socket.emit('join_chat_error', 'Нет доступа к этому чату');
      return;
    }

    socket.join(chatId);
    const chat = stmt.getChatById.get(chatId);
    if (!chat) {
      socket.emit('join_chat_error', 'Чат не найден');
      return;
    }

    // attach members and messages
    chat.members = stmt.getChatMembers.all(chatId);
    chat.messages = stmt.getMessagesOfChat.all(chatId);
    socket.emit('chat_history', chat);
  });

  // 5) send message
  socket.on('send_message', ({ chatId, text, fileData }) => {
    if (!requireAuth('send_message')) return;
    if (!chatId) return;

    // must be a member
    const isMember = stmt.isUserMemberOfChat.get(chatId, currentUser.id);
    if (!isMember) {
      socket.emit('send_message_error', 'Нет доступа к чату');
      return;
    }

    // Prepare message
    const msg = {
      id: uuidv4(),
      chatId,
      senderId: currentUser.id,
      senderName: currentUser.username,
      text: sanitizeText(text),
      file: (fileData && typeof fileData === 'string') ? fileData.slice(0, 512) : null,
      timestamp: new Date().toISOString()
    };

    try {
      const tx = db.transaction(() => {
        stmt.insertMessage.run(msg.id, msg.chatId, msg.senderId, msg.senderName, msg.text, msg.file, msg.timestamp);

        // keep message count under limit
        const cnt = stmt.countMessagesOfChat.get(chatId).cnt;
        if (cnt > MESSAGE_LIMIT_PER_CHAT) {
          const toDelete = Math.max(0, cnt - MESSAGE_LIMIT_PER_CHAT);
          stmt.deleteOldestMessages.run(chatId, toDelete);
        }
      });
      tx();
    } catch (e) {
      socket.emit('send_message_error', 'Не удалось сохранить сообщение');
      return;
    }

    // emit to chat room
    io.to(chatId).emit('new_message', msg);
  });

  // 6) add member to group
  socket.on('add_member_request', ({ chatId, username }) => {
    if (!requireAuth('add_member_request')) return;
    if (!chatId || !username) return;

    // ensure chat exists and is group
    const chat = stmt.getChatById.get(chatId);
    if (!chat || chat.type !== 'group') {
      socket.emit('add_member_error', 'Группа не найдена или доступ запрещён.');
      return;
    }

    // requester must be a member
    const requesterIsMember = stmt.isUserMemberOfChat.get(chatId, currentUser.id);
    if (!requesterIsMember) {
      socket.emit('add_member_error', 'Вы не состоите в группе.');
      return;
    }

    // find user to add
    username = sanitizeUsername(username);
    const userToAdd = stmt.getUserByName.get(username);
    if (!userToAdd) {
      socket.emit('add_member_error', `Пользователь "${username}" не найден.`);
      return;
    }

    // check not already member
    const already = stmt.isUserMemberOfChat.get(chatId, userToAdd.id);
    if (already) {
      socket.emit('add_member_error', `${username} уже в чате.`);
      return;
    }

    // add member + system message
    const systemMsg = {
      id: uuidv4(),
      chatId,
      senderId: 'system',
      senderName: 'Система',
      text: `${currentUser.username} добавил ${userToAdd.username}`,
      timestamp: new Date().toISOString()
    };

    try {
      const tx = db.transaction(() => {
        stmt.insertMember.run(uuidv4(), chatId, userToAdd.id);
        stmt.insertMessage.run(systemMsg.id, systemMsg.chatId, systemMsg.senderId, systemMsg.senderName, systemMsg.text, null, systemMsg.timestamp);
      });
      tx();
    } catch (e) {
      socket.emit('add_member_error', 'Ошибка при добавлении участника.');
      return;
    }

    // notify chat + new user
    io.to(chatId).emit('new_message', systemMsg);
    io.to(userToAdd.id).emit('member_added', {
      username: userToAdd.username,
      chatName: chat.name,
      targetId: userToAdd.id
    });

    // update lists for all members (including new one)
    const members = stmt.getChatMembers.all(chatId);
    members.forEach(m => sendUpdatedChatListToUser(m.id));
  });

  // request chat list
  socket.on('request_chat_list', () => {
    if (!currentUser) return;
    sendUpdatedChatListToUser(currentUser.id);
  });

  // handle disconnect
  socket.on('disconnect', () => {
    // nothing special required; socket.io cleans up rooms automatically
  });
});

/* --------------------------
   Start
   -------------------------- */
server.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});