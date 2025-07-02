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
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

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
    if (session && session.server_id) {
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
    if (session && session.server_id) {
      const server = botServers.find(s => s.id === session.server_id);
      if (server) return server.url;
    }
  }

  return botServers[0].url;
}
import apiRouter from './routes/api.js';
console.log(`[LM] Bot servers loaded: ${apiRouter} servers`);
app.use(express.json());
app.set('trust proxy', true);
console.log(`[LM] Trust proxy set to true`);
app.use('/api', apiRouter);

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
  console.log(`[LM] Ping received`);
});



app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  console.log('Upgrading to WebSocket...');
});

const PORT = process.env.PORT || 3000
console.log("PORT:", process.env.PORT);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀Load Manager running on port ${PORT}`);
});



const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  }
});

// Maps for tracking clients and backend sockets
export const authIdToClient = new Map();
export const authIdToBackendSocket = new Map();

io.on('connection', (client) => {
  let backendSocket = null;
  let userAuthId = null;

  client.on('authId', async (authId) => {
    userAuthId = authId;
    authIdToClient.set(authId, client);
    console.log(`🔗 [LoadManager] Client connected with authId: ${authId}`);

    // Always send bot info from all healthy servers
    const bots = await fetchUserBotInfo(authId);
    client.emit('bot-info', { bots });
  });

  client.on('get-bot-info', async () => {
    if (!client.userAuthId) return;
    const bots = await fetchUserBotInfo(client.userAuthId);
    client.emit('bot-info', { bots });
  });

  client.onAny(async (event, ...args) => {
    // Only create backend socket once per client
    if (!backendSocket) {
      const backendUrl = await getBackendUrl(args[0]);
      backendSocket = backendIO(backendUrl, { transports: ['polling', 'websocket'] });
      authIdToBackendSocket.set(client.id, backendSocket);

      backendSocket.on('connect', () => {
        console.log(`[Proxy] Connected to backend bot server for client ${client.id}`);
        if (userAuthId) backendSocket.emit('authId', userAuthId);
      });

      backendSocket.onAny((backendEvent, ...backendArgs) => {
        //console.log(`[DEBUG] backendSocket event: ${backendEvent}`, backendArgs[0]);
        if (backendEvent === 'qr') {
          forwardQrToClient(backendArgs[0]);
        } else {
          client.emit(backendEvent, ...backendArgs);
        }
      });

      backendSocket.on('disconnect', () => {
        console.log(`[Proxy] Backend bot server disconnected for client ${client.id}`);
      });
    }

    if (backendSocket && backendSocket.connected) {
      backendSocket.emit(event, ...args);
    }
  });

  client.on('disconnect', () => {
    console.log('❌ [LoadManager] Socket.IO client disconnected:', client.id);
    if (backendSocket) {
      backendSocket.disconnect();
      authIdToBackendSocket.delete(client.id);
    }
    if (userAuthId) authIdToClient.delete(userAuthId);
  });
});

// Namespace for bot servers to connect to LM
const botNamespace = io.of('/bot-server');

botNamespace.on('connection', (socket) => {
  console.log(`[LM] Bot server connected: ${socket.id}`);

  socket.on('qr', (qrPayload) => {
    // Forward QR to the correct frontend client
    forwardQrToClient(qrPayload);
    console.log(`[LM] QR received from bot server and forwarded:`, qrPayload);
  });

  // You can add more event handlers as needed (e.g., status, metrics, etc.)
});