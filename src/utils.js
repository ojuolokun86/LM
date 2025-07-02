import axios from 'axios';
import fs from 'fs';
import { getServerStatus } from './services/healthMonitor.js';
import { authIdToClient } from './app.js';

const botServers = JSON.parse(fs.readFileSync(new URL('./config/botServers.json', import.meta.url), 'utf-8'));

export async function fetchUserBotInfo(authId) {
  const status = await getServerStatus();
  const healthyServers = botServers.filter(server => status[server.id]?.healthy);

  // Fetch bots from all healthy servers
  const results = await Promise.all(
    healthyServers.map(async server => {
      try {
        const { data } = await axios.get(`${server.url}/api/admin/bots`);
        return data.bots || [];
      } catch {
        return [];
      }
    })
  );

  // Flatten, filter for this user
  const allBots = results.flat().filter(bot => bot.authId === authId);
  return allBots;
}

export function forwardQrToClient(qrPayload) {
  const { authId, phoneNumber, qr } = qrPayload || {};
  console.log(`[UTILS] QR event received: authId=${authId}, phone=${phoneNumber}, qr=${!!qr}`);
  if (!authId) return;
  const client = authIdToClient.get(authId);
  if (client) {
    client.emit('qr', qrPayload);
    console.log(`[UTILS] Forwarded QR to ${client.id} for authId: ${authId}, phone: ${phoneNumber}`);
  } else {
    console.log(`[UTILS] No connected client for authId: ${authId}`);
  }
}