import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from "socket.io";
import { io as backendIO } from "socket.io-client";
import fs from "fs";
import supabase from './services/supabaseClient.js';
import { forwardQrToClient, fetchUserBotInfo } from './utils.js';

console.log("[LM] App.js loaded...");

const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:3000",
  "https://techitoon.netlify.app"
];

const app = express();

app.set('trust proxy', true); // 👈 Ensure correct IP forwarding behind proxies

// ✅ FIRST: Allow all preflight OPTIONS
app.options('*', (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res.sendStatus(200);
});

// ✅ THEN: Use custom middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  next();
});

// ✅ Now apply standard CORS
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

import apiRouter from './routes/api.js';
app.use('/api', apiRouter);

app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const server = createServer(app);
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Load Manager running on port ${PORT}`);
});

// ✅ SOCKET.IO setup with CORS
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// ✅ WebSocket upgrade log
server.on('upgrade', (req, socket, head) => {
  console.log('Upgrading to WebSocket...');
});

// 🔌 SOCKET.IO EVENT HANDLERS
export const authIdToClient = new Map();
export const authIdToBackendSocket = new Map();

const botServers = JSON.parse(fs.readFileSync(new URL('./config/botServers.json', import.meta.url), 'utf-8'));

async function getBackendUrl(data) {
  const phoneNumber = data?.phoneNumber;
  const authId = data?.authId;

  if (phoneNumber) {
    const { data: session } = await supabase
      .from('sessions')
      .select('server_id')
      .eq('phoneNumber', phoneNumber)
      .single();
    if (session?.server_id) {
      const server = botServers.find(s => s.id === session.server_id);
      if (server) return server.url;
    }
  }

  if (authId) {
    const { data: session } = await supabase
      .from('sessions')
      .select('server_id')
      .eq('authId', authId)
      .limit(1)
      .single();
    if (session?.server_id) {
      const server = botServers.find(s => s.id === session.server_id);
      if (server) return server.url;
    }
  }

  return botServers[0].url;
}

io.on('connection', (client) => {
  let backendSocket = null;
  let userAuthId = null;

  client.on('authId', async (authId) => {
    userAuthId = authId;
    authIdToClient.set(authId, client);
    console.log(`🔗 Client connected with authId: ${authId}`);
    const bots = await fetchUserBotInfo(authId);
    client.emit('bot-info', { bots });
  });

  client.on('get-bot-info', async () => {
    if (!client.userAuthId) return;
    const bots = await fetchUserBotInfo(client.userAuthId);
    client.emit('bot-info', { bots });
  });

  client.onAny(async (event, ...args) => {
    if (!backendSocket) {
      const backendUrl = await getBackendUrl(args[0]);
      backendSocket = backendIO(backendUrl, {
        transports: ['polling', 'websocket'],
        withCredentials: true
      });
      authIdToBackendSocket.set(client.id, backendSocket);

      backendSocket.on('connect', () => {
        console.log(`✅ Connected to backend bot for client ${client.id}`);
        if (userAuthId) backendSocket.emit('authId', userAuthId);
      });

      backendSocket.onAny((backendEvent, ...backendArgs) => {
        if (backendEvent === 'qr') {
          forwardQrToClient(backendArgs[0]);
        } else {
          client.emit(backendEvent, ...backendArgs);
        }
      });

      backendSocket.on('disconnect', () => {
        console.log(`⚠️ Backend bot disconnected for client ${client.id}`);
      });
    }

    if (backendSocket?.connected) {
      backendSocket.emit(event, ...args);
    }
  });

  client.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${client.id}`);
    if (backendSocket) {
      backendSocket.disconnect();
      authIdToBackendSocket.delete(client.id);
    }
    if (userAuthId) authIdToClient.delete(userAuthId);
  });
});

// ✅ /bot-server namespace for backend bots
const botNamespace = io.of('/bot-server');

botNamespace.on('connection', (socket) => {
  console.log(`🤖 Bot server connected: ${socket.id}`);

  socket.on('qr', (qrPayload) => {
    forwardQrToClient(qrPayload);
    console.log(`📲 Forwarded QR from bot:`, qrPayload);
  });

  // More handlers can go here
});
