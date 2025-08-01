const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage (replaces MongoDB for learning purposes)
const users = new Map(); // userId -> user object
const messages = []; // array of message objects
const rooms = new Map(); // roomName -> room object
const activeUsers = new Map(); // socketId -> user info

let userIdCounter = 1;
let messageIdCounter = 1;

console.log('Using in-memory storage (no MongoDB required)');

// Helper functions to simulate MongoDB operations
const findUserByUsername = (username) => {
  for (let user of users.values()) {
    if (user.username === username) return user;
  }
  return null;
};

const findOnlineUsers = () => {
  return Array.from(users.values()).filter(user => user.isOnline);
};

const findMessagesByRoom = (roomName, limit = 50) => {
  return messages
    .filter(msg => msg.room === roomName)
    .slice(-limit)
    .map(msg => ({
      ...msg,
      sender: users.get(msg.senderId)
    }));
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  // Handle user joining
  socket.on('join', async (userData) => {
    try {
      // Find or create user
      let user = findUserByUsername(userData.username);
      if (!user) {
        user = {
          _id: userIdCounter++,
          username: userData.username,
          socketId: socket.id,
          isOnline: true
        };
        users.set(user._id, user);
      } else {
        user.socketId = socket.id;
        user.isOnline = true;
      }

      // Store user info
      activeUsers.set(socket.id, {
        userId: user._id,
        username: user.username,
        currentRoom: null
      });

      // Send user info back
      socket.emit('user-joined', {
        userId: user._id,
        username: user.username
      });

      // Broadcast updated user list
      const onlineUsers = findOnlineUsers();
      io.emit('users-update', onlineUsers);

      console.log(`User ${user.username} joined`);
    } catch (error) {
      console.error('Error in join:', error);
      socket.emit('error', 'Failed to join');
    }
  });

  // Handle joining a room (group chat)
  socket.on('join-room', async (roomName) => {
    try {
      const userInfo = activeUsers.get(socket.id);
      if (!userInfo) return;

      // Leave current room if any
      if (userInfo.currentRoom) {
        socket.leave(userInfo.currentRoom);
      }

      // Find or create room
      let room = rooms.get(roomName);
      if (!room) {
        room = {
          name: roomName,
          participants: [userInfo.userId]
        };
        rooms.set(roomName, room);
      } else if (!room.participants.includes(userInfo.userId)) {
        room.participants.push(userInfo.userId);
      }

      // Join the room
      socket.join(roomName);
      userInfo.currentRoom = roomName;

      // Get recent messages for this room
      const roomMessages = findMessagesByRoom(roomName);

      socket.emit('room-joined', {
        roomName,
        messages: roomMessages
      });

      // Notify room about new user
      socket.to(roomName).emit('user-joined-room', {
        username: userInfo.username,
        roomName
      });

      console.log(`User ${userInfo.username} joined room ${roomName}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', 'Failed to join room');
    }
  });

  // Handle private chat
  socket.on('start-private-chat', async (targetUsername) => {
    try {
      const userInfo = activeUsers.get(socket.id);
      if (!userInfo) return;

      const targetUser = findUserByUsername(targetUsername);
      if (!targetUser) {
        socket.emit('error', 'User not found');
        return;
      }

      // Create private room name (sorted usernames to ensure consistency)
      const roomName = [userInfo.username, targetUsername].sort().join('-private-');

      // Leave current room
      if (userInfo.currentRoom) {
        socket.leave(userInfo.currentRoom);
      }

      // Join private room
      socket.join(roomName);
      userInfo.currentRoom = roomName;

      // If target user is online, make them join too
      if (targetUser.isOnline && targetUser.socketId) {
        const targetSocket = io.sockets.sockets.get(targetUser.socketId);
        if (targetSocket) {
          targetSocket.join(roomName);
          const targetUserInfo = activeUsers.get(targetUser.socketId);
          if (targetUserInfo) {
            targetUserInfo.currentRoom = roomName;
          }
        }
      }

      // Get recent private messages
      const privateMessages = findMessagesByRoom(roomName);

      socket.emit('private-chat-started', {
        roomName,
        targetUser: targetUsername,
        messages: privateMessages
      });

      console.log(`Private chat started between ${userInfo.username} and ${targetUsername}`);
    } catch (error) {
      console.error('Error starting private chat:', error);
      socket.emit('error', 'Failed to start private chat');
    }
  });

  // Handle sending messages
  socket.on('send-message', async (messageData) => {
    try {
      const userInfo = activeUsers.get(socket.id);
      if (!userInfo || !userInfo.currentRoom) return;

      // Create message
      const message = {
        _id: messageIdCounter++,
        content: messageData.content,
        senderId: userInfo.userId,
        room: userInfo.currentRoom,
        timestamp: new Date()
      };

      messages.push(message);

      // Send message to room
      io.to(userInfo.currentRoom).emit('new-message', {
        _id: message._id,
        content: message.content,
        sender: {
          _id: userInfo.userId,
          username: userInfo.username
        },
        timestamp: message.timestamp,
        room: message.room
      });

      console.log(`Message sent in ${userInfo.currentRoom} by ${userInfo.username}`);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    const userInfo = activeUsers.get(socket.id);
    if (userInfo && userInfo.currentRoom) {
      socket.to(userInfo.currentRoom).emit('user-typing', {
        username: userInfo.username,
        isTyping: data.isTyping
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    try {
      const userInfo = activeUsers.get(socket.id);
      if (userInfo) {
        // Update user status
        const user = users.get(userInfo.userId);
        if (user) {
          user.isOnline = false;
          user.socketId = null;
        }

        // Remove from active users
        activeUsers.delete(socket.id);

        // Broadcast updated user list
        const onlineUsers = findOnlineUsers();
        io.emit('users-update', onlineUsers);

        console.log(`User ${userInfo.username} disconnected`);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log('Chat app is ready! No database setup required.');
});